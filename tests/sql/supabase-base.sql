-- A minimal stand-in for the Supabase pieces the SQL files rely on (roles
-- anon/authenticated, auth.users, auth.uid() from request.jwt.claims,
-- user_profiles, is_admin(), is_active_staff() -- copied from the live
-- project 2026-10-14), for testing SQL on a LOCAL Postgres only.
create extension if not exists pgcrypto;
create role anon nologin; create role authenticated nologin;
create schema auth; grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create table public.user_profiles (user_id uuid primary key references auth.users(id), email text, full_name text, role text, can_delete boolean default false, active boolean default true);
alter table public.user_profiles enable row level security;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  select exists (select 1 from public.user_profiles where user_id = auth.uid() and role = 'admin' and active); $function$;
CREATE OR REPLACE FUNCTION public.is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  select exists (select 1 from public.user_profiles where user_id = (select auth.uid()) and active); $function$;
grant execute on function public.is_admin(), public.is_active_staff() to authenticated;
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'),('bbbbbbbb-0000-0000-0000-000000000001'),('bbbbbbbb-0000-0000-0000-000000000002'),('cccccccc-0000-0000-0000-000000000001');
insert into public.user_profiles values
 ('aaaaaaaa-0000-0000-0000-000000000001','admin@x','Lharyl','admin',true,true),
 ('bbbbbbbb-0000-0000-0000-000000000001','s1@x','Staff One','user',false,true),
 ('bbbbbbbb-0000-0000-0000-000000000002','s2@x','Staff Two','user',false,true),
 ('cccccccc-0000-0000-0000-000000000001','off@x','Switched Off','user',false,false);
