-- Film Cutting (Admins only, user's request 2026-10-28): approved cutting
-- plans for smart film and a record of who did what.
--
-- New tables and functions only; nothing existing is changed. Nothing here
-- touches stock, Master Inventory or any other table.
--
-- Who may use it: ONE rule, film_cut_access() (today = is_admin()). Every
-- read policy and every function asks it, so opening the feature to another
-- group later is a change to that one function. No write policies: plans
-- and the log are written only through the functions below.
--
--   approve_film_cut_plan(...)  saves an approved plan as the next version of
--                               its job (v1, v2...), with who / when, the
--                               settings, the calculator version, every cut
--                               with its panel IDs, and the uploaded file's
--                               name + SHA-256 (the file itself is not kept)
--   log_film_cut(action, ...)   the record: 'imported', 'calculated',
--                               'approved' (written by approve), 'exported'
--
-- Go back: supabase/sql/film_cutting_rollback.sql (drops only what this
-- file creates).

create table if not exists public.film_cut_plans (
  id uuid primary key default gen_random_uuid(),
  job text not null check (length(job) between 1 and 120),
  version integer not null check (version > 0),
  status text not null default 'approved' check (status in ('approved')),
  scope text not null check (scope in ('level', 'whole', 'location')),
  level text,
  source_file_name text check (length(source_file_name) <= 300),
  source_file_hash text check (source_file_hash ~ '^[0-9a-f]{64}$'),
  sheet text check (length(sheet) <= 120),
  calc_version text not null check (length(calc_version) <= 40),
  optimal boolean not null,
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  totals jsonb not null check (jsonb_typeof(totals) = 'object'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  note text check (length(note) <= 2000),
  approved_by uuid references auth.users (id) on delete set null,
  approved_by_name text,
  approved_at timestamptz not null default now(),
  unique (job, version)
);
comment on table public.film_cut_plans is
  'Approved smart-film cutting plans (Film Cutting page, Admins only). Written only by approve_film_cut_plan(). Never linked to stock.';

create table if not exists public.film_cut_log (
  id bigint generated always as identity primary key,
  action text not null check (action in ('imported', 'calculated', 'approved', 'exported')),
  job text check (length(job) <= 120),
  plan_id uuid references public.film_cut_plans (id) on delete set null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  by_id uuid references auth.users (id) on delete set null,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists film_cut_log_created on public.film_cut_log (created_at desc);
comment on table public.film_cut_log is
  'Who imported / calculated / approved / exported on the Film Cutting page. Written only through log_film_cut() / approve_film_cut_plan().';

-- The one access rule (Admins only for now).
create or replace function public.film_cut_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select public.is_admin());
$$;

alter table public.film_cut_plans enable row level security;
alter table public.film_cut_log enable row level security;
revoke all on public.film_cut_plans, public.film_cut_log from anon;
revoke all on public.film_cut_plans, public.film_cut_log from authenticated;
grant select on public.film_cut_plans, public.film_cut_log to authenticated;

drop policy if exists film_cut_plans_read on public.film_cut_plans;
create policy film_cut_plans_read on public.film_cut_plans
  for select to authenticated using ((select public.film_cut_access()));
drop policy if exists film_cut_log_read on public.film_cut_log;
create policy film_cut_log_read on public.film_cut_log
  for select to authenticated using ((select public.film_cut_access()));

create or replace function public.film_cut_actor_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(trim(full_name), ''), email) from public.user_profiles where user_id = (select auth.uid());
$$;

-- p_plan: {job, scope, level, source_file_name, source_file_hash, sheet,
--          calc_version, optimal, settings{}, totals{}, plan{}, note}
create or replace function public.approve_film_cut_plan(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int; new_id uuid; who text; j text;
begin
  if not (select public.film_cut_access()) then raise exception 'not_allowed'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then raise exception 'plan_invalid'; end if;
  j := nullif(trim(p_plan->>'job'), '');
  if j is null then raise exception 'job_missing'; end if;
  if jsonb_typeof(p_plan->'plan') <> 'object' or jsonb_typeof(p_plan->'plan'->'cuts') <> 'array'
     or jsonb_array_length(p_plan->'plan'->'cuts') = 0 then raise exception 'cuts_missing'; end if;
  if pg_column_size(p_plan) > 3000000 then raise exception 'plan_too_big'; end if;
  who := public.film_cut_actor_name();
  -- next version of this job (one at a time per job)
  perform pg_advisory_xact_lock(hashtext('film_cut:' || left(j, 120)));
  select coalesce(max(version), 0) + 1 into v from public.film_cut_plans where job = left(j, 120);
  insert into public.film_cut_plans (job, version, scope, level, source_file_name, source_file_hash, sheet, calc_version,
      optimal, settings, totals, plan, note, approved_by, approved_by_name)
    values (left(j, 120), v, p_plan->>'scope', nullif(p_plan->>'level', ''), left(p_plan->>'source_file_name', 300),
      nullif(p_plan->>'source_file_hash', ''), left(p_plan->>'sheet', 120), left(coalesce(p_plan->>'calc_version', '?'), 40),
      coalesce((p_plan->>'optimal')::boolean, false), coalesce(p_plan->'settings', '{}'::jsonb), coalesce(p_plan->'totals', '{}'::jsonb),
      p_plan->'plan', left(nullif(trim(p_plan->>'note'), ''), 2000), (select auth.uid()), who)
    returning id into new_id;
  insert into public.film_cut_log (action, job, plan_id, details, by_id, by_name)
    values ('approved', left(j, 120), new_id, jsonb_build_object('version', v, 'scope', p_plan->>'scope', 'level', p_plan->>'level',
      'film_m2', p_plan->'totals'->'film', 'cuts', p_plan->'totals'->'cuts'), (select auth.uid()), who);
  return jsonb_build_object('id', new_id, 'version', v, 'approved_by_name', who);
end $$;

create or replace function public.log_film_cut(p_action text, p_job text, p_plan_id uuid, p_details jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.film_cut_access()) then raise exception 'not_allowed'; end if;
  if p_action not in ('imported', 'calculated', 'exported') then raise exception 'action_invalid'; end if;
  if p_details is not null and (jsonb_typeof(p_details) <> 'object' or pg_column_size(p_details) > 20000) then raise exception 'details_invalid'; end if;
  if p_plan_id is not null and not exists (select 1 from public.film_cut_plans where id = p_plan_id) then raise exception 'plan_unknown'; end if;
  insert into public.film_cut_log (action, job, plan_id, details, by_id, by_name)
    values (p_action, left(nullif(trim(p_job), ''), 120), p_plan_id, coalesce(p_details, '{}'::jsonb), (select auth.uid()), public.film_cut_actor_name());
end $$;

revoke all on function public.film_cut_access(), public.film_cut_actor_name(),
  public.approve_film_cut_plan(jsonb), public.log_film_cut(text, text, uuid, jsonb) from public, anon;
grant execute on function public.film_cut_access(), public.approve_film_cut_plan(jsonb),
  public.log_film_cut(text, text, uuid, jsonb) to authenticated;
