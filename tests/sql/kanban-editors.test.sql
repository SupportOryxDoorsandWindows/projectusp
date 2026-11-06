-- Database rules of supabase/sql/kanban_editors.sql, on a LOCAL Postgres
-- (never the live project). Run after renson-release.test.sql (same db,
-- chain: supabase-base, inventory-base, item_minimum_level, item_kanban_levels,
-- renson_pilot + test, renson_checkout + test, renson_workflow + test,
-- renson_release + test), with the live columns / table the stand-ins lack:
--   psql -d <db> -c "alter table public.user_profiles add column if not exists updated_at timestamptz, add column if not exists updated_by uuid;
--     create table if not exists public.account_activity_log (id bigint generated always as identity primary key, happened_at timestamptz not null default now(),
--     actor_id uuid, actor_name text, actor_email text, action text not null, target_email text, target_name text, detail jsonb);"
--   psql -d <same db> -f supabase/sql/kanban_editors.sql   (twice: re-run safe)
--   psql -d <same db> -f tests/sql/kanban-editors.test.sql
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 60)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S2 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
insert into public.inventory_items (item_code, description, unit_of_measure, unit_cost, current_qty, current_value)
  values ('KB-TEST-1', 'Kanban test item (local only)', 'pcs', 2.5, 40, 100);
create temp table item as select id from public.inventory_items where item_code = 'KB-TEST-1';
grant select on item to authenticated;
create temp table before as select md5(string_agg(concat_ws('|', id, current_qty, unit_cost, current_value), ';' order by id)) h from public.inventory_items;

-- 1. Staff One before: not a Kanban editor, both refused
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '1a staff: can_edit_kanban()', public.can_edit_kanban()::text;
insert into r select '1b staff: Freedom levels', public.set_item_kanban_levels((select id from item), 30, 10)->>'error';
select pg_temp.try('1c staff: Renson levels', $$select public.renson_set_levels('22874', 30, 10)$$);
-- staff can't give it to themselves
insert into r select '1d staff: admin_set_kanban_editor', public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000001', true)->>'error';
select pg_temp.try('1e staff: write own profile', $$update public.user_profiles set can_edit_kanban = true where user_id = auth.uid()$$);

-- 2. Admin switches it on for Staff One (logged), not for Staff Two
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '2a admin: on for S1', (public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000001', true)->>'changed');
insert into r select '2b admin: again = no change', (public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000001', true)->>'changed');
insert into r select '2c admin: unknown user', public.admin_set_kanban_editor('dddddddd-0000-0000-0000-000000000001', true)->>'error';
insert into r select '2d admin: can_edit_kanban()', public.can_edit_kanban()::text;
reset role;
insert into r select '2e log', string_agg(concat_ws(' ', actor_name, action, target_name, detail->>'can_edit_kanban'), '; ') from public.account_activity_log;

-- 3. Staff One now: Freedom + Renson levels allowed, logged with the name
select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '3a S1: can_edit_kanban()', public.can_edit_kanban()::text;
insert into r select '3b S1: Freedom levels', concat_ws(' ', x->>'ok', x->>'changed', x->>'set_by_name') from (select public.set_item_kanban_levels((select id from item), 30, 10) x) q;
insert into r select '3c S1: Freedom rules still apply', public.set_item_kanban_levels((select id from item), 10, 30)->>'error';
insert into r select '3d S1: Renson levels', public.renson_set_levels('22874', 30, 10)::text;
insert into r select '3e S1: still not an Admin', public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000002', true)->>'error';
reset role;
insert into r select '3f Freedom item + log', concat_ws(' ', i.buffer_level, i.critical_level, '|', (select string_agg(level_kind || ':' || new_level || ':' || set_by_name, ',' order by level_kind) from public.item_minimum_log l where l.item_id = i.id))
  from public.inventory_items i where id = (select id from item);
insert into r select '3g Renson item', concat_ws(' ', buffer_level, critical_level, levels_updated_by_name) from public.renson_items where item_code = '22874';
insert into r select '3h stock / cost / value unchanged', ((select md5(string_agg(concat_ws('|', id, current_qty, unit_cost, current_value), ';' order by id)) from public.inventory_items) = (select h from before))::text;

-- 4. Staff Two (not given) still refused; switched-off account refused even with the flag
select set_config('request.jwt.claims', :S2, false); set role authenticated;
insert into r select '4a S2: Freedom levels', public.set_item_kanban_levels((select id from item), 40, null)->>'error';
reset role;
update public.user_profiles set can_edit_kanban = true where user_id = 'cccccccc-0000-0000-0000-000000000001';
select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '4b switched off: can_edit_kanban()', public.can_edit_kanban()::text;
reset role;
update public.user_profiles set can_edit_kanban = false where user_id = 'cccccccc-0000-0000-0000-000000000001';

-- 5. Admin switches it off again: refused again
select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '5a admin: off for S1', public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000001', false)->>'changed';
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '5b S1 after off: Freedom', public.set_item_kanban_levels((select id from item), 50, null)->>'error';
select pg_temp.try('5c S1 after off: Renson', $$select public.renson_set_levels('22874', 50, null)$$);

-- 6. anon can't call any of it
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('6a anon: can_edit_kanban', $$select public.can_edit_kanban()$$);
select pg_temp.try('6b anon: admin_set_kanban_editor', $$select public.admin_set_kanban_editor('bbbbbbbb-0000-0000-0000-000000000001', true)$$);
reset role;

select k, v from r order by k;
