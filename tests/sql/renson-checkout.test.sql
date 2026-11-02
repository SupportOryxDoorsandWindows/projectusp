-- Database rules of supabase/sql/renson_checkout.sql, on a LOCAL Postgres
-- (never the live project). Run after tests/sql/renson-pilot.test.sql (which
-- leaves 3 Renson items: 22874 qty 14 cost 153, 17710 qty 20 no cost,
-- D6110097 qty 0):
--   psql -d <same db> -f supabase/sql/renson_checkout.sql
--   psql -d <same db> -f tests/sql/renson-checkout.test.sql
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set H '"aaaa000000000000000000000000000000000000000000000000000000000002"'
\set OUT '''{"job_number":"24222R","document_name":"24222-Paolo OPT LIST.pdf","document_hash":"aaaa000000000000000000000000000000000000000000000000000000000002","lines":[{"item_code":"22874","qty":4,"unit":"bar","source":"2 x 6000 Pair = 4 bars"},{"item_code":"17710","qty":2.5,"unit":"m"},{"item_code":"d6110097","qty":3,"unit":"pc"}]}'''
create temp table stock_before as select count(*) n, coalesce(sum(quantity), 0) q from public.inventory_transactions;
create temp table items_before as select md5(string_agg(t::text, '|' order by id)) h from public.inventory_items t;

-- Staff: refused
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('1 staff checks out', format('select public.renson_checkout(%L::jsonb)', :OUT));

-- Admin: bad requests refused whole
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('2a no job number', format('select public.renson_checkout(%L::jsonb)', '{"job_number":" ","document_hash":' || :'H' || ',"lines":[{"item_code":"22874","qty":1}]}'));
select pg_temp.try('2b not a Renson item (Freedom 910010)', format('select public.renson_checkout(%L::jsonb)', '{"job_number":"X","document_hash":' || :'H' || ',"lines":[{"item_code":"22874","qty":1},{"item_code":"910010","qty":12.78}]}'));
select pg_temp.try('2c zero qty', format('select public.renson_checkout(%L::jsonb)', '{"job_number":"X","document_hash":' || :'H' || ',"lines":[{"item_code":"22874","qty":0}]}'));
select pg_temp.try('2d same code twice', format('select public.renson_checkout(%L::jsonb)', '{"job_number":"X","document_hash":' || :'H' || ',"lines":[{"item_code":"22874","qty":1},{"item_code":"22874 ","qty":1}]}'));
select pg_temp.try('2e bad hash', format('select public.renson_checkout(%L::jsonb)', '{"job_number":"X","document_hash":"x","lines":[{"item_code":"22874","qty":1}]}'));
insert into r select '2f nothing changed by refused requests', string_agg(item_code || '=' || current_qty, ' ' order by id) from public.renson_items;

-- Admin: the Check-out (one item goes below zero: allowed)
insert into r select '3 admin checks out', public.renson_checkout(:OUT)::text;
insert into r select '3b stock after', string_agg(item_code || '=' || current_qty || ' value ' || current_value, '; ' order by id) from public.renson_items;
insert into r select '3c lines', string_agg(item_code || ' ' || type || ' ' || quantity || ' ' || coalesce(unit, '') || ' ' || qty_before || '->' || qty_after || ' value ' || coalesce(value::text, '-') || ' job ' || job_number || ' by ' || performed_by_name, '; ' order by id)
  from public.renson_transactions where type = 'check_out';
select pg_temp.try('4 same job list again', format('select public.renson_checkout(%L::jsonb)', :OUT));
select pg_temp.try('4b admin writes stock directly', $q$update public.renson_items set current_qty = 0 where true$q$);

-- Flag off: refused even for the Admin
reset role; update public.app_feature_flags set enabled = false where key = 'renson_pilot';
select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('5 flag off: admin checks out', format('select public.renson_checkout(%L::jsonb)', replace(:OUT, '0002', '0003')));
reset role; update public.app_feature_flags set enabled = true where key = 'renson_pilot';

insert into r select '6 Freedom stock and items unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before)
  and (select coalesce(sum(quantity), 0) from public.inventory_transactions) = (select q from stock_before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) is not distinct from (select h from items_before))::text;
select k, v from r;
