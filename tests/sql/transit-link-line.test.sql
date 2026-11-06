-- Database rules of supabase/sql/transit_link_line.sql, on a LOCAL Postgres
-- (never the live project). Run after tests/sql/materials-in-transit.test.sql
-- (same db, its fixture: Freedom 310028 at 2500 / 5100 mm, 134002; Renson
-- 22874), then:
--   psql -d <same db> -f supabase/sql/transit_link_line.sql   (twice: re-run safe)
--   psql -d <same db> -f tests/sql/transit-link-line.test.sql
\set ON_ERROR_STOP 1
create temp table r(n serial, k text, v text); grant all on r, r_n_seq to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r(k, v) values (label, 'UNEXPECTED: allowed');
exception when others then insert into r(k, v) values (label, 'refused: ' || left(sqlerrm, 60)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
create temp table before as select
  (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) items,
  (select md5(string_agg(t::text, '|' order by id)) from public.renson_items t) ritems,
  (select md5(string_agg(concat_ws('|', id, qty_ordered, qty_received, qty_cancelled, unit_price, description), ';' order by id)) from public.transit_lines) lines;
grant select on before to authenticated;

-- A Freedom PO saved with unlinked lines (310028 = two bar lengths, a line
-- without a code, a code not in Master) and a Renson PO with an unlinked line.
select set_config('request.jwt.claims', :S1, false); set role authenticated;
select (public.transit_create_order('{"po_number":"LINK-1","supplier":"Freedom Screens Global","currency":"AED","rate_to_aed":1,"payment_status":"tbc","delivery_status":"ordered",
  "lines":[{"item_code":"310028","description":"Track","qty_ordered":200},{"description":"International products","qty_ordered":3},
           {"item_code":"190009","description":"Spring","qty_ordered":250},{"item_code":"134002","description":"Brake rod","qty_ordered":600,"freedom_item_id":"11111111-0000-0000-0000-000000000003"}]}') ->> 'id') as fpo \gset
reset role;
update public.renson_items set item_code = item_code where false;  -- (nothing: just keeps the fixture)
insert into public.renson_items (item_code, description, unit, current_qty, unit_cost) values ('NEWR1', 'Added later', 'pc', 0, null);
select set_config('request.jwt.claims', :S1, false); set role authenticated;
select (public.transit_create_order('{"po_number":"LINK-R","supplier":"Renson NV","currency":"AED","rate_to_aed":1,"payment_status":"tbc","delivery_status":"ordered",
  "lines":[{"item_code":"NEWR2","description":"Not a Renson item yet","qty_ordered":5}]}') ->> 'id') as rpo \gset
select id as l_track from public.transit_lines where order_id = :fpo and item_code = '310028' \gset
select id as l_nocode from public.transit_lines where order_id = :fpo and item_code is null \gset
select id as l_new from public.transit_lines where order_id = :fpo and item_code = '190009' \gset
select id as l_brake from public.transit_lines where order_id = :fpo and item_code = '134002' \gset
select id as l_r from public.transit_lines where order_id = :rpo \gset
insert into r(k, v) select '0 saved: links', string_agg(coalesce(item_code, '-') || '=' || (freedom_item_id is not null)::text, ',' order by line_no) from public.transit_lines where order_id = :fpo;

-- 1. Refusals
select pg_temp.try('1a wrong code (134002 item for a 310028 line)', format('select public.transit_link_line(%s, %L)', :l_track, '11111111-0000-0000-0000-000000000003'));
select pg_temp.try('1b line without a code', format('select public.transit_link_line(%s, %L)', :l_nocode, '11111111-0000-0000-0000-000000000003'));
select pg_temp.try('1c already linked (134002)', format('select public.transit_link_line(%s, %L)', :l_brake, '11111111-0000-0000-0000-000000000003'));
select pg_temp.try('1d not an id', format('select public.transit_link_line(%s, %L)', :l_track, 'abc'));
select pg_temp.try('1e unknown line', 'select public.transit_link_line(999999, ''11111111-0000-0000-0000-000000000001'')');
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
select pg_temp.try('1f switched-off account', format('select public.transit_link_line(%s, %L)', :l_track, '11111111-0000-0000-0000-000000000002'));
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('1g anon', format('select public.transit_link_line(%s, %L)', :l_track, '11111111-0000-0000-0000-000000000002'));

-- 2. Staff links 310028 to the 5100 mm row; logged; can't re-point it
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r(k, v) select '2a link 310028 -> 5100 mm', (public.transit_link_line(:l_track, '11111111-0000-0000-0000-000000000002') - 'line_id')::text;
select pg_temp.try('2b re-point to 2500 mm', format('select public.transit_link_line(%s, %L)', :l_track, '11111111-0000-0000-0000-000000000001'));
insert into r(k, v) select '2c line now', concat_ws(' ', item_code, freedom_item_id, qty_pending) from public.transit_lines where id = :l_track;
insert into r(k, v) select '2d log', string_agg(action || ' ' || (detail ->> 'code') || ' by ' || by_name, ', ') from public.transit_log where order_id = :fpo and action = 'link';
-- a code not in Master stays unlinked (nothing to choose)
select pg_temp.try('2e 190009 to some item', format('select public.transit_link_line(%s, %L)', :l_new, '11111111-0000-0000-0000-000000000002'));

-- 3. Renson: an item added to Master later can then be linked (same code only)
select pg_temp.try('3a Renson wrong code', format('select public.transit_link_line(%s, %L)', :l_r, (select id::text from public.renson_items where item_code = 'NEWR1')));
reset role; update public.renson_items set item_code = 'NEWR2' where item_code = 'NEWR1';
select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('3b Renson PO, Freedom uuid', format('select public.transit_link_line(%s, %L)', :l_r, '11111111-0000-0000-0000-000000000002'));
insert into r(k, v) select '3c Renson link', (public.transit_link_line(:l_r, (select id::text from public.renson_items where item_code = 'NEWR2')) ->> 'ok');

-- 4. Nothing else changed: quantities, prices, wording of the earlier lines; stock
reset role;
insert into r(k, v) select '4a stock + Renson items unchanged (except the renamed test item)',
  ((select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) = (select items from before))::text;
insert into r(k, v) select '4b statuses', string_agg(po_number || ' ' || delivery_status, ', ' order by id) from public.transit_orders where id in (:fpo, :rpo);
select k, v from r order by n;
