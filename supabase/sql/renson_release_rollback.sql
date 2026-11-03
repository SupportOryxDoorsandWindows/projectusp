-- Undo supabase/sql/renson_release.sql: Renson back to Admins only (the
-- pilot rule). Data is kept. The extra Admin check on renson_set_levels /
-- renson_import_stock / renson_reset_pilot can stay (harmless: Admins only).
create or replace function public.renson_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
     and coalesce((select enabled from public.app_feature_flags where key = 'renson_pilot'), false);
$$;
-- Then in the browser: boot.js loads renson.js for Admins only again
-- (git history of 2026-11-03).
