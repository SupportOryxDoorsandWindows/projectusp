-- Database rules of supabase/sql/renson_release.sql, on a LOCAL Postgres
-- (never the live project). Run after renson-workflow.test.sql:
--   psql -d <same db> -f supabase/sql/renson_release.sql   (twice: no change the 2nd time)
--   psql -d <same db> -f tests/sql/renson-release.test.sql
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 60)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set A '''{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}'''
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
create temp table items_before as select md5(string_agg(t::text, '|' order by id)) h, (select count(*) from public.inventory_transactions) n from public.inventory_items t;

-- Staff (active, not Admin): sees and works Renson like Freedom
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '1 staff: renson_access', public.renson_access()::text;
insert into r select '1b staff reads items', (count(*) > 0)::text from public.renson_items;
insert into r select '1c staff reads movements', (count(*) > 0)::text from public.renson_transactions;
insert into r select '1d staff adjusts', (public.renson_adjust('{"item_code":"22874","mode":"add","qty":1,"reason":"release test"}') ->> 'change');
insert into r select '1e staff checks out', (public.renson_checkout('{"job_number":"REL-1","lines":[{"item_code":"22874","qty":1}]}') ->> 'lines');
insert into r select '1f staff checks in', (public.renson_checkin('{"supplier":"Renson NV","currency":"AED","document_hash":"cccc000000000000000000000000000000000000000000000000000000000001","lines":[{"item_code":"22874","qty":1,"original_unit_cost":100}]}') ->> 'lines');
insert into r select '1g staff name stamped', string_agg(distinct performed_by_name, ',') from public.renson_transactions where reference ilike '%release%' or job_number = 'REL-1' or document_hash like 'cccc%';
select pg_temp.try('1h staff sets Kanban levels', $q$select public.renson_set_levels('22874', 5, 2)$q$);
select pg_temp.try('1i staff imports', $q$select public.renson_import_stock('{"items":[]}')$q$);
select pg_temp.try('1j staff resets', $q$select public.renson_reset_pilot('RESET RENSON')$q$);

-- Switched-off account and anon: nothing
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '2 inactive: renson_access', public.renson_access()::text;
insert into r select '2b inactive reads items', count(*)::text from public.renson_items;
select pg_temp.try('2c inactive adjusts', $q$select public.renson_adjust('{"item_code":"22874","mode":"add","qty":1,"reason":"x"}')$q$);
reset role; select set_config('request.jwt.claims', '', false); set role anon;
select pg_temp.try('2d anon reads', $q$select count(*) from public.renson_items$q$);

-- Admin: still sets Kanban levels
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '3 admin sets levels', public.renson_set_levels('22874', 5, 2)::text;
select pg_temp.try('3b admin import refused (opening stock exists)', $q$select public.renson_import_stock('{"items":[]}')$q$);

-- Flag off: nobody, Admin included
reset role; update public.app_feature_flags set enabled = false where key = 'renson_pilot';
select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '4 flag off: staff access', public.renson_access()::text;
insert into r select '4b flag off: staff reads', count(*)::text from public.renson_items;
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
insert into r select '4c flag off: admin access', public.renson_access()::text;
reset role; update public.app_feature_flags set enabled = true where key = 'renson_pilot';

insert into r select '5 Freedom items and transactions unchanged', ((select md5(string_agg(t::text, '|' order by id)) from public.inventory_items t) is not distinct from (select h from items_before)
  and (select count(*) from public.inventory_transactions) = (select n from items_before))::text;
select k, v from r;
