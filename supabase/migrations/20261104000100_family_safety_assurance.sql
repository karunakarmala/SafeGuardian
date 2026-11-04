-- SafeGuardian family safety backend migration (already applied to the connected project)
-- Additive migration: retains existing legacy tables and rows.

alter table public.sg_profiles drop constraint if exists sg_profiles_role_check;
alter table public.sg_profiles add constraint sg_profiles_role_check
  check (role = any (array['parent'::text,'adult'::text,'child'::text]));

create or replace function public.sg_handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.sg_profiles (user_id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', ''),
    case when new.raw_user_meta_data ->> 'role' = 'parent' then 'parent' else 'adult' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.sg_handle_new_user() from public, anon, authenticated;

alter table public.sg_profiles add column if not exists location_sharing_enabled boolean not null default false;

create table if not exists public.sg_family_links (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references auth.users(id) on delete cascade,
  adult_email text not null,
  adult_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint sg_family_links_unique unique (parent_id, adult_email)
);
create index if not exists sg_family_links_parent_idx on public.sg_family_links(parent_id);
create index if not exists sg_family_links_adult_idx on public.sg_family_links(adult_id);
alter table public.sg_family_links enable row level security;
grant select, insert, update, delete on public.sg_family_links to authenticated;

create table if not exists public.sg_safety_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  destination text not null,
  expected_at timestamptz not null,
  note text not null default '',
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','cancelled')),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sg_safety_plans_owner_expected_idx on public.sg_safety_plans(owner_id, expected_at desc);
alter table public.sg_safety_plans enable row level security;
grant select, insert, update, delete on public.sg_safety_plans to authenticated;

create table if not exists public.sg_safety_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references public.sg_safety_plans(id) on delete set null,
  event_type text not null check (event_type in ('check_in','overdue','sos','plan_created')),
  title text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists sg_safety_events_owner_created_idx on public.sg_safety_events(owner_id, created_at desc);
alter table public.sg_safety_events enable row level security;
grant select, insert, update, delete on public.sg_safety_events to authenticated;

-- RLS policies: adults own their plans and events; parents only read after adult acceptance.
drop policy if exists "Participants can view family links" on public.sg_family_links;
create policy "Participants can view family links" on public.sg_family_links for select to authenticated
using (parent_id=(select auth.uid()) or adult_id=(select auth.uid()) or lower(adult_email)=lower((select auth.jwt()->>'email')));

drop policy if exists "Parents can invite adult contacts" on public.sg_family_links;
create policy "Parents can invite adult contacts" on public.sg_family_links for insert to authenticated
with check (parent_id=(select auth.uid()) and adult_id is null and status='pending'
  and lower(adult_email)<>lower((select auth.jwt()->>'email'))
  and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='parent'));

drop policy if exists "Invited adults can accept link" on public.sg_family_links;
create policy "Invited adults can accept link" on public.sg_family_links for update to authenticated
using (adult_id is null and status='pending' and lower(adult_email)=lower((select auth.jwt()->>'email'))
  and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'))
with check (adult_id=(select auth.uid()) and status='accepted' and lower(adult_email)=lower((select auth.jwt()->>'email'))
  and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Parents can revoke own invitations" on public.sg_family_links;
create policy "Parents can revoke own invitations" on public.sg_family_links for delete to authenticated using(parent_id=(select auth.uid()));

drop policy if exists "Adults and linked parents can read plans" on public.sg_safety_plans;
create policy "Adults and linked parents can read plans" on public.sg_safety_plans for select to authenticated
using (owner_id=(select auth.uid()) or exists(select 1 from public.sg_family_links l
  where l.adult_id=sg_safety_plans.owner_id and l.parent_id=(select auth.uid()) and l.status='accepted'));

drop policy if exists "Adults create own plans" on public.sg_safety_plans;
create policy "Adults create own plans" on public.sg_safety_plans for insert to authenticated
with check(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Adults update own plans" on public.sg_safety_plans;
create policy "Adults update own plans" on public.sg_safety_plans for update to authenticated
using(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'))
with check(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Adults delete own plans" on public.sg_safety_plans;
create policy "Adults delete own plans" on public.sg_safety_plans for delete to authenticated
using(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Adults and linked parents can read events" on public.sg_safety_events;
create policy "Adults and linked parents can read events" on public.sg_safety_events for select to authenticated
using(owner_id=(select auth.uid()) or exists(select 1 from public.sg_family_links l
  where l.adult_id=sg_safety_events.owner_id and l.parent_id=(select auth.uid()) and l.status='accepted'));

drop policy if exists "Adults create own events" on public.sg_safety_events;
create policy "Adults create own events" on public.sg_safety_events for insert to authenticated
with check(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Adults update own events" on public.sg_safety_events;
create policy "Adults update own events" on public.sg_safety_events for update to authenticated
using(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'))
with check(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Adults delete own events" on public.sg_safety_events;
create policy "Adults delete own events" on public.sg_safety_events for delete to authenticated
using(owner_id=(select auth.uid()) and exists(select 1 from public.sg_profiles p where p.user_id=(select auth.uid()) and p.role='adult'));

drop policy if exists "Linked family members can read profiles" on public.sg_profiles;
create policy "Linked family members can read profiles" on public.sg_profiles for select to authenticated
using(user_id=(select auth.uid()) or exists(select 1 from public.sg_family_links l where l.status='accepted'
  and ((l.parent_id=(select auth.uid()) and l.adult_id=sg_profiles.user_id)
    or (l.adult_id=(select auth.uid()) and l.parent_id=sg_profiles.user_id))));

create or replace function public.sg_prevent_profile_role_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'Profile role cannot be changed from the client.';
  end if;
  return new;
end;
$$;
drop trigger if exists sg_profile_role_immutable on public.sg_profiles;
create trigger sg_profile_role_immutable before update on public.sg_profiles
for each row execute function public.sg_prevent_profile_role_change();
revoke all on function public.sg_prevent_profile_role_change() from public, anon, authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sg_safety_plans') then alter publication supabase_realtime add table public.sg_safety_plans; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sg_safety_events') then alter publication supabase_realtime add table public.sg_safety_events; end if;
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sg_family_links') then alter publication supabase_realtime add table public.sg_family_links; end if;
  end if;
end $$;

-- Background overdue detection. This writes one event per missed plan every minute.
create extension if not exists pg_cron with schema pg_catalog;
create unique index if not exists sg_safety_events_one_overdue_per_plan
on public.sg_safety_events(plan_id) where event_type='overdue';
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname='safeguardian-overdue-checks' loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;
select cron.schedule(
  'safeguardian-overdue-checks',
  '* * * * *',
  $job$
    insert into public.sg_safety_events(owner_id, plan_id, event_type, title, details)
    select p.owner_id, p.id, 'overdue', 'Check-in overdue',
      p.title || ' passed its expected arrival time. Please follow up; this is not proof of an emergency.'
    from public.sg_safety_plans p
    where p.status='scheduled' and p.expected_at < now() - interval '5 minutes'
    on conflict (plan_id) where event_type='overdue' do nothing;
  $job$
);
