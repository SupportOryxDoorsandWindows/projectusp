-- Renson inventory -- ADMIN-ONLY PILOT (2026-11-02, user's request
-- "Admin-Only Testing Before System-Wide Release").
--
-- Kept completely apart from the Freedom inventory: its OWN tables
-- (renson_items, renson_imports, renson_transactions). Nothing here reads,
-- writes, alters or re-grants any existing table, function or policy
-- (inventory_items, inventory_transactions, user_profiles, is_admin(), the
-- checkin / checkout functions ... stay exactly as they are).
--
-- Who: ONE rule, renson_access() = an active Admin (is_admin()) AND the
-- feature flag 'renson_pilot' is on. It guards every read policy and every
-- function, so the database itself refuses everyone else (hiding the menu
-- is only the second line).
--
-- Switch OFF immediately (SQL Editor; Freedom is not touched):
--   update public.app_feature_flags set enabled = false, updated_at = now()
--    where key = 'renson_pilot';
-- Switch back ON: the same with enabled = true.
-- Release to everyone: NOT part of this file -- only with the owner's
-- approval (would change renson_access()).
-- Remove everything: supabase/sql/renson_pilot_rollback.sql.
--
-- Tested on a local Postgres: tests/sql/supabase-base.sql +
-- tests/sql/inventory-base.sql + this file + tests/sql/renson-pilot.test.sql.

-- ------------------------------------------------------------ feature flag
create table if not exists public.app_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.app_feature_flags enable row level security;
revoke all on public.app_feature_flags from anon, authenticated;
grant select on public.app_feature_flags to authenticated;
drop policy if exists app_feature_flags_admin_read on public.app_feature_flags;
create policy app_feature_flags_admin_read on public.app_feature_flags
  for select to authenticated using (public.is_admin());
insert into public.app_feature_flags (key, enabled, note)
values ('renson_pilot', true, 'Renson inventory, Admin-only pilot. Off = hidden and refused for everyone.')
on conflict (key) do nothing;

create or replace function public.renson_access() returns boolean
language sql stable security definer set search_path to '' as $$
  select public.is_admin()
     and coalesce((select enabled from public.app_feature_flags where key = 'renson_pilot'), false);
$$;
revoke all on function public.renson_access() from public, anon;
grant execute on function public.renson_access() to authenticated;

