-- Database rules of supabase/sql/delivery_notes.sql, on a LOCAL Postgres
-- (never the live project). Run:
--   psql -d <empty db> -f tests/sql/supabase-base.sql
--   psql -d <same db> -f tests/sql/inventory-base.sql
--   psql -d <same db> -f supabase/sql/delivery_notes.sql
--   psql -d <same db> -f tests/sql/delivery-notes.test.sql
-- Every row printed at the end must read as expected ("refused" where a
-- person must not be able to do it).
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
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
\set H '''aaaa000000000000000000000000000000000000000000000000000000000001'''
\set HNONE '''bbbb000000000000000000000000000000000000000000000000000000000002'''
-- One saved Check-out with job list H (what checkout_transaction leaves behind).
insert into public.inventory_transactions (type, job_number, client, quantity, source_document_hash) values ('check_out', '26371F', 'Monique Hageman', 3, :H);
create temp table stock_before as select count(*) n, sum(quantity) q from public.inventory_transactions;
\set NOTES '''[{"kind":"powder_coating","delivery_address":"ALUMETAL","contact_no":"+971 526648991","lines":[{"description":"HOUSING","qty":3},{"description":"COMPONENTS","qty":12}],"flags":["No RAL code on the job list"]},{"kind":"finished_goods","contact_no":"+971 526648991","lines":[{"description":"D01A - Fusion Series 2 Sliding Door\\nFREEDOM ZLX 80 - RIGHT","qty":1,"comments":"15X30, 20X40 Box section"}]}]'''

-- Staff 1 prepares (twice: the second makes nothing new)
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '1 prepare after check-out', public.prepare_delivery_notes(:H, '26371F', 'Monique Hageman', 'x.pdf', :NOTES)::text;
insert into r select '2 prepare again (no duplicates)', public.prepare_delivery_notes(:H, '26371F', 'Monique Hageman', 'x.pdf', :NOTES)::text;
insert into r select '2b notes for this job list', count(*)::text from public.delivery_notes where source_document_hash = :H;
select pg_temp.try('3 prepare for a job list never checked out', format('select public.prepare_delivery_notes(%L, %L, %L, %L, %L::jsonb)', :HNONE, 'x', 'x', 'x', :NOTES));
select pg_temp.try('3b prepare with a bad line (qty 0)', format('select public.prepare_delivery_notes(%L, %L, %L, %L, %L::jsonb)', :H, 'x', 'x', 'x', '[{"kind":"finished_goods","lines":[{"description":"x","qty":0}]}]'));
select pg_temp.try('4 staff writes the table directly', $q$update public.delivery_notes set dn_number = 'DN-HACK' where true$q$);
select pg_temp.try('4b staff inserts directly', format('insert into public.delivery_notes (kind, source_document_hash, job_number) values (%L, %L, %L)', 'finished_goods', :HNONE, 'x'));
insert into ids select 'pc', id from public.delivery_notes where kind = 'powder_coating';
insert into ids select 'fg', id from public.delivery_notes where kind = 'finished_goods';
insert into r select '5 prepared pc note', format('dn=%s address=%s customer=%s lines=%s flags=%s by=%s', coalesce(dn_number,'-'), delivery_address, customer_ref, jsonb_array_length(lines), jsonb_array_length(flags), created_by_name) from public.delivery_notes where id = (select v from ids where k='pc');
select pg_temp.try('6 confirm pc without RAL / driver / date', format('select public.confirm_delivery_note(%L, %L::jsonb)', (select v from ids where k='pc'), '{}'));
select public.save_delivery_note((select v from ids where k='pc'), '{"ral_code":"REL7006M SD3000700634","delivered_by":"Ashok","lines":[{"description":"HOUSING","qty":4},{"description":"COMPONENTS","qty":12}]}');
select pg_temp.try('7 bad date refused', format('select public.save_delivery_note(%L, %L::jsonb)', (select v from ids where k='pc'), '{"delivery_date":"27/13/2026"}'));
insert into r select '8 confirm pc', format('dn=%s by=%s qty1=%s', dn_number, confirmed_by_name, lines->0->>'qty') from public.confirm_delivery_note((select v from ids where k='pc'), '{"delivery_date":"2026-10-27"}');
select pg_temp.try('9 edit a confirmed note as staff', format('select public.save_delivery_note(%L, %L::jsonb)', (select v from ids where k='pc'), '{"ral_code":"x"}'));
select pg_temp.try('9b confirm twice', format('select public.confirm_delivery_note(%L, %L::jsonb)', (select v from ids where k='pc'), '{}'));
select pg_temp.try('10 staff corrects (not a corrector)', format('select public.correct_delivery_note(%L, %L::jsonb, %L)', (select v from ids where k='pc'), '{"ral_code":"x"}', 'typo'));
select pg_temp.try('10b staff makes self a corrector', format('select public.set_delivery_note_corrector(%L, true)', 'bbbbbbbb-0000-0000-0000-000000000001'));
insert into r select '11 confirm fg (address typed)', dn_number from public.confirm_delivery_note((select v from ids where k='fg'), '{"delivery_address":"Warehouse","delivered_by":"Charles Felimon","delivery_date":"2026-10-28"}');
-- Admin makes Staff 2 a corrector; Staff 2 corrects
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
select public.set_delivery_note_corrector('bbbbbbbb-0000-0000-0000-000000000002', true);
reset role; select set_config('request.jwt.claims', :S2, false); set role authenticated;
select pg_temp.try('12 corrector without a reason', format('select public.correct_delivery_note(%L, %L::jsonb, %L)', (select v from ids where k='pc'), '{"ral_code":"x"}', '  '));
select pg_temp.try('12b corrector empties the RAL code', format('select public.correct_delivery_note(%L, %L::jsonb, %L)', (select v from ids where k='pc'), '{"ral_code":""}', 'oops'));
insert into r select '13 corrector corrects', format('dn=%s ral=%s corrected=%s', dn_number, ral_code, corrected_count) from public.correct_delivery_note((select v from ids where k='pc'), '{"ral_code":"REL7006M SD3000700635"}', 'Wrong powder code');
insert into r select '14 history kept', string_agg(action || coalesce(':' || reason, '') || coalesce(' before_ral=' || (before->>'ral_code'), ''), ' | ' order by created_at, action) from public.delivery_note_history where note_id = (select v from ids where k='pc');
-- Admin corrects too
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '15 admin corrects', format('corrected=%s', corrected_count) from public.correct_delivery_note((select v from ids where k='fg'), '{"lines":[{"description":"INFINITY","qty":1}]}', 'Name as on old notes');
-- Switched-off account and anonymous
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '16 switched-off account reads', count(*)::text from public.delivery_notes;
select pg_temp.try('16b switched-off account prepares', format('select public.prepare_delivery_notes(%L, %L, %L, %L, %L::jsonb)', :H, 'x', 'x', 'x', :NOTES));
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('17 anonymous reads', 'select count(*) from public.delivery_notes');
select pg_temp.try('17b anonymous confirms', format('select public.confirm_delivery_note(%L, %L::jsonb)', (select v from ids where k='fg'), '{}'));
reset role;
insert into r select '18 stock rows unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before) and (select sum(quantity) from public.inventory_transactions) = (select q from stock_before))::text;
insert into r select '19 DN numbers', string_agg(dn_number, ', ' order by dn_number) from public.delivery_notes;
select k, v from r;
