-- Database rules of supabase/sql/film_cutting.sql, on a LOCAL Postgres
-- (never the live project). Run:
--   psql -d <empty db> -f tests/sql/supabase-base.sql
--   psql -d <same db> -f tests/sql/inventory-base.sql
--   psql -d <same db> -f supabase/sql/film_cutting.sql
--   psql -d <same db> -f tests/sql/film-cutting.test.sql
--   (then film_cutting_rollback.sql must leave nothing behind)
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
\set PLAN '''{"job":"SSF2026-225","scope":"level","level":"Level 5","source_file_name":"SSF2026-225 ER AUH1.xlsx","source_file_hash":"aaaa000000000000000000000000000000000000000000000000000000000001","sheet":"ETIHAD RAIL","calc_version":"film-cut-1","optimal":true,"settings":{"blade":1},"totals":{"film":218.933,"cuts":64},"plan":{"cuts":[{"id":"L5-001","W":1000,"L":2680,"pieces":["P066"]}]}}'''
create temp table stock_before as select count(*) n, coalesce(sum(quantity), 0) q from public.inventory_transactions;
create temp table items_before as select md5(string_agg(t::text, '|' order by id)) h from public.inventory_items t;

-- Admin: approve twice (v1, v2), log an export
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '1 admin approves', (public.approve_film_cut_plan(:PLAN) - 'id')::text;
insert into r select '2 admin approves again = next version', (public.approve_film_cut_plan(:PLAN) - 'id')::text;
select public.log_film_cut('exported', 'SSF2026-225', (select id from public.film_cut_plans where version = 1), '{"file":"x.xlsx"}');
select public.log_film_cut('calculated', 'SSF2026-225', null, '{"scope":"level"}');
insert into r select '3 admin reads plans', count(*)::text from public.film_cut_plans;
insert into r select '4 admin reads the record', string_agg(action || ' by ' || by_name, ', ' order by id) from public.film_cut_log;
select pg_temp.try('5 approve with no cuts', format('select public.approve_film_cut_plan(%L::jsonb)', '{"job":"X","scope":"level","optimal":true,"settings":{},"totals":{},"plan":{"cuts":[]}}'));
select pg_temp.try('5b approve with no job', format('select public.approve_film_cut_plan(%L::jsonb)', '{"job":" ","scope":"level","plan":{"cuts":[{}]}}'));
select pg_temp.try('5c approve with a bad scope', format('select public.approve_film_cut_plan(%L::jsonb)', '{"job":"X","scope":"room","optimal":true,"settings":{},"totals":{},"plan":{"cuts":[{}]}}'));
select pg_temp.try('5d log a made-up action', $q$select public.log_film_cut('approved', 'X', null, '{}')$q$);
select pg_temp.try('6 admin edits a saved plan directly', $q$update public.film_cut_plans set job = 'X' where true$q$);
select pg_temp.try('6b admin deletes the record directly', $q$delete from public.film_cut_log where true$q$);

-- Staff (not Admin): sees nothing, can do nothing
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '7 staff reads plans', count(*)::text from public.film_cut_plans;
insert into r select '7b staff reads the record', count(*)::text from public.film_cut_log;
select pg_temp.try('8 staff approves', format('select public.approve_film_cut_plan(%L::jsonb)', :PLAN));
select pg_temp.try('8b staff logs', $q$select public.log_film_cut('exported', 'X', null, '{}')$q$);
select pg_temp.try('8c staff inserts directly', $q$insert into public.film_cut_plans (job, version, scope, calc_version, optimal, settings, totals, plan) values ('X', 9, 'level', 'x', true, '{}', '{}', '{}')$q$);

-- Switched-off account and anonymous
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '9 switched-off reads', count(*)::text from public.film_cut_plans;
select pg_temp.try('9b switched-off approves', format('select public.approve_film_cut_plan(%L::jsonb)', :PLAN));
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('10 anonymous reads', 'select count(*) from public.film_cut_plans');
select pg_temp.try('10b anonymous approves', format('select public.approve_film_cut_plan(%L::jsonb)', :PLAN));
reset role;
insert into r select '11 stock and items unchanged', ((select count(*) from public.inventory_transactions) = (select n from stock_before)
  and (select coalesce(sum(quantity), 0) from public.inventory_transactions) = (select q from stock_before)
  and (select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) is not distinct from (select h from items_before))::text;
select k, v from r;
