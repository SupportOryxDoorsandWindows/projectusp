-- Removes the Renson Admin-only pilot completely (supabase/sql/renson_pilot.sql).
-- Run in the Supabase SQL Editor. Touches ONLY the Renson objects and the
-- feature-flag table that pilot created; the Freedom inventory is not affected.
-- Deletes the Renson pilot data (items, imports, transactions) for good.
-- To only switch the pilot off (keep its data), use instead:
--   update public.app_feature_flags set enabled = false, updated_at = now() where key = 'renson_pilot';
drop function if exists public.renson_checkout(jsonb);
drop function if exists public.renson_reset_pilot(text);
drop function if exists public.renson_import_stock(jsonb);
drop table if exists public.renson_transactions;
drop table if exists public.renson_items;
drop table if exists public.renson_imports;
drop function if exists public.renson_access();
drop table if exists public.app_feature_flags;
