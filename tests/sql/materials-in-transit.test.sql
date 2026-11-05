-- Database rules of supabase/sql/materials_in_transit.sql, on a LOCAL
-- Postgres (never the live project). Load first: tests/sql/supabase-base.sql,
-- tests/sql/inventory-base.sql, tests/sql/storage-base.sql,
-- supabase/sql/renson_pilot.sql, renson_checkout.sql, renson_workflow.sql,
-- renson_release.sql, then supabase/sql/materials_in_transit.sql (twice:
-- re-running must be safe), then this file.
\set ON_ERROR_STOP 1
create temp table r(n serial, k text, v text); grant all on r, r_n_seq to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r(k, v) values (label, 'UNEXPECTED: allowed');
exception when others then insert into r(k, v) values (label, 'refused: ' || left(sqlerrm, 60)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S2 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''

-- Fixture: Freedom items (310028 has two bar lengths) and Check-in lines
-- entered by S1 / S2, a Check-out line, a Renson item and Renson Check-in.
insert into public.inventory_items (id, item_code, description, bar_length_mm, current_qty, unit_cost, current_value) values
 ('11111111-0000-0000-0000-000000000001', '310028', 'ZLS1 Track 01 MILL', 2500, 10, 30, 300),
 ('11111111-0000-0000-0000-000000000002', '310028', 'ZLS1 Track 01 MILL', 5100, 20, 150, 3000),
 ('11111111-0000-0000-0000-000000000003', '134002', 'Brake Rod 1.5m', null, 5, 9, 45);
insert into public.inventory_transactions (id, type, item_id, item_code, quantity, value, performed_by, source_document_hash) values
 ('22222222-0000-0000-0000-000000000001', 'check_in', '11111111-0000-0000-0000-000000000002', '310028', 4000, 1, 'bbbbbbbb-0000-0000-0000-000000000001', 'h1'),
 ('22222222-0000-0000-0000-000000000002', 'check_in', '11111111-0000-0000-0000-000000000003', '134002', 100, 1, 'bbbbbbbb-0000-0000-0000-000000000001', 'h1'),
 ('22222222-0000-0000-0000-000000000003', 'check_in', '11111111-0000-0000-0000-000000000002', '310028', 6000, 1, 'bbbbbbbb-0000-0000-0000-000000000001', 'h2'),
 ('22222222-0000-0000-0000-000000000004', 'check_in', '11111111-0000-0000-0000-000000000003', '134002', 500, 1, 'bbbbbbbb-0000-0000-0000-000000000002', 'h3'),
 ('22222222-0000-0000-0000-000000000005', 'check_out', '11111111-0000-0000-0000-000000000003', '134002', 1, 1, 'bbbbbbbb-0000-0000-0000-000000000001', null),
 ('22222222-0000-0000-0000-000000000006', 'check_in', '11111111-0000-0000-0000-000000000003', '134002', 500, 1, 'bbbbbbbb-0000-0000-0000-000000000001', 'h4');
insert into public.renson_items (item_code, description, unit, current_qty, unit_cost) values ('22874', 'Steel bar', 'pc', 10, 153);
insert into public.renson_transactions (item_id, item_code, type, quantity, qty_before, qty_after, performed_by)
  select id, item_code, 'check_in', 5, 10, 15, 'bbbbbbbb-0000-0000-0000-000000000001' from public.renson_items where item_code = '22874';
create temp table before as select
  (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) items,
  (select md5(string_agg(t::text, '|' order by id)) from public.inventory_transactions t) tx,
  (select md5(string_agg(t::text, '|' order by id)) from public.renson_items t) ritems,
  (select md5(string_agg(t::text, '|' order by id)) from public.renson_transactions t) rtx;
grant select on before to authenticated;

\set PO '''{"po_number":"PO26-2106","supplier":"Freedom Screens Global Co., Ltd","po_date":"2026-09-30","quote_ref":"S00231","currency":"USD","rate_to_aed":3.6725,"expected_delivery":"2026-12-15","lines":[{"item_code":"310028","description":"Track (Mill, IZLX)","unit":"Units","qty_ordered":10000,"unit_price":31.5,"freedom_item_id":"11111111-0000-0000-0000-000000000002"},{"item_code":"134002","description":"Brake Rod (1.5m)","unit":"Units","qty_ordered":600,"unit_price":2.1,"freedom_item_id":"11111111-0000-0000-0000-000000000003"},{"item_code":"90001T","description":"Track Drilling Guide Jig","unit":"Units","qty_ordered":4,"unit_price":55.5}]}'''

-- 1. Who may create
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('1 anon creates', format('select public.transit_create_order(%L::jsonb)', :PO));
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
select pg_temp.try('1b switched-off account creates', format('select public.transit_create_order(%L::jsonb)', :PO));
insert into r(k, v) select '1c switched-off account reads', count(*)::text from public.transit_orders;

-- 2. Staff creates; bad requests refused whole
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('2a USD without a rate', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","currency":"USD","lines":[{"description":"a","qty_ordered":1}]}')$q$);
select pg_temp.try('2b no lines', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","lines":[]}')$q$);
select pg_temp.try('2c zero quantity', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","lines":[{"description":"a","qty_ordered":0}]}')$q$);
select pg_temp.try('2d negative price', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","lines":[{"description":"a","qty_ordered":1,"unit_price":-1}]}')$q$);
select pg_temp.try('2e item id of another code', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","lines":[{"item_code":"999","description":"a","qty_ordered":1,"freedom_item_id":"11111111-0000-0000-0000-000000000002"}]}')$q$);
select pg_temp.try('2f same material twice', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","lines":[{"item_code":"a1","description":"Part","qty_ordered":1},{"item_code":"A1","description":"part ","qty_ordered":2}]}')$q$);
select pg_temp.try('2g status received at creation', $q$select public.transit_create_order('{"po_number":"X1","supplier":"Freedom","delivery_status":"completed","lines":[{"description":"a","qty_ordered":1}]}')$q$);
insert into r(k, v) select '2h nothing saved', count(*)::text from public.transit_orders;
insert into r(k, v) select '2i create', public.transit_create_order(:PO)::text;
select pg_temp.try('2j same PO written differently', $q$select public.transit_create_order('{"po_number":"po 26/2106","supplier":"Freedom","lines":[{"description":"a","qty_ordered":1}]}')$q$);
insert into r(k, v) select '2k saved', string_agg(po_number || ' ' || supplier_group || ' ' || inventory || ' ' || delivery_status || ' ' || payment_status || ' ' || currency || '@' || rate_to_aed || ' by ' || created_by_name, '; ') from public.transit_orders;
insert into r(k, v) select '2l lines', string_agg(line_no || ' ' || coalesce(item_code, '-') || ' ' || qty_ordered || '/' || qty_pending || ' @' || coalesce(unit_price::text, '-') || case when freedom_item_id is null then ' (no Master link)' else ' linked' end, '; ' order by line_no) from public.transit_lines;
select id as po from public.transit_orders where po_number = 'PO26-2106' \gset
select id as l1 from public.transit_lines where order_id = :po and line_no = 1 \gset
select id as l2 from public.transit_lines where order_id = :po and line_no = 2 \gset
select id as l3 from public.transit_lines where order_id = :po and line_no = 3 \gset

-- 3. Staff edits (dates / payment / status), not the quantities
insert into r(k, v) select '3a dates + payment', (public.transit_update_order(jsonb_build_object('id', :po, 'expected_delivery', '2026-12-20', 'payment_status', 'partially_paid', 'notes', 'Sea freight'))->>'changed');
select pg_temp.try('3b Completed while pending', format('select public.transit_update_order(''{"id":%s,"delivery_status":"completed"}'')', :po));
select pg_temp.try('3c Cancelled by staff', format('select public.transit_update_order(''{"id":%s,"delivery_status":"cancelled"}'')', :po));
select pg_temp.try('3d Partially received with nothing received', format('select public.transit_update_order(''{"id":%s,"delivery_status":"partially_received"}'')', :po));
insert into r(k, v) select '3e In transit', (public.transit_update_order(jsonb_build_object('id', :po, 'delivery_status', 'in_transit'))->>'changed');
select pg_temp.try('3f staff changes quantities', format('select public.transit_admin_change(''{"order_id":%s,"reason":"x","changes":[{"action":"edit","line_id":%s,"qty_ordered":5}]}'')', :po, :l1));
select pg_temp.try('3g staff cancels', format('select public.transit_cancel(''{"order_id":%s,"reason":"x"}'')', :po));
select pg_temp.try('3h staff deletes', format('select public.transit_delete_order(%s, ''x'')', :po));

-- 4. Receive (after the Check-in): 4,000 of 10,000 Track + 100 Brake Rods
\set K1 '''aaaa0000-0000-0000-0000-000000000001'''
select pg_temp.try('4a no Check-in', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f1","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":[],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l1));
select pg_temp.try('4b a Check-out line as the Check-in', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f2","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000005"],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l1));
select pg_temp.try('4c someone else''s Check-in', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f3","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000004"],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l1));
select pg_temp.try('4d Renson Check-in for a Freedom PO', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f4","order_id":%s,"checkin_kind":"renson","checkin_tx_ids":["1"],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l1));
select pg_temp.try('4e more than ordered', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f5","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000001"],"lines":[{"line_id":%s,"qty":10001}]}'')', :po, :l1));
select pg_temp.try('4f same line twice', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f6","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000001"],"lines":[{"line_id":%s,"qty":1},{"line_id":%s,"qty":1}]}'')', :po, :l1, :l1));
select pg_temp.try('4g zero', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f7","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000001"],"lines":[{"line_id":%s,"qty":0}]}'')', :po, :l1));
insert into r(k, v) select '4h nothing received so far', sum(qty_received)::text || ' / receipts ' || (select count(*) from public.transit_receipts) from public.transit_lines;
insert into r(k, v) select '4i receive', (public.transit_receive(jsonb_build_object('receive_key', :K1, 'order_id', :po, 'delivery_note_no', 'DN-1', 'delivery_date', '2026-11-20',
  'checkin_kind', 'freedom', 'checkin_tx_ids', jsonb_build_array('22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'), 'checkin_reference', 'INV-1',
  'lines', jsonb_build_array(jsonb_build_object('line_id', :l1, 'qty', 4000), jsonb_build_object('line_id', :l2, 'qty', 100)))) - 'receipt_id')::text;
insert into r(k, v) select '4j retry (same key)', (public.transit_receive(jsonb_build_object('receive_key', :K1, 'order_id', :po,
  'checkin_kind', 'freedom', 'checkin_tx_ids', jsonb_build_array('22222222-0000-0000-0000-000000000001'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', :l1, 'qty', 4000)))) - 'receipt_id')::text;
select pg_temp.try('4k same Check-in again, new key', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f8","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000002"],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l2));
select pg_temp.try('4l more than still pending', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000f9","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000003"],"lines":[{"line_id":%s,"qty":6001}]}'')', :po, :l1));
insert into r(k, v) select '4m after first delivery', (select delivery_status from public.transit_orders where id = :po) || ' | ' || string_agg(line_no || ' ' || qty_received || '/' || qty_ordered || ' pending ' || qty_pending, '; ' order by line_no) from public.transit_lines where order_id = :po;

-- 5. Pending QC (a label), then the second delivery (6,000) against the same PO
insert into r(k, v) select '5a Pending QC', (public.transit_update_order(jsonb_build_object('id', :po, 'delivery_status', 'pending_qc'))->>'changed');
select pg_temp.try('5b back to Ordered after a delivery', format('select public.transit_update_order(''{"id":%s,"delivery_status":"ordered"}'')', :po));
insert into r(k, v) select '5c second delivery', (public.transit_receive(jsonb_build_object('receive_key', 'aaaa0000-0000-0000-0000-000000000002', 'order_id', :po,
  'delivery_note_no', 'DN-2', 'checkin_kind', 'freedom', 'checkin_tx_ids', jsonb_build_array('22222222-0000-0000-0000-000000000003'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', :l1, 'qty', 6000)))) - 'receipt_id')::text;

-- 6. Admin: over-delivery needs the ordered quantity raised first (with a reason)
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('6a no reason', format('select public.transit_admin_change(''{"order_id":%s,"changes":[{"action":"edit","line_id":%s,"qty_ordered":700}]}'')', :po, :l2));
select pg_temp.try('6b below what was received', format('select public.transit_admin_change(''{"order_id":%s,"reason":"x","changes":[{"action":"edit","line_id":%s,"qty_ordered":50}]}'')', :po, :l2));
select pg_temp.try('6c remove a line with deliveries', format('select public.transit_admin_change(''{"order_id":%s,"reason":"x","changes":[{"action":"remove","line_id":%s}]}'')', :po, :l2));
insert into r(k, v) select '6d raise 600 -> 700', (public.transit_admin_change(jsonb_build_object('order_id', :po, 'reason', 'Supplier sent 100 extra, approved',
  'changes', jsonb_build_array(jsonb_build_object('action', 'edit', 'line_id', :l2, 'qty_ordered', 700)))))::text;
-- the Admin links S2's Check-in (staff can't)
insert into r(k, v) select '6e Admin links S2''s Check-in', (public.transit_receive(jsonb_build_object('receive_key', 'aaaa0000-0000-0000-0000-000000000003', 'order_id', :po,
  'checkin_kind', 'freedom', 'checkin_tx_ids', jsonb_build_array('22222222-0000-0000-0000-000000000004'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', :l2, 'qty', 500)))) - 'receipt_id')::text;
select pg_temp.try('6f cancel more than pending', format('select public.transit_cancel(''{"order_id":%s,"line_id":%s,"qty":5,"reason":"x"}'')', :po, :l3));
insert into r(k, v) select '6g cancel 1 jig', public.transit_cancel(jsonb_build_object('order_id', :po, 'line_id', :l3, 'qty', 1, 'reason', 'Supplier short'))::text;
-- 7. Last delivery completes the PO; nothing more can be received
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r(k, v) select '7a last delivery', (public.transit_receive(jsonb_build_object('receive_key', 'aaaa0000-0000-0000-0000-000000000004', 'order_id', :po,
  'checkin_kind', 'freedom', 'checkin_tx_ids', jsonb_build_array('22222222-0000-0000-0000-000000000006'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', :l2, 'qty', 100), jsonb_build_object('line_id', :l3, 'qty', 3)))) - 'receipt_id')::text;
select pg_temp.try('7b receive on a completed PO', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000fa","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000006"],"lines":[{"line_id":%s,"qty":1}]}'')', :po, :l1));
insert into r(k, v) select '7c final', (select delivery_status from public.transit_orders where id = :po) || ' | ' || string_agg(line_no || ' rec ' || qty_received || ' canc ' || qty_cancelled || ' of ' || qty_ordered || ' pending ' || qty_pending, '; ' order by line_no) from public.transit_lines where order_id = :po;
insert into r(k, v) select '7d delivery history', string_agg(coalesce(delivery_note_no, '-') || ' ' || received_by_name || ' lines ' || (select count(*) from public.transit_receipt_lines rl where rl.receipt_id = t.id) || ' check-in lines ' || cardinality(checkin_tx_ids), '; ' order by id) from public.transit_receipts t;

-- 8. Renson PO: inventory = renson, item found by code; Admin cancels it all
insert into r(k, v) select '8a Renson PO', public.transit_create_order('{"po_number":"R-500","supplier":"Renson NV","currency":"EUR","rate_to_aed":4.2,"lines":[{"item_code":"22874","description":"Steel bar","qty_ordered":20,"unit_price":40},{"item_code":"NEWR","description":"New Renson part","qty_ordered":5}]}')::text;
insert into r(k, v) select '8b', string_agg(o.inventory || ' ' || o.supplier_group || ' ' || l.item_code || case when l.renson_item_id is null then ' (no Master link)' else ' linked' end, '; ' order by l.line_no) from public.transit_orders o join public.transit_lines l on l.order_id = o.id where o.po_number = 'R-500';
select id as rpo from public.transit_orders where po_number = 'R-500' \gset
select id as rl1 from public.transit_lines where order_id = :rpo and line_no = 1 \gset
select pg_temp.try('8c Freedom Check-in for a Renson PO', format('select public.transit_receive(''{"receive_key":"aaaa0000-0000-0000-0000-0000000000fb","order_id":%s,"checkin_kind":"freedom","checkin_tx_ids":["22222222-0000-0000-0000-000000000006"],"lines":[{"line_id":%s,"qty":1}]}'')', :rpo, :rl1));
insert into r(k, v) select '8d Renson receive', (public.transit_receive(jsonb_build_object('receive_key', 'aaaa0000-0000-0000-0000-000000000005', 'order_id', :rpo,
  'checkin_kind', 'renson', 'checkin_tx_ids', (select jsonb_agg(id::text) from public.renson_transactions where type = 'check_in'),
  'lines', jsonb_build_array(jsonb_build_object('line_id', :rl1, 'qty', 5)))) - 'receipt_id')::text;
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('8e delete a PO with deliveries', format('select public.transit_delete_order(%s, ''x'')', :rpo));
insert into r(k, v) select '8f cancel the rest', public.transit_cancel(jsonb_build_object('order_id', :rpo, 'reason', 'Rest no longer needed'))::text;
-- an Admin deletes a PO with nothing received; its log stays
insert into r(k, v) select '8g', (public.transit_create_order('{"po_number":"TMP-1","supplier":"Fusion LLC","lines":[{"description":"x","qty_ordered":1}]}') ? 'id')::text;
select id as tmp from public.transit_orders where po_number = 'TMP-1' \gset
insert into r(k, v) select '8h delete', public.transit_delete_order(:tmp, 'Entered by mistake')::text;
insert into r(k, v) select '8i log kept', string_agg(action, ',' order by id) from public.transit_log where order_id = :tmp;

-- 9. Documents: only a file that is really in the bucket, under its PO
select pg_temp.try('9a not uploaded', format('select public.transit_add_document(%s, ''po'', ''PO.pdf'', ''%s/%s.pdf'')', :po, :po, repeat('a', 64)));
reset role; insert into storage.objects (bucket_id, name) values ('transit-documents', :po || '/' || repeat('a', 64) || '.pdf');
select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('9b staff uploads under another name', $q$insert into storage.objects (bucket_id, name) values ('transit-documents', 'x.pdf')$q$);
insert into storage.objects (bucket_id, name) values ('transit-documents', :rpo || '/' || repeat('b', 64) || '.pdf');
insert into r(k, v) select '9c staff upload under the pattern', 'ok';
select pg_temp.try('9d path of another PO', format('select public.transit_add_document(%s, ''po'', ''PO.pdf'', ''%s/%s.pdf'')', :po, :rpo, repeat('b', 64)));
insert into r(k, v) select '9e add', (public.transit_add_document(:po, 'po', 'PO26-2106.pdf', :po || '/' || repeat('a', 64) || '.pdf') - 'id')::text;
insert into r(k, v) select '9f again', (public.transit_add_document(:po, 'po', 'PO26-2106.pdf', :po || '/' || repeat('a', 64) || '.pdf') - 'id')::text;
select pg_temp.try('9g write a table directly', format('update public.transit_lines set qty_received = 0 where order_id = %s', :po));
insert into r(k, v) select '9h direct write changed nothing', sum(qty_received)::text from public.transit_lines where order_id = :po;

-- 10. Audit trail + stock never touched
insert into r(k, v) select '10a log', string_agg(action || ' by ' || by_name, ', ' order by id) from public.transit_log where order_id = :po;
reset role;
insert into r(k, v) select '10b stock unchanged', ((select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) = (select items from before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.inventory_transactions t) = (select tx from before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.renson_items t) = (select ritems from before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.renson_transactions t) = (select rtx from before))::text;
select k, v from r order by n;
