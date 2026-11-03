-- Renson inventory RELEASED to all active staff (2026-11-03, the owner's
-- personal approval: "for renson make it live now").
-- Before: renson_access() = is_admin() AND flag 'renson_pilot' on.
-- After:  renson_access() = is_active_staff() AND flag on -- the same people
-- who use Freedom. Like Freedom, everyone can see the stock and do Check-in,
-- Check-out and Adjust; Kanban levels stay Admin-only (as Freedom's
-- set_item_kanban_levels), and so do the opening import and the reset.
-- The flag still switches Renson off for everyone. Freedom is not touched.
-- Run after renson_pilot.sql, renson_checkout.sql, renson_workflow.sql.
-- UNDO: supabase/sql/renson_release_rollback.sql (back to Admins only).

-- 1. Admin-only functions: take their LIVE definitions and require an Admin
--    as well (only the access check line changes; nothing else).
do $$
declare
  f text; def text; n int;
  old_check constant text := 'if not public.renson_access() then';
  new_check constant text := 'if not (public.renson_access() and public.is_admin()) then';
begin
  foreach f in array array['public.renson_set_levels(text, numeric, numeric)', 'public.renson_import_stock(jsonb)', 'public.renson_reset_pilot(text)'] loop
    def := pg_get_functiondef(f::regprocedure);
    if position(new_check in def) > 0 then continue; end if;          -- already done
    n := (length(def) - length(replace(def, old_check, ''))) / length(old_check);
    if n <> 1 then raise exception 'renson_release: % has % access checks, expected 1', f, n; end if;
    execute replace(def, old_check, new_check);
  end loop;
end $$;

-- 2. The one rule: every active staff account (while the flag is on).
create or replace function public.renson_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_active_staff()
     and coalesce((select enabled from public.app_feature_flags where key = 'renson_pilot'), false);
$$;
