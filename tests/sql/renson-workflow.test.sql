-- Database rules of supabase/sql/renson_workflow.sql, on a LOCAL Postgres
-- (never the live project). Run after renson-pilot.test.sql and
-- renson-checkout.test.sql (state then: 22874 qty 10 cost 153; 17710 qty
-- 17.5 no cost; D6110097 qty -3 no cost):
--   psql -d <same db> -f supabase/sql/renson_workflow.sql
--   psql -d <same db> -f tests/sql/renson-workflow.test.sql
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set IN '''{"supplier":"Renson","invoice_number":"INV-1","document_date":"2026-11-01","currency":"EUR","exchange_rate":4,"document_hash":"bbbb000000000000000000000000000000000000000000000000000000000001","lines":[{"item_code":"22874","qty":10,"original_unit_cost":40,"shipping_allocated":20},{"item_code":"17710","qty":5,"original_unit_cost":null},{"item_code":"d6110097","qty":5,"original_unit_cost":2.5},{"item_code":"NEW-1","qty":3,"original_unit_cost":10,"new_item":{"description":"New Renson part","unit":"pc"}}]}'''
create temp table stock_before as select count(*) n, coalesce(sum(quantity), 0) q from public.inventory_transactions;
create temp table items_before as select md5(string_agg(t::text, '|' order by id)) h from public.inventory_items t;

-- Staff: refused everywhere
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('1 staff checks in', format('select public.renson_checkin(%L::jsonb)', :IN));
select pg_temp.try('1b staff adjusts', $q$select public.renson_adjust('{"item_code":"22874","mode":"set_to","qty":1,"reason":"x"}')$q$);
select pg_temp.try('1c staff sets levels', $q$select public.renson_set_levels('22874', 5, 2)$q$);

reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
-- Check-in: bad requests refused whole
select pg_temp.try('2a no supplier', $q$select public.renson_checkin('{"supplier":" ","currency":"AED","lines":[{"item_code":"22874","qty":1}]}')$q$);
select pg_temp.try('2b EUR without a rate', $q$select public.renson_checkin('{"supplier":"R","currency":"EUR","lines":[{"item_code":"22874","qty":1}]}')$q$);
select pg_temp.try('2c unknown code, no new item', $q$select public.renson_checkin('{"supplier":"R","currency":"AED","lines":[{"item_code":"910010","qty":1}]}')$q$);
select pg_temp.try('2d new item for an existing code', $q$select public.renson_checkin('{"supplier":"R","currency":"AED","lines":[{"item_code":"22874","qty":1,"new_item":{"description":"x"}}]}')$q$);
select pg_temp.try('2e negative price', $q$select public.renson_checkin('{"supplier":"R","currency":"AED","lines":[{"item_code":"22874","qty":1,"original_unit_cost":-1}]}')$q$);
insert into r select '2f nothing changed', string_agg(item_code || '=' || current_qty || '@' || coalesce(unit_cost::text, '-'), ' ' order by id) from public.renson_items;

-- Check-in (EUR x 4, shipping 20 on the 22874 line)
insert into r select '3 admin checks in', public.renson_checkin(:IN)::text;
-- 22874: price paid = (40 + 20/10) x 4 = 168; average (10 x 153 + 10 x 168) / 20 = 160.5
-- 17710: no price -> its own cost (none) stays; D6110097: stock -3 -> price paid 10
insert into r select '3b stock and cost after', string_agg(item_code || '=' || current_qty || '@' || coalesce(trim_scale(unit_cost)::text, '-') || ' value ' || current_value, '; ' order by id) from public.renson_items;
insert into r select '3c lines', string_agg(item_code || ' ' || quantity || ' ' || original_currency || ' ' || coalesce(trim_scale(original_unit_cost)::text, '-') || ' -> AED ' || coalesce(trim_scale(unit_cost)::text, '-') || ' avg ' || coalesce(trim_scale(unit_cost_before)::text, '-') || '->' || coalesce(trim_scale(unit_cost_after)::text, '-') || case when is_new_item then ' NEW' else '' end, '; ' order by id)
  from public.renson_transactions where type = 'check_in';
select pg_temp.try('3d same document again', format('select public.renson_checkin(%L::jsonb)', :IN));

-- Adjust
insert into r select '4 stock count 22874 -> 18', public.renson_adjust('{"item_code":"22874","mode":"set_to","qty":18,"reason":"Count 2 Nov"}')::text;
insert into r select '4b add 2 at AED 100', public.renson_adjust('{"item_code":"22874","mode":"add","qty":2,"unit_cost":100,"reason":"Found"}')::text;
insert into r select '4c take out 1', public.renson_adjust('{"item_code":"22874","mode":"take_out","qty":1,"reason":"Damaged"}')::text;
insert into r select '4d 22874 now', current_qty || '@' || trim_scale(unit_cost) from public.renson_items where item_code = '22874';
insert into r select '4e adjustment lines', string_agg(quantity || ' ' || reference || ' (' || reason || ')', '; ' order by id) from public.renson_transactions where type = 'adjustment';
select pg_temp.try('4f no reason', $q$select public.renson_adjust('{"item_code":"22874","mode":"take_out","qty":1,"reason":" "}')$q$);
select pg_temp.try('4g count = same stock', $q$select public.renson_adjust('{"item_code":"22874","mode":"set_to","qty":19,"reason":"x"}')$q$);
select pg_temp.try('4h cost on a take-out', $q$select public.renson_adjust('{"item_code":"22874","mode":"take_out","qty":1,"unit_cost":5,"reason":"x"}')$q$);

-- Kanban levels
insert into r select '5 set levels 10 / 4', public.renson_set_levels('22874', 10, 4)::text;
select pg_temp.try('5b critical without trigger', $q$select public.renson_set_levels('22874', null, 4)$q$);
select pg_temp.try('5c critical >= trigger', $q$select public.renson_set_levels('22874', 4, 4)$q$);
insert into r select '5d remove both (0 = none)', public.renson_set_levels('22874', 0, 0)::text;

-- Check-out typed by hand (no document) twice is fine; with a document, once
insert into r select '6 hand Check-out', (public.renson_checkout('{"job_number":"J-1","lines":[{"item_code":"22874","qty":1}]}') - 'total_value')::text;
insert into r select '6b again by hand', (public.renson_checkout('{"job_number":"J-1","lines":[{"item_code":"22874","qty":1}]}') - 'total_value')::text;

-- Flag off: refused
reset role; update public.app_feature_flags set enabled = false where key = 'renson_pilot';
select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('7 flag off: check-in', $q$select public.renson_checkin('{"supplier":"R","currency":"AED","lines":[{"item_code":"22874","qty":1}]}')$q$);
select pg_temp.try('7b flag off: adjust', $q$select public.renson_adjust('{"item_code":"22874","mode":"add","qty":1,"reason":"x"}')$q$);
reset role; update public.app_feature_flags set enabled = true where key = 'renson_pilot';

insert into r select '8 Freedom stock and items unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before)
  and (select coalesce(sum(quantity), 0) from public.inventory_transactions) = (select q from stock_before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) is not distinct from (select h from items_before))::text;
select k, v from r;
