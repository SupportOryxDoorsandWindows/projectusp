-- User Management "Last active" column (approved UI proposal, page 12).
-- Applied to the live project as migration "admin_user_last_active".
-- Last sign-in time lives in auth.users, which the site can't read; this
-- returns it to active Admins only (anyone else gets no rows). Read-only.
create or replace function public.admin_user_last_active()
returns table (user_id uuid, last_sign_in_at timestamptz)
language sql
stable
security definer
set search_path to ''
as $$
  select u.id, u.last_sign_in_at
  from auth.users u
  where public.is_admin();
$$;
revoke all on function public.admin_user_last_active() from public, anon;
grant execute on function public.admin_user_last_active() to authenticated;
