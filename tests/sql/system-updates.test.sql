-- Database rules of supabase/sql/system_updates.sql, on a LOCAL Postgres
-- (never the live project). Run:
--   psql -d <empty db> -f tests/sql/supabase-base.sql      (stand-in auth + roles)
--   psql -d <same db> -f supabase/sql/system_updates.sql
--   psql -d <same db> -f tests/sql/system-updates.test.sql
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
\set X '''{"sub":"dddddddd-0000-0000-0000-00000000dead","role":"authenticated"}'''
-- Admin: draft with spoofed stamps, and a direct publish
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
with x as (insert into public.system_updates (title, category, summary, status, created_by, publisher_id, published_at, created_at)
  values ('[TEST] Kanban Stock View', 'new_feature', 'Users can now view inventory items as Kanban cards.', 'draft', gen_random_uuid(), gen_random_uuid(), '2020-01-01', '2020-01-01') returning id) insert into ids select 'draft', id from x;
insert into r select '1 admin creates draft; spoofed stamps ignored', format('status=%s created_by_admin=%s publisher=%s published_at=%s created_2020=%s', status, created_by = auth.uid(), coalesce(publisher_name,'-'), coalesce(published_at::text,'-'), created_at < '2021-01-01') from public.system_updates where id = (select v from ids where k='draft');
with x as (insert into public.system_updates (title, category, summary, status, version)
  values ('[TEST] Inventory Quantity Display', 'bug_fix', 'Fixed an issue that caused inventory quantities to display incorrectly after a stock adjustment.', 'published', '1.4') returning id) insert into ids select 'pub', id from x;
insert into r select '3 admin publishes directly', format('published_at set=%s publisher=%s', published_at is not null, publisher_name) from public.system_updates where id = (select v from ids where k='pub');
select pg_temp.try('bad category refused', $q$insert into public.system_updates (title, category, summary) values ('x','random','x')$q$);
select pg_temp.try('empty title refused', $q$insert into public.system_updates (title, category, summary) values ('  ','important','x')$q$);
-- Staff 1
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select '2 staff1 sees (drafts hidden)', string_agg(title, ' | ') from public.system_updates;
select pg_temp.try('9 staff1 creates/publishes an update', $q$insert into public.system_updates (title, category, summary, status) values ('x','important','x','published')$q$);
with u as (update public.system_updates set title='hacked', status='published' where true returning 1) insert into r select '9 staff1 edit/publish -> rows changed', count(*)::text from u;
with d as (delete from public.system_updates where true returning 1) insert into r select '9 staff1 delete -> rows deleted', count(*)::text from d;
insert into public.system_update_reads (update_id) values ((select v from ids where k='pub'));
insert into public.system_update_reads (update_id) values ((select v from ids where k='pub')) on conflict (update_id, user_id) do nothing;
insert into r select 'staff1 own read rows after marking twice', count(*)::text from public.system_update_reads;
select pg_temp.try('7 staff1 marks read FOR staff2', format('insert into public.system_update_reads (update_id, user_id) values (%L, %L)', (select v from ids where k='pub'), 'bbbbbbbb-0000-0000-0000-000000000002'));
select pg_temp.try('staff1 marks a DRAFT read', format('insert into public.system_update_reads (update_id) values (%L)', (select v from ids where k='draft')));
-- Staff 2
reset role; select set_config('request.jwt.claims', :S2, false); set role authenticated;
insert into r select '7 staff2 sees staff1 read rows', count(*)::text from public.system_update_reads;
insert into r select '6/7 staff2 unread count (staff1 read it)', count(*)::text from public.system_updates u where u.status='published' and not exists (select 1 from public.system_update_reads x where x.update_id=u.id);
with u as (update public.system_update_reads set is_read=false where true returning 1) insert into r select '7 staff2 changes others read rows', count(*)::text from u;
-- Switched-off and unknown accounts
reset role; select set_config('request.jwt.claims', :OFF, false); set role authenticated;
insert into r select 'switched-off account sees updates', count(*)::text from public.system_updates;
select pg_temp.try('switched-off account marks read', format('insert into public.system_update_reads (update_id) values (%L)', (select v from ids where k='pub')));
reset role; select set_config('request.jwt.claims', :X, false); set role authenticated;
insert into r select 'unknown account sees updates', count(*)::text from public.system_updates;
-- Visitor (anon)
reset role; set role anon;
select pg_temp.try('visitor reads updates', 'select count(*) from public.system_updates');
select pg_temp.try('visitor marks read', format('insert into public.system_update_reads (update_id, user_id) values (%L, %L)', (select v from ids where k='pub'), 'bbbbbbbb-0000-0000-0000-000000000001'));
-- Admin: publish draft, edit keeps stamps, unpublish, delete
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
update public.system_updates set status='published' where id=(select v from ids where k='draft');
insert into r select '3 admin publishes the draft', format('published_at set=%s by=%s', published_at is not null, publisher_name) from public.system_updates where id=(select v from ids where k='draft');
update public.system_updates set title='[TEST] Inventory Quantity Display (edited)', published_at='2000-01-01', publisher_id=gen_random_uuid(), created_by=gen_random_uuid() where id=(select v from ids where k='pub');
insert into r select 'admin edit keeps who/when', format('title=%s published_2000=%s publisher=%s created_by_admin=%s', title, published_at < '2001-01-01', publisher_name, created_by = auth.uid()) from public.system_updates where id=(select v from ids where k='pub');
update public.system_updates set status='draft' where id=(select v from ids where k='draft');
insert into r select 'admin moves back to draft', format('status=%s published_at=%s', status, coalesce(published_at::text,'-')) from public.system_updates where id=(select v from ids where k='draft');
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into r select 'staff1 sees after unpublish', string_agg(title, ' | ') from public.system_updates;
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
delete from public.system_updates where id=(select v from ids where k='pub');
reset role;
insert into r select 'read rows left after delete (cascade)', count(*)::text from public.system_update_reads;
-- changing your own read row to point at a draft is refused too
reset role; select set_config('request.jwt.claims', :A, false); set role authenticated;
with x as (insert into public.system_updates (title, category, summary, status) values ('[TEST] Scheduled System Maintenance', 'important', 'Save your work before the maintenance period.', 'published') returning id) insert into ids select 'pub2', id from x;
reset role; select set_config('request.jwt.claims', :S1, false); set role authenticated;
insert into public.system_update_reads (update_id) values ((select v from ids where k='pub2'));
select pg_temp.try('staff1 repoints own read row to a draft', format('update public.system_update_reads set update_id = %L where update_id = %L', (select v from ids where k='draft'), (select v from ids where k='pub2')));
reset role;
select k, v from r;
