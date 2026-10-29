-- supabase/sql/film_cutting_files.sql on a LOCAL Postgres (never the live
-- project). Run on a fresh db:
--   tests/sql/supabase-base.sql, tests/sql/storage-base.sql,
--   tests/sql/inventory-base.sql, supabase/sql/film_cutting.sql,
--   supabase/sql/film_cutting_open_to_staff.sql,
--   supabase/sql/film_cutting_files.sql, then this file.
\set ON_ERROR_STOP 1
create temp table r(k text, v text); grant all on r to authenticated, anon;
create function pg_temp.try(label text, stmt text) returns void language plpgsql as $$
begin execute stmt; insert into r values (label, 'UNEXPECTED: allowed');
exception when others then insert into r values (label, 'refused: ' || left(sqlerrm, 70)); end $$;
grant execute on function pg_temp.try(text,text) to authenticated, anon;
\set S1 '''{"sub":"bbbbbbbb-0000-0000-0000-000000000001","role":"authenticated"}'''
\set OFF '''{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}'''
\set H '''aaaa000000000000000000000000000000000000000000000000000000000001'''
\set H2 '''bbbb000000000000000000000000000000000000000000000000000000000002'''
\set PLAN '''{"job":"SSF2026-225","scope":"level","source_file_name":"SSF2026-225 ER AUH1.xlsx","source_file_hash":"aaaa000000000000000000000000000000000000000000000000000000000001","source_file_path":"aaaa000000000000000000000000000000000000000000000000000000000001.xlsx","calc_version":"film-cut-1","optimal":true,"settings":{},"totals":{"cuts":1},"plan":{"cuts":[{"id":"R001"}]}}'''
\set NOFILE '''{"job":"SSF2026-225","scope":"level","source_file_hash":"aaaa000000000000000000000000000000000000000000000000000000000001","calc_version":"film-cut-1","optimal":true,"settings":{},"totals":{"cuts":1},"plan":{"cuts":[{"id":"R001"}]}}'''
insert into r select '0 bucket', format('public=%s limit=%s', public, file_size_limit) from storage.buckets where id = 'film-cut-files';

reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
select pg_temp.try('1 approve pointing at a file not uploaded', format('select public.approve_film_cut_plan(%L::jsonb)', :PLAN));
insert into storage.objects (bucket_id, name) values ('film-cut-files', :H || '.xlsx');
insert into r select '2 staff uploads <sha256>.xlsx', 'ok';
select pg_temp.try('3 upload under another name', $q$insert into storage.objects (bucket_id, name) values ('film-cut-files', 'job list.xlsx')$q$);
select pg_temp.try('3b upload into another bucket', $q$insert into storage.objects (bucket_id, name) values ('transaction-documents', 'x.pdf')$q$);
-- No update / delete policy: such statements match no row (RLS), so they change nothing.
with u as (update storage.objects set owner = null where name = :H || '.xlsx' returning 1) insert into r select '4 replace a stored file: rows changed', count(*)::text from u;
with d as (delete from storage.objects where name = :H || '.xlsx' returning 1) insert into r select '5 delete a stored file: rows deleted', count(*)::text from d;
insert into r select '5b ... file still there', (select count(*) from storage.objects where bucket_id = 'film-cut-files')::text;
insert into r select '6 approve with the file', (public.approve_film_cut_plan(:PLAN) - 'id')::text;
insert into r select '6b plan keeps the path', source_file_path from public.film_cut_plans where version = 1;
select pg_temp.try('7 path that does not match the fingerprint', format('select public.approve_film_cut_plan(%L::jsonb)', replace(:PLAN, '"source_file_hash":"aaaa', '"source_file_hash":"bbbb')));
insert into r select '8 approve without a file (still allowed)', (public.approve_film_cut_plan(:NOFILE) - 'id')::text;
insert into r select '9 staff sees the file (signed link)', count(*)::text from storage.objects where bucket_id = 'film-cut-files';

reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select '10 switched-off sees files', count(*)::text from storage.objects where bucket_id = 'film-cut-files';
select pg_temp.try('10b switched-off uploads', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'film-cut-files', :H2 || '.xlsx'));
reset role; select set_config('request.jwt.claims', '{"role":"anon"}', false); set role anon;
insert into r select '11 anonymous sees files', count(*)::text from storage.objects where bucket_id = 'film-cut-files';
select pg_temp.try('11b anonymous uploads', format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'film-cut-files', :H2 || '.xlsx'));
reset role;
select k, v from r;
