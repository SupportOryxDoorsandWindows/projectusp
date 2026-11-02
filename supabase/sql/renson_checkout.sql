-- Renson Check-out -- ADMIN-ONLY PILOT (2026-11-02). Run AFTER
-- supabase/sql/renson_pilot.sql. Same one rule, renson_access() (Admin AND
-- the 'renson_pilot' flag on). Touches ONLY the Renson tables; the Freedom
-- inventory, its Check-out and its functions are not touched.
--
-- User's answers (2026-11-02), applied in the browser (renson.js) before the
-- lines reach this function: Renson bars without a code map by description;
-- "Pair" bars = 2 stock bars each; 2450 inner guiding rail metres / 6 rounded
-- up = bars; lines that are not Renson items (Freedom items such as 910010,
-- Box Sections) are left out; Renson stock MAY go below zero (like Freedom,
-- corrected by a later Check-in / stock count).
--
-- Tested on a local Postgres: tests/sql/supabase-base.sql +
-- tests/sql/inventory-base.sql + renson_pilot.sql + this file +
-- tests/sql/renson-pilot.test.sql + tests/sql/renson-checkout.test.sql.

-- Stock may go below zero now (was: never below zero).
alter table public.renson_items drop constraint if exists renson_items_current_qty_check;

alter table public.renson_transactions drop constraint if exists renson_transactions_type_check;
alter table public.renson_transactions add constraint renson_transactions_type_check
  check (type in ('opening_import', 'check_out'));
alter table public.renson_transactions
  add column if not exists job_number text,
  add column if not exists unit text,
  add column if not exists source text,
  add column if not exists document_name text,
  add column if not exists document_hash text;
create index if not exists renson_transactions_document_idx on public.renson_transactions (document_hash) where document_hash is not null;

-- p = {job_number, document_name, document_hash (SHA-256 of the job list PDF),
--      lines: [{item_code, qty, unit, source}]}  (one line per item code)
-- All or nothing; one Check-out per job list (same file twice = refused).
create or replace function public.renson_checkout(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_lines jsonb := p -> 'lines';
  v_job text := trim(coalesce(p ->> 'job_number', ''));
  v_hash text := coalesce(p ->> 'document_hash', '');
  v_n integer;
  e jsonb;
  v_code text; v_qty numeric;
  it record;
  v_total numeric := 0; v_below integer := 0;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if v_job = '' or length(v_job) > 60 then raise exception 'job_number_missing'; end if;
  if v_hash !~ '^[0-9a-f]{64}$' then raise exception 'document_hash_invalid'; end if;
  if jsonb_typeof(v_lines) is distinct from 'array' then raise exception 'lines_missing'; end if;
  v_n := jsonb_array_length(v_lines);
  if v_n < 1 or v_n > 500 then raise exception 'lines_count_out_of_range'; end if;
  if (select count(distinct upper(trim(x ->> 'item_code'))) from jsonb_array_elements(v_lines) x) <> v_n then
    raise exception 'duplicate_item_code';
  end if;

  lock table public.renson_items in share row exclusive mode;
  if exists (select 1 from public.renson_transactions where type = 'check_out' and document_hash = v_hash) then
    raise exception 'renson_job_list_already_checked_out';
  end if;
  for e in select * from jsonb_array_elements(v_lines) loop
    v_code := upper(trim(coalesce(e ->> 'item_code', '')));
    if jsonb_typeof(e -> 'qty') <> 'number' or (e ->> 'qty')::numeric <= 0 then raise exception 'qty_invalid: %', v_code; end if;
    if not exists (select 1 from public.renson_items where upper(item_code) = v_code) then
      raise exception 'not_a_renson_item: %', v_code;
    end if;
  end loop;

  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = v_uid;
  for e in select * from jsonb_array_elements(v_lines) loop
    v_code := upper(trim(e ->> 'item_code'));
    v_qty := (e ->> 'qty')::numeric;
    select id, item_code, current_qty, unit_cost, unit into it from public.renson_items where upper(item_code) = v_code;
    update public.renson_items set current_qty = current_qty - v_qty, updated_at = now() where id = it.id;
    insert into public.renson_transactions (item_id, item_code, type, quantity, unit_cost, value, qty_before, qty_after,
                                            reference, job_number, unit, source, document_name, document_hash,
                                            performed_by, performed_by_name)
    values (it.id, it.item_code, 'check_out', v_qty, it.unit_cost, round(v_qty * coalesce(it.unit_cost, 0), 2),
            it.current_qty, it.current_qty - v_qty, 'Check-out ' || v_job, v_job,
            coalesce(nullif(trim(e ->> 'unit'), ''), it.unit), left(e ->> 'source', 300),
            left(p ->> 'document_name', 300), v_hash, v_uid, v_name);
    v_total := v_total + round(v_qty * coalesce(it.unit_cost, 0), 2);
    if it.current_qty - v_qty < 0 then v_below := v_below + 1; end if;
  end loop;
  return jsonb_build_object('lines', v_n, 'total_value', v_total, 'below_zero', v_below);
end $$;
revoke all on function public.renson_checkout(jsonb) from public, anon;
grant execute on function public.renson_checkout(jsonb) to authenticated;
