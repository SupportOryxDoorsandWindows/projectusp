-- Weighted average cost (supabase/sql/checkin_weighted_average.sql), on a
-- LOCAL Postgres (never the live project). Run, on an empty database:
--   psql -f tests/sql/supabase-base.sql
--   psql -f tests/sql/inventory-base.sql
--   psql -f supabase/sql/checkin_weighted_average.sql
--   psql -f tests/sql/checkin-weighted-average.test.sql
-- Prints one row per case; every "ok" column must be true.
\set ON_ERROR_STOP 1
insert into inventory_items (id, item_code, description, unit_of_measure, unit_cost, current_qty, current_value) values
 ('00000000-0000-0000-0000-00000000000a', 'A', 'Average me', 'pcs', 1, 100, 100),
 ('00000000-0000-0000-0000-00000000000b', 'B', 'No stock', 'pcs', 5, 0, 0),
 ('00000000-0000-0000-0000-00000000000c', 'C', 'Below zero', 'pcs', 5, -4, -20),
 ('00000000-0000-0000-0000-00000000000d', 'D', 'No document price', 'pcs', 3, 10, 30),
 ('00000000-0000-0000-0000-00000000000e', 'E', 'No cost on file', 'pcs', 0, 10, 0),
 ('00000000-0000-0000-0000-00000000000f', 'F', 'Twice in one invoice', 'pcs', 2, 10, 20);
create temp table r(k text, got text, want text);
create function pg_temp.ci(lines jsonb) returns jsonb language sql as $$
  select public.checkin_transaction('Sup', 'INV', null, current_date, null, 'doc.pdf', 'AED', 1, current_date, 'test', lines) $$;
create function pg_temp.item(code text) returns text language sql as $$
  select format('qty %s cost %s value %s', current_qty::numeric(12,2), unit_cost::numeric(12,4), current_value::numeric(12,2))
  from inventory_items where item_code = code $$;

-- 1. 100 at AED 1 + 100 at AED 2 = 200 at AED 1.50, value 300.
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000a","quantity":100,"unit_cost":2,"original_unit_cost":2}]');
insert into r values ('1 average', pg_temp.item('A'), 'qty 200.00 cost 1.5000 value 300.00');
insert into r select '1 line records before/after', format('%s -> %s', unit_cost_before::numeric(12,4), unit_cost_after::numeric(12,4)), '1.0000 -> 1.5000'
  from inventory_transactions where item_code = 'A';
insert into r select '1 line keeps price paid', unit_cost_used::numeric(12,4)::text, '2.0000' from inventory_transactions where item_code = 'A';
-- 2. No stock on hand: the price paid becomes the cost.
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000b","quantity":10,"unit_cost":7}]');
insert into r values ('2 no stock', pg_temp.item('B'), 'qty 10.00 cost 7.0000 value 70.00');
-- 3. Below zero: nothing to average with, price paid is the cost.
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000c","quantity":10,"unit_cost":6}]');
insert into r values ('3 below zero', pg_temp.item('C'), 'qty 6.00 cost 6.0000 value 36.00');
-- 4. No document price: falls back to the item's own cost, average unchanged.
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000d","quantity":10}]');
insert into r values ('4 no price', pg_temp.item('D'), 'qty 20.00 cost 3.0000 value 60.00');
-- 5. No cost on file: the price paid becomes the cost.
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000e","quantity":10,"unit_cost":4}]');
insert into r values ('5 no cost on file', pg_temp.item('E'), 'qty 20.00 cost 4.0000 value 80.00');
-- 6. Same item twice on one invoice: averaged line by line.
--    10 @ 2 + 10 @ 4 = 20 @ 3; + 20 @ 6 = 40 @ 4.5
select pg_temp.ci('[{"item_id":"00000000-0000-0000-0000-00000000000f","quantity":10,"unit_cost":4},{"item_id":"00000000-0000-0000-0000-00000000000f","quantity":20,"unit_cost":6}]');
insert into r values ('6 twice', pg_temp.item('F'), 'qty 40.00 cost 4.5000 value 180.00');
-- 7. A stock count books the difference at the item's own cost: no change.
select public.checkin_transaction('Manual correction', 'Stock count: test', null, null, null, null, 'AED', 1, null, null,
  '[{"item_id":"00000000-0000-0000-0000-00000000000a","quantity":50,"unit_cost":1.5}]');
insert into r values ('7 stock count', pg_temp.item('A'), 'qty 250.00 cost 1.5000 value 375.00');
-- 8. New item: unchanged behaviour, after = its cost.
select pg_temp.ci('[{"item_id":null,"quantity":5,"unit_cost":9,"new_item":{"item_code":"N1","description":"New","unit_of_measure":"pcs","approved_by":"Tester"}}]');
insert into r values ('8 new item', pg_temp.item('N1'), 'qty 5.00 cost 9.0000 value 45.00');
-- 9. Still only the service_role may run it.
insert into r values ('9 not for signed-in users',
  has_function_privilege('authenticated', 'public.checkin_transaction(text,text,text,date,text,text,text,numeric,date,text,jsonb)', 'execute')::text, 'false');

select k, got = want as ok, got, want from r order by k;
select count(*) filter (where got <> want) as failures from r \gset
\if :failures
  \echo FAILED
  select 1/0;
\endif
