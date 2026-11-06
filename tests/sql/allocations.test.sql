-- Database rules of supabase/sql/allocations.sql, on a LOCAL Postgres (never
-- the live project). Load first: tests/sql/supabase-base.sql,
-- tests/sql/inventory-base.sql, supabase/sql/renson_pilot.sql,
-- renson_checkout.sql, renson_workflow.sql, renson_release.sql, then
-- supabase/sql/allocations.sql (twice: re-run safe), then this file.
\set ON_ERROR_STOP 1
create temp table r(n serial, k text, v text); grant all on r, r_n_seq to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r(k, v) values (label, 'UNEXPECTED: allowed');
exception when others then insert into r(k, v) values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S2 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''

-- Fixture: Freedom A (100 in stock), B (10), Renson R (20)
insert into public.inventory_items (id, item_code, description, unit_of_measure, current_qty, unit_cost, current_value) values
 ('aaaa0000-0000-0000-0000-00000000000a', 'A1', 'Item A', 'pcs', 100, 2, 200),
 ('aaaa0000-0000-0000-0000-00000000000b', 'B1', 'Item B', 'pcs', 10, 5, 50);
insert into public.renson_items (item_code, description, unit, current_qty, unit_cost) values ('R1', 'Renson R', 'pc', 20, 3);
select id as rid from public.renson_items where item_code = 'R1' \gset
create temp table before as select
  (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) items,
  (select md5(string_agg(concat_ws('|', id, current_qty, unit_cost), ';' order by id)) from public.renson_items t) ritems;
grant select on before to authenticated;
-- a Check-out of job 26294 entered BEFORE the allocation: never counted
insert into public.inventory_transactions (id, type, job_number, item_id, item_code, quantity, created_at)
values ('dddd0000-0000-0000-0000-000000000001', 'check_out', '26294', 'aaaa0000-0000-0000-0000-00000000000a', 'A1', 7, now() - interval '1 day');

-- 1. Who
select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('1a anon allocates', $q$select public.allocation_create('{"job_number":"1","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":1}]}')$q$);
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
select pg_temp.try('1b switched-off account', $q$select public.allocation_create('{"job_number":"1","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":1}]}')$q$);

