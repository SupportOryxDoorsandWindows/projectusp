-- Renson full workflow -- ADMIN-ONLY PILOT (2026-11-02, user: "the same
-- workflow as Freedom ... operate separately"). Run AFTER renson_pilot.sql and
-- renson_checkout.sql. Same one rule, renson_access() (Admin AND the
-- 'renson_pilot' flag on). Renson tables ONLY; no Freedom table, function or
-- permission is touched.
--
--  - renson_checkin(jsonb): Check-in, the same cost rule as Freedom
--    (checkin_weighted_average.sql): unit_cost = (stock x old cost + received
--    x price paid) / (stock + received); no stock (<= 0) or no cost on file =
--    the price paid; no price on the document = the item's own cost. Price
--    paid (AED) = (supplier unit price + the line's share of shipping / qty)
--    x exchange rate, worked out HERE (the browser only shows the same sum).
--    A line may add a NEW Renson item. One Check-in per document (SHA-256),
--    when a document is given.
--  - renson_adjust(jsonb): stock count / add / take out, reason required
--    (like Freedom's Adjust dialog); add may carry a cost (averaged in).
--  - renson_set_levels(text, numeric, numeric): Kanban trigger / critical
--    level, the same rule as Freedom's set_item_kanban_levels.
--  - renson_checkout(jsonb) replaced: a document is now optional (hand-typed
--    Check-out lines, like Freedom's manual entry); with a document, still
--    once per job list.
--
-- Tested on a local Postgres: tests/sql/supabase-base.sql +
-- tests/sql/inventory-base.sql + renson_pilot.sql + renson_checkout.sql +
-- this file + tests/sql/renson-workflow.test.sql.

alter table public.renson_items
  add column if not exists buffer_level numeric,
  add column if not exists critical_level numeric,
  add column if not exists levels_updated_at timestamptz,
  add column if not exists levels_updated_by_name text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'renson_items_levels_check') then
    alter table public.renson_items add constraint renson_items_levels_check check (
      (buffer_level is null or buffer_level > 0)
      and (critical_level is null or (buffer_level is not null and critical_level > 0 and critical_level < buffer_level)));
  end if;
end $$;

alter table public.renson_transactions drop constraint if exists renson_transactions_type_check;
alter table public.renson_transactions add constraint renson_transactions_type_check
  check (type in ('opening_import', 'check_out', 'check_in', 'adjustment'));
alter table public.renson_transactions
  add column if not exists supplier text,
  add column if not exists invoice_number text,
  add column if not exists po_number text,
  add column if not exists document_date date,
  add column if not exists original_currency text,
  add column if not exists original_unit_cost numeric,
  add column if not exists exchange_rate numeric,
  add column if not exists shipping_allocated numeric,
  add column if not exists unit_cost_before numeric,
  add column if not exists unit_cost_after numeric,
  add column if not exists is_new_item boolean not null default false,
  add column if not exists reason text;

-- ------------------------------------------------------------ Check-in
-- p = {supplier, invoice_number, po_number, document_date, currency,
--      exchange_rate (AED per 1 unit; 1 for AED), document_name,
--      document_hash (optional), lines: [{item_code, qty, original_unit_cost,
--      shipping_allocated (document currency, whole line), new_item:
--      {description, unit, product_size, colour, alt_codes} (only for a code
--      that is not a Renson item yet)}]}
create or replace function public.renson_checkin(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_lines jsonb := p -> 'lines';
  v_supplier text := trim(coalesce(p ->> 'supplier', ''));
  v_cur text := upper(trim(coalesce(p ->> 'currency', 'AED')));
  v_rate numeric;
  v_hash text := nullif(p ->> 'document_hash', '');
  v_date date;
  v_n integer;
  e jsonb;
  v_code text; v_qty numeric; v_orig numeric; v_ship numeric; v_cost numeric; v_avg numeric;
  v_new boolean;
  it record;
  v_total numeric := 0; v_created integer := 0;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if v_supplier = '' or length(v_supplier) > 120 then raise exception 'supplier_missing'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'currency_invalid'; end if;
  if jsonb_typeof(p -> 'exchange_rate') = 'number' then v_rate := (p ->> 'exchange_rate')::numeric; end if;
  if v_cur = 'AED' then v_rate := 1; end if;
  if v_rate is null or v_rate <= 0 or v_rate > 10000 then raise exception 'exchange_rate_invalid'; end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then raise exception 'document_hash_invalid'; end if;
  if nullif(p ->> 'document_date', '') is not null then
    if (p ->> 'document_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'document_date_invalid'; end if;
    v_date := (p ->> 'document_date')::date;
  end if;
  if jsonb_typeof(v_lines) is distinct from 'array' then raise exception 'lines_missing'; end if;
  v_n := jsonb_array_length(v_lines);
  if v_n < 1 or v_n > 500 then raise exception 'lines_count_out_of_range'; end if;
  if (select count(distinct upper(trim(x ->> 'item_code'))) from jsonb_array_elements(v_lines) x) <> v_n then
    raise exception 'duplicate_item_code';
  end if;

  lock table public.renson_items in share row exclusive mode;
  if v_hash is not null and exists (select 1 from public.renson_transactions where type = 'check_in' and document_hash = v_hash) then
    raise exception 'renson_document_already_checked_in';
  end if;
  for e in select * from jsonb_array_elements(v_lines) loop
    v_code := upper(trim(coalesce(e ->> 'item_code', '')));
    if v_code = '' or length(v_code) > 60 then raise exception 'item_code_invalid'; end if;
    if jsonb_typeof(e -> 'qty') <> 'number' or (e ->> 'qty')::numeric <= 0 then raise exception 'qty_invalid: %', v_code; end if;
    if jsonb_typeof(e -> 'original_unit_cost') not in ('number', 'null') and e ? 'original_unit_cost' then raise exception 'unit_cost_invalid: %', v_code; end if;
    if jsonb_typeof(e -> 'original_unit_cost') = 'number' and (e ->> 'original_unit_cost')::numeric < 0 then raise exception 'unit_cost_invalid: %', v_code; end if;
    if jsonb_typeof(e -> 'shipping_allocated') = 'number' and (e ->> 'shipping_allocated')::numeric < 0 then raise exception 'shipping_invalid: %', v_code; end if;
    v_new := coalesce(jsonb_typeof(e -> 'new_item') = 'object', false);
    if exists (select 1 from public.renson_items where upper(item_code) = v_code) then
      if v_new then raise exception 'item_already_exists: %', v_code; end if;
    else
      if not v_new then raise exception 'not_a_renson_item: %', v_code; end if;
      if trim(coalesce(e -> 'new_item' ->> 'description', '')) = '' then raise exception 'description_missing: %', v_code; end if;
    end if;
  end loop;

  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = v_uid;
  for e in select * from jsonb_array_elements(v_lines) loop
    v_code := upper(trim(e ->> 'item_code'));
    v_qty := (e ->> 'qty')::numeric;
    v_orig := case when jsonb_typeof(e -> 'original_unit_cost') = 'number' then (e ->> 'original_unit_cost')::numeric end;
    v_ship := case when jsonb_typeof(e -> 'shipping_allocated') = 'number' then (e ->> 'shipping_allocated')::numeric end;
    v_cost := case when v_orig is not null then round((v_orig + coalesce(v_ship, 0) / v_qty) * v_rate, 6) end;
    v_new := coalesce(jsonb_typeof(e -> 'new_item') = 'object', false);
    if v_new then
      insert into public.renson_items (item_code, alt_codes, description, product_size, colour, unit, current_qty, unit_cost)
      values (v_code, nullif(trim(e -> 'new_item' ->> 'alt_codes'), ''), trim(e -> 'new_item' ->> 'description'),
              nullif(trim(e -> 'new_item' ->> 'product_size'), ''), nullif(trim(e -> 'new_item' ->> 'colour'), ''),
              nullif(trim(e -> 'new_item' ->> 'unit'), ''), 0, null);
      v_created := v_created + 1;
    end if;
    select id, item_code, current_qty, unit_cost into it from public.renson_items where upper(item_code) = v_code;
    if it.current_qty > 0 and coalesce(it.unit_cost, 0) > 0 and v_cost is not null then
      v_avg := round((it.current_qty * it.unit_cost + v_qty * v_cost) / (it.current_qty + v_qty), 6);
    else
      v_avg := coalesce(v_cost, it.unit_cost);
    end if;
    update public.renson_items set current_qty = current_qty + v_qty, unit_cost = v_avg, updated_at = now() where id = it.id;
    insert into public.renson_transactions (item_id, item_code, type, quantity, unit_cost, value, qty_before, qty_after,
        reference, supplier, invoice_number, po_number, document_date, original_currency, original_unit_cost, exchange_rate,
        shipping_allocated, unit_cost_before, unit_cost_after, is_new_item, document_name, document_hash, performed_by, performed_by_name)
    values (it.id, it.item_code, 'check_in', v_qty, coalesce(v_cost, it.unit_cost), round(v_qty * coalesce(v_cost, it.unit_cost, 0), 2),
        it.current_qty, it.current_qty + v_qty,
        'Check-in ' || coalesce(nullif(trim(p ->> 'invoice_number'), ''), v_supplier), v_supplier,
        nullif(left(trim(p ->> 'invoice_number'), 60), ''), nullif(left(trim(p ->> 'po_number'), 60), ''), v_date,
        v_cur, v_orig, v_rate, v_ship, it.unit_cost, v_avg, v_new,
        nullif(left(p ->> 'document_name', 300), ''), v_hash, v_uid, v_name);
    v_total := v_total + round(v_qty * coalesce(v_cost, it.unit_cost, 0), 2);
  end loop;
  return jsonb_build_object('lines', v_n, 'new_items', v_created, 'total_value', v_total);
end $$;
revoke all on function public.renson_checkin(jsonb) from public, anon;
grant execute on function public.renson_checkin(jsonb) to authenticated;

-- ------------------------------------------------------------ Adjust
-- p = {item_code, mode: 'set_to' | 'add' | 'take_out', qty, unit_cost (AED,
--      'add' only, optional), reason}
create or replace function public.renson_adjust(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_code text := upper(trim(coalesce(p ->> 'item_code', '')));
  v_mode text := coalesce(p ->> 'mode', '');
  v_reason text := trim(coalesce(p ->> 'reason', ''));
  v_qty numeric; v_delta numeric; v_cost numeric; v_avg numeric;
  it record;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if v_mode not in ('set_to', 'add', 'take_out') then raise exception 'mode_invalid'; end if;
  if v_reason = '' or length(v_reason) > 300 then raise exception 'reason_missing'; end if;
  if jsonb_typeof(p -> 'qty') <> 'number' then raise exception 'qty_invalid'; end if;
  v_qty := (p ->> 'qty')::numeric;
  if v_mode = 'set_to' and v_qty < 0 then raise exception 'qty_invalid'; end if;
  if v_mode <> 'set_to' and v_qty <= 0 then raise exception 'qty_invalid'; end if;
  if jsonb_typeof(p -> 'unit_cost') = 'number' then
    if v_mode <> 'add' then raise exception 'unit_cost_only_when_adding'; end if;
    v_cost := (p ->> 'unit_cost')::numeric;
    if v_cost < 0 then raise exception 'unit_cost_invalid'; end if;
  end if;

  select id, item_code, current_qty, unit_cost into it from public.renson_items where upper(item_code) = v_code for update;
  if not found then raise exception 'not_a_renson_item: %', v_code; end if;
  v_delta := case v_mode when 'set_to' then v_qty - it.current_qty when 'add' then v_qty else -v_qty end;
  if v_delta = 0 then raise exception 'no_change'; end if;
  v_avg := it.unit_cost;
  if v_mode = 'add' and v_cost is not null then
    if it.current_qty > 0 and coalesce(it.unit_cost, 0) > 0 then
      v_avg := round((it.current_qty * it.unit_cost + v_qty * v_cost) / (it.current_qty + v_qty), 6);
    else
      v_avg := v_cost;
    end if;
  end if;
  update public.renson_items set current_qty = current_qty + v_delta, unit_cost = v_avg, updated_at = now() where id = it.id;
  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = v_uid;
  insert into public.renson_transactions (item_id, item_code, type, quantity, unit_cost, value, qty_before, qty_after,
      reference, reason, unit_cost_before, unit_cost_after, performed_by, performed_by_name)
  values (it.id, it.item_code, 'adjustment', v_delta, coalesce(v_cost, it.unit_cost), round(v_delta * coalesce(v_cost, it.unit_cost, 0), 2),
      it.current_qty, it.current_qty + v_delta,
      case v_mode when 'set_to' then 'Stock count' when 'add' then 'Added by hand' else 'Taken out by hand' end,
      v_reason, it.unit_cost, v_avg, v_uid, v_name);
  return jsonb_build_object('item_code', it.item_code, 'qty_before', it.current_qty, 'qty_after', it.current_qty + v_delta, 'change', v_delta);
end $$;
revoke all on function public.renson_adjust(jsonb) from public, anon;
grant execute on function public.renson_adjust(jsonb) to authenticated;

-- ------------------------------------------------------------ Kanban levels
-- Empty / 0 = none. Critical only with a trigger, above 0 and below it.
create or replace function public.renson_set_levels(p_item_code text, p_trigger numeric, p_critical numeric) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_t numeric := nullif(p_trigger, 0);
  v_c numeric := nullif(p_critical, 0);
  v_name text;
  v_id bigint;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if v_t is not null and v_t < 0 then raise exception 'trigger_invalid'; end if;
  if v_c is not null and (v_c < 0 or v_t is null or v_c >= v_t) then raise exception 'critical_invalid'; end if;
  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = auth.uid();
  update public.renson_items set buffer_level = v_t, critical_level = v_c, levels_updated_at = now(), levels_updated_by_name = v_name
   where upper(item_code) = upper(trim(coalesce(p_item_code, ''))) returning id into v_id;
  if v_id is null then raise exception 'not_a_renson_item: %', p_item_code; end if;
  return jsonb_build_object('trigger', v_t, 'critical', v_c);
end $$;
revoke all on function public.renson_set_levels(text, numeric, numeric) from public, anon;
grant execute on function public.renson_set_levels(text, numeric, numeric) to authenticated;

-- ------------------------------------------------------------ Check-out (document optional)
create or replace function public.renson_checkout(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_lines jsonb := p -> 'lines';
  v_job text := trim(coalesce(p ->> 'job_number', ''));
  v_hash text := nullif(p ->> 'document_hash', '');
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
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then raise exception 'document_hash_invalid'; end if;
  if jsonb_typeof(v_lines) is distinct from 'array' then raise exception 'lines_missing'; end if;
  v_n := jsonb_array_length(v_lines);
  if v_n < 1 or v_n > 500 then raise exception 'lines_count_out_of_range'; end if;
  if (select count(distinct upper(trim(x ->> 'item_code'))) from jsonb_array_elements(v_lines) x) <> v_n then
    raise exception 'duplicate_item_code';
  end if;

  lock table public.renson_items in share row exclusive mode;
  if v_hash is not null and exists (select 1 from public.renson_transactions where type = 'check_out' and document_hash = v_hash) then
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
            nullif(left(p ->> 'document_name', 300), ''), v_hash, v_uid, v_name);
    v_total := v_total + round(v_qty * coalesce(it.unit_cost, 0), 2);
    if it.current_qty - v_qty < 0 then v_below := v_below + 1; end if;
  end loop;
  return jsonb_build_object('lines', v_n, 'total_value', v_total, 'below_zero', v_below);
end $$;
revoke all on function public.renson_checkout(jsonb) from public, anon;
grant execute on function public.renson_checkout(jsonb) to authenticated;
