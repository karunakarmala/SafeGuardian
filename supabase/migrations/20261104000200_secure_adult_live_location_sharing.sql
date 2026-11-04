create table if not exists public.sg_live_locations (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m is null or accuracy_m >= 0),
  recorded_at timestamptz not null default now()
);

alter table public.sg_live_locations enable row level security;
grant select, insert, update, delete on public.sg_live_locations to authenticated;

drop policy if exists "Owner and consenting linked parents can view live location" on public.sg_live_locations;
create policy "Owner and consenting linked parents can view live location"
on public.sg_live_locations for select to authenticated
using (
  owner_id = (select auth.uid())
  or exists (
    select 1
    from public.sg_family_links l
    join public.sg_profiles p on p.user_id = l.adult_id
    where l.adult_id = sg_live_locations.owner_id
      and l.parent_id = (select auth.uid())
      and l.status = 'accepted'
      and p.location_sharing_enabled = true
  )
);

drop policy if exists "Adults can publish their own location with consent" on public.sg_live_locations;
create policy "Adults can publish their own location with consent"
on public.sg_live_locations for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.sg_profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'adult'
      and p.location_sharing_enabled = true
  )
);

drop policy if exists "Adults can update their own shared location" on public.sg_live_locations;
create policy "Adults can update their own shared location"
on public.sg_live_locations for update to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.sg_profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'adult'
      and p.location_sharing_enabled = true
  )
)
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.sg_profiles p
    where p.user_id = (select auth.uid())
      and p.role = 'adult'
      and p.location_sharing_enabled = true
  )
);

drop policy if exists "Adults can remove their own live location" on public.sg_live_locations;
create policy "Adults can remove their own live location"
on public.sg_live_locations for delete to authenticated
using (owner_id = (select auth.uid()));

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sg_live_locations') then
    alter publication supabase_realtime add table public.sg_live_locations;
  end if;
end $$;
