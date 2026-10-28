-- Go back from supabase/sql/film_cutting.sql: removes ONLY what it created
-- (saved cutting plans and the Film Cutting record are deleted with it).
-- Nothing else uses these objects. Run in the Supabase SQL Editor.
drop function if exists public.log_film_cut(text, text, uuid, jsonb);
drop function if exists public.approve_film_cut_plan(jsonb);
drop function if exists public.film_cut_actor_name();
drop table if exists public.film_cut_log;
drop table if exists public.film_cut_plans;
drop function if exists public.film_cut_access();