-- 2. Staff One allocates job 26294: A 30 (two lines of 20 + 10 = added up), R 5
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('2a no job number', $q$select public.allocation_create('{"job_number":" ","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":1}]}')$q$);
select pg_temp.try('2b qty 0', $q$select public.allocation_create('{"job_number":"9","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":0}]}')$q$);
select pg_temp.try('2c qty text', $q$select public.allocation_create('{"job_number":"9","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":"x"}]}')$q$);
insert into r(k, v) select '2d allocate 26294', (public.allocation_create(format('{"job_number":"26294","client":"Etihad","source":"job_list","lines":[
  {"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":20},{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":10},
  {"inventory":"renson","item_id":"%s","qty":5}]}', :rid)::jsonb) - 'id')::text;
select id as a1 from public.allocations where job_number = '26294' \gset
insert into r(k, v) select '2e lines', string_agg(inventory || ' ' || item_code || ' ' || qty_allocated || ' open ' || qty_open, ', ' order by id) from public.allocation_lines where allocation_id = :a1;
insert into r(k, v) select '2f old Check-out not counted', (select count(*) from public.allocation_checkout_links)::text || ' links, checked out ' || (select sum(qty_checked_out) from public.allocation_lines)::text;

-- 3. Staff Two can't take what is reserved: A available 70
reset role; select set_config('request.jwt.claims', :S2, false); set role authenticated;
select pg_temp.try('3a 71 of A (70 available)', $q$select public.allocation_create('{"job_number":"J2","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000b","qty":1},{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":71}]}')$q$);
insert into r(k, v) select '3b nothing saved for J2', count(*)::text from public.allocations where job_number = 'J2';
insert into r(k, v) select '3c 70 of A', (public.allocation_create('{"job_number":"J2","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":70}]}') ->> 'ok');
select pg_temp.try('3d one more of A', $q$select public.allocation_create('{"job_number":"J3","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":1}]}')$q$);

-- 4. Top up 26294 (same open allocation): B 5
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r(k, v) select '4a top up', (public.allocation_create('{"job_number":"26 294","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000b","qty":5}]}') - 'id')::text;
insert into r(k, v) select '4b one open allocation, 3 lines', (select count(*) from public.allocations where job_key = '26294')::text || ' / ' || (select count(*) from public.allocation_lines where allocation_id = :a1)::text;

-- 5. Check-out of job 26294 (A 20, R 5) -> moved from open to checked out; once only
reset role;
insert into public.inventory_transactions (id, type, job_number, item_id, item_code, quantity) values
 ('dddd0000-0000-0000-0000-000000000002', 'check_out', '26294', 'aaaa0000-0000-0000-0000-00000000000a', 'A1', 20),
 ('dddd0000-0000-0000-0000-000000000003', 'check_out', 'OTHER', 'aaaa0000-0000-0000-0000-00000000000b', 'B1', 5);
insert into public.renson_transactions (item_id, item_code, type, quantity, qty_before, qty_after, job_number) values (:rid, 'R1', 'check_out', 5, 20, 15, '26294');
select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r(k, v) select '5a sync 26294', (public.allocation_sync('26294') -> 'updated')::text;
insert into r(k, v) select '5b lines', string_agg(item_code || ' out ' || qty_checked_out || ' open ' || qty_open, ', ' order by id) from public.allocation_lines where allocation_id = :a1;
insert into r(k, v) select '5c sync again = nothing', (public.allocation_sync(null) -> 'updated')::text;
-- a second Check-out of 40 A: only the 10 still open are used
reset role;
insert into public.inventory_transactions (id, type, job_number, item_id, item_code, quantity) values
 ('dddd0000-0000-0000-0000-000000000004', 'check_out', '26294', 'aaaa0000-0000-0000-0000-00000000000a', 'A1', 40);
select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r(k, v) select '5d sync: 10 of the 40', (public.allocation_sync('26294') -> 'updated' -> 0 ->> 'qty');
insert into r(k, v) select '5e A line', concat_ws(' ', qty_allocated, qty_checked_out, qty_open) from public.allocation_lines where allocation_id = :a1 and item_code = 'A1';
insert into r(k, v) select '5f links', string_agg(kind || ':' || qty, ',' order by id) from public.allocation_checkout_links;

-- 6. Reduce / cancel with a reason (any staff)
reset role; select set_config('request.jwt.claims', :S2, false); set role authenticated;
select id as lb from public.allocation_lines where allocation_id = :a1 and item_code = 'B1' \gset
select pg_temp.try('6a no reason', format('select public.allocation_release(''{"allocation_id":%s,"reason":" ","lines":[{"line_id":%s,"qty":1}]}'')', :a1, :lb));
select pg_temp.try('6b more than open', format('select public.allocation_release(''{"allocation_id":%s,"reason":"x","lines":[{"line_id":%s,"qty":6}]}'')', :a1, :lb));
insert into r(k, v) select '6c release 2 of B', (public.allocation_release(format('{"allocation_id":%s,"reason":"Job changed","lines":[{"line_id":%s,"qty":2}]}', :a1, :lb)::jsonb))::text;
insert into r(k, v) select '6d release the rest', (public.allocation_release(format('{"allocation_id":%s,"reason":"Not needed","all":true}', :a1)::jsonb))::text;
select pg_temp.try('6e closed allocation', format('select public.allocation_release(''{"allocation_id":%s,"reason":"x","all":true}'')', :a1));
select id as a2 from public.allocations where job_number = 'J2' \gset
insert into r(k, v) select '6f cancel J2', (public.allocation_release(format('{"allocation_id":%s,"reason":"Order cancelled","all":true}', :a2)::jsonb) ->> 'status');
-- released quantity is available again: 100 of A free now (30 checked out from 26294's view, stock itself untouched)
insert into r(k, v) select '6g A available again', (public.allocation_create('{"job_number":"J4","lines":[{"inventory":"freedom","item_id":"aaaa0000-0000-0000-0000-00000000000a","qty":100}]}') ->> 'ok');
insert into r(k, v) select '6h statuses', string_agg(job_number || ' ' || status, ', ' order by id) from public.allocations;

-- 7. Tables are read-only from outside the functions; log; stock untouched
select pg_temp.try('7a insert directly', $q$insert into public.allocations (job_number, job_key) values ('x', 'X')$q$);
select pg_temp.try('7b update a line directly', format('update public.allocation_lines set qty_released = 0 where allocation_id = %s', :a1));
insert into r(k, v) select '7c direct update changed nothing', sum(qty_released)::text from public.allocation_lines where allocation_id = :a1;
insert into r(k, v) select '7d log', string_agg(action || ' by ' || by_name, ', ' order by id) from public.allocation_log where allocation_id = :a1;
reset role;
insert into r(k, v) select '7e stock unchanged', ((select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) = (select items from before)
  and (select md5(string_agg(concat_ws('|', id, current_qty, unit_cost), ';' order by id)) from public.renson_items t) = (select ritems from before))::text;
select k, v from r order by n;
