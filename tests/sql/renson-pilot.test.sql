-- Database rules of supabase/sql/renson_pilot.sql, on a LOCAL Postgres
-- (never the live project). Run:
--   psql -d <empty db> -f tests/sql/supabase-base.sql
--   psql -d <same db> -f tests/sql/inventory-base.sql
--   psql -d <same db> -f supabase/sql/renson_pilot.sql
--   psql -d <same db> -f tests/sql/renson-pilot.test.sql
--   (then renson_pilot_rollback.sql must leave nothing behind)
-- Every row printed at the end must read as expected ("refused" where a
-- person must not be able to do it).
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
\set H '''aaaa000000000000000000000000000000000000000000000000000000000001'''
\set IMP '''{"file_name":"RENSON STOCK OCT 27.xlsx","file_hash":"aaaa000000000000000000000000000000000000000000000000000000000001","sheet":"STOCK","sheet_total":2142,"items":[{"item_code":"22874","description":"Bar Ø 18 mm - 6.15 m STEEL (P6027110)","unit":"bar","qty":14,"unit_cost":153,"source_row":10},{"item_code":"17710","alt_codes":"G6009844","description":"Blue tape 55 mm","qty":20,"unit_cost":null,"source_row":11},{"item_code":"D6110097","description":"Sergé SC0140","qty":0,"source_row":3}]}'''
create temp table stock_before as select count(*) n, coalesce(sum(quantity), 0) q from public.inventory_transactions;
create temp table items_before as select md5(string_agg(t::text, '|' order by id)) h from public.inventory_items t;

-- Staff (not Admin): sees nothing, can do nothing -- before and after the import
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '1 staff: renson_access()', public.renson_access()::text;
select pg_temp.try('1b staff imports', format('select public.renson_import_stock(%L::jsonb)', :IMP));
insert into r select '1c staff reads the flag', count(*)::text from public.app_feature_flags;

-- Admin: bad files are refused whole, then the import
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '2 admin: renson_access()', public.renson_access()::text;
select pg_temp.try('2a duplicate code', format('select public.renson_import_stock(%L::jsonb)', '{"file_name":"x","file_hash":' || to_json(:H::text) || ',"items":[{"item_code":"1","description":"a","qty":1},{"item_code":" 1","description":"b","qty":1}]}'));
select pg_temp.try('2b negative qty', format('select public.renson_import_stock(%L::jsonb)', '{"file_name":"x","file_hash":' || to_json(:H::text) || ',"items":[{"item_code":"1","description":"a","qty":-1}]}'));
select pg_temp.try('2c text qty', format('select public.renson_import_stock(%L::jsonb)', '{"file_name":"x","file_hash":' || to_json(:H::text) || ',"items":[{"item_code":"1","description":"a","qty":"5"}]}'));
select pg_temp.try('2d no description', format('select public.renson_import_stock(%L::jsonb)', '{"file_name":"x","file_hash":' || to_json(:H::text) || ',"items":[{"item_code":"1","description":"","qty":1}]}'));
select pg_temp.try('2e bad hash', format('select public.renson_import_stock(%L::jsonb)', '{"file_name":"x","file_hash":"zz","items":[{"item_code":"1","description":"a","qty":1}]}'));
insert into r select '2f nothing written by refused imports', (select count(*) from public.renson_items)::text || ' items, ' || (select count(*) from public.renson_imports)::text || ' imports';
insert into r select '3 admin imports', public.renson_import_stock(:IMP)::text;
insert into r select '3b items', string_agg(item_code || ' qty ' || current_qty || ' cost ' || coalesce(unit_cost::text, '-') || ' value ' || current_value, '; ' order by id) from public.renson_items;
insert into r select '3c opening lines', string_agg(item_code || ' ' || type || ' ' || quantity || ' by ' || performed_by_name, '; ' order by id) from public.renson_transactions;
insert into r select '3d stock value', sum(current_value)::text from public.renson_items;
select pg_temp.try('4 import a second time', format('select public.renson_import_stock(%L::jsonb)', :IMP));
select pg_temp.try('4b admin edits an item directly', $q$update public.renson_items set current_qty = 99 where true$q$);
select pg_temp.try('4c admin inserts a line directly', $q$insert into public.renson_transactions (item_id, item_code, type, quantity, qty_before, qty_after) values (1, 'x', 'opening_import', 1, 0, 1)$q$);
select pg_temp.try('4d admin switches the flag directly', $q$update public.app_feature_flags set enabled = false where true$q$);
select pg_temp.try('4e reset without the words', $q$select public.renson_reset_pilot('yes')$q$);

-- Staff after the import: still nothing
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '5 staff reads items / imports / lines', (select count(*) from public.renson_items)::text || '/' || (select count(*) from public.renson_imports) || '/' || (select count(*) from public.renson_transactions);
select pg_temp.try('5b staff resets', $q$select public.renson_reset_pilot('RESET RENSON')$q$);
select pg_temp.try('5c staff edits directly', $q$update public.renson_items set current_qty = 1 where true$q$);

-- Switched-off account and anonymous
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '6 switched-off reads items', count(*)::text from public.renson_items;
select pg_temp.try('6b switched-off imports', format('select public.renson_import_stock(%L::jsonb)', :IMP));
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('7 anonymous reads', 'select count(*) from public.renson_items');
select pg_temp.try('7b anonymous imports', format('select public.renson_import_stock(%L::jsonb)', :IMP));

-- Feature flag OFF: even the Admin sees nothing and can do nothing
reset role; update public.app_feature_flags set enabled = false where key = 'renson_pilot';
select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '8 flag off: admin access / items / flag row', public.renson_access()::text || ' / ' || (select count(*) from public.renson_items) || ' / ' || (select enabled from public.app_feature_flags where key = 'renson_pilot');
select pg_temp.try('8b flag off: admin resets', $q$select public.renson_reset_pilot('RESET RENSON')$q$);
reset role; update public.app_feature_flags set enabled = true where key = 'renson_pilot';

-- Admin reset clears only Renson, then the import works again
select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '9 admin resets', public.renson_reset_pilot('RESET RENSON')::text;
insert into r select '9b re-import after reset', (public.renson_import_stock(:IMP) - 'import_id')::text;
reset role;
insert into r select '10 Freedom stock and items unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before)
  and (select coalesce(sum(quantity), 0) from public.inventory_transactions) = (select q from stock_before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) is not distinct from (select h from items_before))::text;
select k, v from r;
