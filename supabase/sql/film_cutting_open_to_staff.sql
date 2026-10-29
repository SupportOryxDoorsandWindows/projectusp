-- Film Cutting for ALL active staff (user's request 2026-10-29, "Open to
-- all staff"), run after supabase/sql/film_cutting.sql.
--
-- Changes ONE thing: the single access rule film_cut_access(), which both
-- read policies and approve_film_cut_plan() / log_film_cut() ask. Before:
-- is_admin(); now: is_active_staff() (signed in, account switched on).
-- Switched-off accounts and anonymous visitors still get nothing; nothing
-- else (tables, functions, stock) changes.
--
-- Go back to Admins only: run supabase/sql/film_cutting.sql's definition
-- again, i.e.
--   create or replace function public.film_cut_access()
--   returns boolean language sql stable security definer set search_path = '' as $$
--     select (select public.is_admin());
--   $$;
create or replace function public.film_cut_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select public.is_active_staff());
$$;
