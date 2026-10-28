-- Admin-only TEST mode of the delivery notes (supabase/sql/delivery_notes_test_mode.sql),
-- on a LOCAL Postgres (never the live project). Run:
--   psql -d <empty db> -f tests/sql/supabase-base.sql
--   psql -d <same db> -f tests/sql/inventory-base.sql
--   psql -d <same db> -f supabase/sql/delivery_notes.sql
--   psql -d <same db> -f supabase/sql/delivery_notes_test_mode.sql
--   psql -d <same db> -f tests/sql/delivery-notes.test.sql          (real notes: unchanged)
--   psql -d <same db> -f tests/sql/delivery-notes-test-mode.test.sql
-- Every row printed at the end must read as expected.
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create temp table ids(k text primary key, v uuid); grant all on ids to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S2 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}'''
\set HT '''cccc000000000000000000000000000000000000000000000000000000000003'''
\set H '''aaaa000000000000000000000000000000000000000000000000000000000001'''
\set NOTES '''[{"kind":"powder_coating","delivery_address":"ALUMETAL","lines":[{"description":"HOUSING","qty":3}]},{"kind":"finished_goods","lines":[{"description":"INFINITY","qty":1}]}]'''
create temp table stock_before as select count(*) n, sum(quantity) q from public.inventory_transactions;
create temp table real_before as select count(*) n from public.delivery_notes where not is_test;

-- Staff cannot use test mode
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('1 staff prepares test notes', format('select public.prepare_delivery_test_notes(%L, %L, %L, %L, %L::jsonb)', :HT, 'T', 'x', 'x', :NOTES));
-- Admin: any job list, no Check-out needed
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '2 admin prepares test notes (no check-out)', public.prepare_delivery_test_notes(:HT, '26371F', 'Monique Hageman', 'test.pdf', :NOTES)::text;
insert into r select '3 again: no duplicates', public.prepare_delivery_test_notes(:HT, '26371F', 'Monique Hageman', 'test.pdf', :NOTES)::text;
insert into r select '4 admin also tests a job list that has real notes', public.prepare_delivery_test_notes(:H, '26371F', 'Monique Hageman', 'test.pdf', :NOTES)::text;
-- Test notes are filed under SHA-256 of "test:" + the job list's fingerprint
-- (the browser computes the same value to find them).
insert into ids select 'tpc', id from public.delivery_notes where is_test and kind = 'powder_coating' and source_document_hash = '0ee7703bda1ad918110096d36864b2d2f2b2b2d05d91936573711486afab7d4a';
insert into ids select 'tfg', id from public.delivery_notes where is_test and kind = 'finished_goods' and source_document_hash = '0ee7703bda1ad918110096d36864b2d2f2b2b2d05d91936573711486afab7d4a';
insert into r select '4b test notes filed apart from the real ones', format('found=%s real_untouched=%s', (select count(*) from ids where k in ('tpc','tfg')), (select count(*) from public.delivery_notes where source_document_hash = :H and not is_test));
insert into r select '5 admin sees test notes', count(*)::text from public.delivery_notes where is_test;
insert into r select '6 confirm test note: TEST series', dn_number from public.confirm_delivery_note((select v from ids where k='tpc'), '{"ral_code":"RAL9010","delivered_by":"Test","delivery_date":"2026-10-28"}');
insert into r select '7 admin corrects a test note', format('corrected=%s', corrected_count) from public.correct_delivery_note((select v from ids where k='tpc'), '{"ral_code":"RAL9016"}', 'test');
-- Staff: test notes are invisible and untouchable
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '8 staff sees test notes', count(*)::text from public.delivery_notes where is_test;
insert into r select '8b staff sees test history', count(*)::text from public.delivery_note_history where note_id in (select v from ids);
select pg_temp.try('9 staff saves a test note', format('select public.save_delivery_note(%L, %L::jsonb)', (select v from ids where k='tfg'), '{"ral_code":"x"}'));
select pg_temp.try('9b staff confirms a test note', format('select public.confirm_delivery_note(%L, %L::jsonb)', (select v from ids where k='tfg'), '{"delivery_address":"W","delivered_by":"x","delivery_date":"2026-10-28"}'));
select pg_temp.try('9c staff deletes a test note', format('select public.delete_test_delivery_note(%L)', (select v from ids where k='tfg')));
-- A corrector who is not an Admin still can't touch a test note
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select public.set_delivery_note_corrector('bbbbbbbb-0000-0000-0000-000000000002', true);
reset role; select set_config('request.jwt.claims', :S2, false); set role authenticated;
select pg_temp.try('10 corrector corrects a test note', format('select public.correct_delivery_note(%L, %L::jsonb, %L)', (select v from ids where k='tpc'), '{"ral_code":"x"}', 'x'));
-- Admin deletes: test notes yes, real notes never
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select pg_temp.try('11 admin deletes a REAL note', format('select public.delete_test_delivery_note(%L)', (select id from public.delivery_notes where not is_test limit 1)));
select public.delete_test_delivery_note((select v from ids where k='tpc'));
insert into r select '12 test note + its history deleted', format('note=%s history=%s', (select count(*) from public.delivery_notes where id = (select v from ids where k='tpc')), (select count(*) from public.delivery_note_history where note_id = (select v from ids where k='tpc')));
-- Real notes keep their own rules and numbers
select pg_temp.try('13 real prepare still needs a check-out', format('select public.prepare_delivery_notes(%L, %L, %L, %L, %L::jsonb)', :HT, 'x', 'x', 'x', :NOTES));
reset role;
insert into r select '14 real notes untouched', ((select count(*) from public.delivery_notes where not is_test) = (select n from real_before))::text;
insert into r select '15 stock rows unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before) and (select sum(quantity) from public.inventory_transactions) = (select q from stock_before))::text;
insert into r select '16 all DN numbers', string_agg(dn_number, ', ' order by dn_number) from public.delivery_notes where dn_number is not null;
select k, v from r;
