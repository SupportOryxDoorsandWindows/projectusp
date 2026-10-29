-- supabase/sql/film_cutting_open_to_staff.sql on a LOCAL Postgres (never
-- the live project). Run after tests/sql/film-cutting.test.sql on the same db:
--   psql -d <same db> -f supabase/sql/film_cutting_open_to_staff.sql
--   psql -d <same db> -f tests/sql/film-cutting-open-to-staff.test.sql
-- Active staff may now read, approve and log; switched-off accounts and
-- anonymous visitors still may not; direct writes stay refused.
\set ON_ERROR_STOP 1
create temp table r2(k text, v text); grant all on r2 to authenticated, anon;
create function pg_temp.try2(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r2 values (label, 'UNEXPECTED: allowed');
exception when others then insert into r2 values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try2(text,text) to authenticated, anon;
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
\set PLAN '''{"job":"SSF2026-225","scope":"level","calc_version":"film-cut-1","optimal":true,"settings":{},"totals":{"cuts":1},"plan":{"cuts":[{"id":"R001"}]}}'''
create temp table stock_before2 as select count(*) n, coalesce(sum(quantity), 0) q from public.inventory_transactions;
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r2 select '1 staff reads plans (2 from the Admin test)', count(*)::text from public.film_cut_plans;
insert into r2 select '2 staff approves = next version', (public.approve_film_cut_plan(:PLAN) - 'id')::text;
select public.log_film_cut('exported', 'SSF2026-225', null, '{}');
insert into r2 select '3 staff record', string_agg(action || ' by ' || by_name, ', ' order by id) from public.film_cut_log where by_name = 'Staff One';
select pg_temp.try2('4 staff writes directly', $q$update public.film_cut_plans set job = 'X' where true$q$);
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r2 select '5 switched-off reads', count(*)::text from public.film_cut_plans;
select pg_temp.try2('5b switched-off approves', format('select public.approve_film_cut_plan(%L::jsonb)', :PLAN));
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try2('6 anonymous reads', 'select count(*) from public.film_cut_plans');
reset role;
insert into r2 select '7 stock unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before2))::text;
select k, v from r2;
