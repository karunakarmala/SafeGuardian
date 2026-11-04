-- Applied to the connected SafeGuardian Supabase project.
-- Clients cannot create profiles and self-assign a role.
drop policy if exists "Users can create own profile" on public.sg_profiles;
revoke insert on public.sg_profiles from authenticated;

-- Invited adults can only update the fields required to accept a family link.
-- This prevents changing parent_id or adult_email while accepting an invitation.
revoke update on public.sg_family_links from authenticated;
grant update (adult_id, status, accepted_at) on public.sg_family_links to authenticated;