-- ------------------------------------------------------------ tables
create table if not exists public.renson_imports (
  id bigint generated always as identity primary key,
  file_name text not null,
  file_hash text not null,
  sheet text,
  item_count integer not null,
  items_with_stock integer not null,
  total_value numeric not null,
  sheet_total numeric,
  imported_by uuid,
  imported_by_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.renson_items (
  id bigint generated always as identity primary key,
  item_code text not null unique,
  alt_codes text,
  description text not null,
  source_text text,
  product_size text,
  part_type text,
  colour text,
  qty_per_set numeric,
  unit text,
  current_qty numeric not null default 0 check (current_qty >= 0),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  current_value numeric generated always as (round(current_qty * coalesce(unit_cost, 0), 2)) stored,
  source_row integer,
  import_id bigint references public.renson_imports(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.renson_transactions (
  id bigint generated always as identity primary key,
  item_id bigint not null references public.renson_items(id),
  item_code text not null,
  type text not null check (type in ('opening_import')),
  quantity numeric not null,
  unit_cost numeric,
  value numeric,
  qty_before numeric not null,
  qty_after numeric not null,
  import_id bigint references public.renson_imports(id),
  reference text,
  performed_by uuid,
  performed_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists renson_transactions_item_idx on public.renson_transactions (item_id, created_at);

do $$ declare t text; begin
  foreach t in array array['renson_imports', 'renson_items', 'renson_transactions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_pilot_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.renson_access())', t || '_pilot_read', t);
  end loop;
end $$;

-- ------------------------------------------------------------ opening import
-- p = {file_name, file_hash, sheet, sheet_total, items: [{item_code,
-- alt_codes, description, source_text, product_size, part_type, colour,
-- qty_per_set, unit, qty, unit_cost, source_row}]}
-- Once only (the opening stock): refused while any Renson item exists.
create or replace function public.renson_import_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_import bigint;
  v_items jsonb := p -> 'items';
  v_n integer;
  e jsonb;
  v_code text; v_desc text; v_qty numeric; v_cost numeric;
  v_item bigint;
  v_total numeric := 0; v_with integer := 0;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(v_items) is distinct from 'array' then raise exception 'items_missing'; end if;
  v_n := jsonb_array_length(v_items);
  if v_n < 1 or v_n > 2000 then raise exception 'items_count_out_of_range'; end if;
  if coalesce(trim(p ->> 'file_name'), '') = '' then raise exception 'file_name_missing'; end if;
  if coalesce(p ->> 'file_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'file_hash_invalid'; end if;

  lock table public.renson_items in exclusive mode;
  if exists (select 1 from public.renson_items) then
    raise exception 'renson_already_imported';
  end if;

  -- validate every line before writing anything
  if (select count(distinct upper(trim(x ->> 'item_code'))) from jsonb_array_elements(v_items) x) <> v_n then
    raise exception 'duplicate_item_code';
  end if;
  for e in select * from jsonb_array_elements(v_items) loop
    v_code := trim(coalesce(e ->> 'item_code', ''));
    v_desc := trim(coalesce(e ->> 'description', ''));
    if v_code = '' or length(v_code) > 60 then raise exception 'item_code_invalid: %', left(v_code, 60); end if;
    if v_desc = '' then raise exception 'description_missing: %', v_code; end if;
    if jsonb_typeof(e -> 'qty') <> 'number' or (e ->> 'qty')::numeric < 0 then raise exception 'qty_invalid: %', v_code; end if;
    if e ? 'unit_cost' and jsonb_typeof(e -> 'unit_cost') <> 'null'
       and (jsonb_typeof(e -> 'unit_cost') <> 'number' or (e ->> 'unit_cost')::numeric < 0) then
      raise exception 'unit_cost_invalid: %', v_code;
    end if;
  end loop;

  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = v_uid;
  insert into public.renson_imports (file_name, file_hash, sheet, item_count, items_with_stock, total_value, sheet_total, imported_by, imported_by_name)
  values (left(trim(p ->> 'file_name'), 300), p ->> 'file_hash', left(p ->> 'sheet', 100), v_n, 0, 0,
          case when jsonb_typeof(p -> 'sheet_total') = 'number' then (p ->> 'sheet_total')::numeric end, v_uid, v_name)
  returning id into v_import;

  for e in select * from jsonb_array_elements(v_items) loop
    v_code := trim(e ->> 'item_code');
    v_qty := (e ->> 'qty')::numeric;
    v_cost := case when jsonb_typeof(e -> 'unit_cost') = 'number' then (e ->> 'unit_cost')::numeric end;
    insert into public.renson_items (item_code, alt_codes, description, source_text, product_size, part_type, colour,
                                     qty_per_set, unit, current_qty, unit_cost, source_row, import_id)
    values (v_code, nullif(trim(e ->> 'alt_codes'), ''), trim(e ->> 'description'), e ->> 'source_text',
            nullif(trim(e ->> 'product_size'), ''), nullif(trim(e ->> 'part_type'), ''), nullif(trim(e ->> 'colour'), ''),
            case when jsonb_typeof(e -> 'qty_per_set') = 'number' then (e ->> 'qty_per_set')::numeric end,
            nullif(trim(e ->> 'unit'), ''), v_qty, v_cost,
            case when jsonb_typeof(e -> 'source_row') = 'number' then (e ->> 'source_row')::integer end, v_import)
    returning id into v_item;
    insert into public.renson_transactions (item_id, item_code, type, quantity, unit_cost, value, qty_before, qty_after,
                                            import_id, reference, performed_by, performed_by_name)
    values (v_item, v_code, 'opening_import', v_qty, v_cost, round(v_qty * coalesce(v_cost, 0), 2), 0, v_qty,
            v_import, 'Opening stock: ' || left(trim(p ->> 'file_name'), 200), v_uid, v_name);
    v_total := v_total + round(v_qty * coalesce(v_cost, 0), 2);
    if v_qty > 0 then v_with := v_with + 1; end if;
  end loop;

  update public.renson_imports set items_with_stock = v_with, total_value = v_total where id = v_import;
  return jsonb_build_object('import_id', v_import, 'items', v_n, 'items_with_stock', v_with, 'total_value', v_total);
end $$;
revoke all on function public.renson_import_stock(jsonb) from public, anon;
grant execute on function public.renson_import_stock(jsonb) to authenticated;

-- ------------------------------------------------------------ pilot reset
-- Clears ONLY the Renson pilot tables (to redo the test import). Admin +
-- flag on, and the exact words 'RESET RENSON'.
create or replace function public.renson_reset_pilot(p_confirm text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_items integer;
begin
  if not public.renson_access() then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'RESET RENSON' then raise exception 'confirmation_missing'; end if;
  select count(*) into v_items from public.renson_items;
  delete from public.renson_transactions where true;
  delete from public.renson_items where true;
  delete from public.renson_imports where true;
  return jsonb_build_object('items_removed', v_items);
end $$;
revoke all on function public.renson_reset_pilot(text) from public, anon;
grant execute on function public.renson_reset_pilot(text) to authenticated;
