-- Film Cutting: keep the original job-list Excel with each approved plan
-- (user's request 2026-10-29). Run after film_cutting.sql (and
-- film_cutting_open_to_staff.sql). New things only; nothing about stock.
--
--   * PRIVATE Storage bucket "film-cut-files" (Excel only, 10 MB). A file is
--     stored as <sha256>.<xlsx|xlsm|xls> -- the same fingerprint the plan
--     keeps in source_file_hash -- so one file belongs to the plans made
--     from it, and the same file is stored once.
--   * Whoever may use Film Cutting (film_cut_access()) may upload a file
--     there and open it through a short-lived signed link. Nobody can
--     replace or delete a stored file from the site (no update / delete
--     policy), and nothing deletes them automatically.
--   * film_cut_plans.source_file_path: set by approve_film_cut_plan() only
--     when that file really is in the bucket and its name is the plan's
--     fingerprint. The browser computes the fingerprint before uploading.
--
-- Go back: drop the two storage policies below and the column, and run the
-- approve_film_cut_plan() of film_cutting.sql again (stored files stay
-- until deleted in the Storage screen).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('film-cut-files', 'film-cut-files', false, 10485760, array[
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Film Cutting reads its files" on storage.objects;
create policy "Film Cutting reads its files" on storage.objects
  for select to authenticated
  using (bucket_id = 'film-cut-files' and (select public.film_cut_access()));

drop policy if exists "Film Cutting adds its files" on storage.objects;
create policy "Film Cutting adds its files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'film-cut-files' and (select public.film_cut_access())
    and name ~ '^[0-9a-f]{64}\.(xlsx|xlsm|xls)$');

alter table public.film_cut_plans add column if not exists source_file_path text
  check (source_file_path ~ '^[0-9a-f]{64}\.(xlsx|xlsm|xls)$');

-- p_plan as before + optional source_file_path ("<sha256>.xlsx").
create or replace function public.approve_film_cut_plan(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int; new_id uuid; who text; j text; fpath text;
begin
  if not (select public.film_cut_access()) then raise exception 'not_allowed'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then raise exception 'plan_invalid'; end if;
  j := nullif(trim(p_plan->>'job'), '');
  if j is null then raise exception 'job_missing'; end if;
  if jsonb_typeof(p_plan->'plan') <> 'object' or jsonb_typeof(p_plan->'plan'->'cuts') <> 'array'
     or jsonb_array_length(p_plan->'plan'->'cuts') = 0 then raise exception 'cuts_missing'; end if;
  if pg_column_size(p_plan) > 3000000 then raise exception 'plan_too_big'; end if;
  fpath := nullif(p_plan->>'source_file_path', '');
  if fpath is not null then
    if fpath !~ '^[0-9a-f]{64}\.(xlsx|xlsm|xls)$' or split_part(fpath, '.', 1) is distinct from p_plan->>'source_file_hash'
       or not exists (select 1 from storage.objects where bucket_id = 'film-cut-files' and name = fpath) then
      raise exception 'file_not_stored';
    end if;
  end if;
  who := public.film_cut_actor_name();
  -- next version of this job (one at a time per job)
  perform pg_advisory_xact_lock(hashtext('film_cut:' || left(j, 120)));
  select coalesce(max(version), 0) + 1 into v from public.film_cut_plans where job = left(j, 120);
  insert into public.film_cut_plans (job, version, scope, level, source_file_name, source_file_hash, source_file_path, sheet, calc_version,
      optimal, settings, totals, plan, note, approved_by, approved_by_name)
    values (left(j, 120), v, p_plan->>'scope', nullif(p_plan->>'level', ''), left(p_plan->>'source_file_name', 300),
      nullif(p_plan->>'source_file_hash', ''), fpath, left(p_plan->>'sheet', 120), left(coalesce(p_plan->>'calc_version', '?'), 40),
      coalesce((p_plan->>'optimal')::boolean, false), coalesce(p_plan->'settings', '{}'::jsonb), coalesce(p_plan->'totals', '{}'::jsonb),
      p_plan->'plan', left(nullif(trim(p_plan->>'note'), ''), 2000), (select auth.uid()), who)
    returning id into new_id;
  insert into public.film_cut_log (action, job, plan_id, details, by_id, by_name)
    values ('approved', left(j, 120), new_id, jsonb_build_object('version', v, 'scope', p_plan->>'scope', 'level', p_plan->>'level',
      'film_m2', p_plan->'totals'->'film', 'cuts', p_plan->'totals'->'cuts', 'file_kept', fpath is not null), (select auth.uid()), who);
  return jsonb_build_object('id', new_id, 'version', v, 'approved_by_name', who, 'file_kept', fpath is not null);
end $$;
