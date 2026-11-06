-- Allocated Materials (2026-11-06, owner's request "Feature Request:
-- Allocated Materials in Master Inventory" + answers: job list PDF (from the
-- Check-out page, "Allocate" instead of Confirm) and by hand; cleared
-- AUTOMATICALLY by job number after a Check-out; BLOCK allocating more than
-- Available; own sidebar page; Freedom and Renson; any staff may reduce /
-- cancel with a reason (logged); Master Inventory: Total stock + Allocated +
-- Available (Kanban stays on total stock); lines can be unticked, short lines
-- capped at what is available).
--
-- NEVER stock: nothing here writes inventory_* or renson_* tables. Physical
-- stock only changes at Check-out, exactly as before.
--   Available = current_qty - sum(open allocated) for that item.
--   Line open qty = allocated - checked out - released (generated column).
-- After a Check-out is saved, allocation_sync(job) matches that job's
-- check_out stock lines (Freedom inventory_transactions / Renson
-- renson_transactions, same job number, entered after the allocation) to the
-- job's open lines and moves the quantity from "open" to "checked out". Every
-- stock line is used once (allocation_checkout_links, unique), so a re-run or
-- a second sync never counts it twice.
-- Run after renson_release.sql. No DROP. Re-run safe.

-- ------------------------------------------------------------------ tables
create table if not exists public.allocations (
  id bigint generated always as identity primary key,
  job_number text not null check (btrim(job_number) <> '' and length(job_number) <= 60),
  job_key text not null,
  client text check (length(client) <= 200),
  notes text check (length(notes) <= 2000),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one OPEN allocation per job (topping up adds to it)
create unique index if not exists allocations_one_open_per_job on public.allocations (job_key) where status = 'open';

create table if not exists public.allocation_lines (
  id bigint generated always as identity primary key,
  allocation_id bigint not null references public.allocations(id) on delete cascade,
  inventory text not null check (inventory in ('freedom', 'renson')),
  freedom_item_id uuid references public.inventory_items(id),
  renson_item_id bigint references public.renson_items(id),
  item_code text,
  description text,
  unit text,
  qty_allocated numeric not null check (qty_allocated > 0),
  qty_checked_out numeric not null default 0 check (qty_checked_out >= 0),
  qty_released numeric not null default 0 check (qty_released >= 0),
  qty_open numeric generated always as (qty_allocated - qty_checked_out - qty_released) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (qty_checked_out + qty_released <= qty_allocated),
  check ((inventory = 'freedom' and freedom_item_id is not null and renson_item_id is null)
      or (inventory = 'renson' and renson_item_id is not null and freedom_item_id is null))
);
create unique index if not exists allocation_lines_one_per_item
  on public.allocation_lines (allocation_id, inventory, coalesce(freedom_item_id::text, renson_item_id::text));
create index if not exists allocation_lines_freedom_idx on public.allocation_lines (freedom_item_id) where freedom_item_id is not null;
create index if not exists allocation_lines_renson_idx on public.allocation_lines (renson_item_id) where renson_item_id is not null;

-- Which Check-out stock lines were matched (each one once, ever).
create table if not exists public.allocation_checkout_links (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('freedom', 'renson')),
  tx_id text not null,
  allocation_id bigint references public.allocations(id) on delete set null,
  line_id bigint references public.allocation_lines(id) on delete set null,
  qty numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (kind, tx_id)
);

-- Audit trail (no FK: kept whatever happens to the allocation).
create table if not exists public.allocation_log (
  id bigint generated always as identity primary key,
  allocation_id bigint,
  job_number text,
  action text not null,
  detail jsonb,
  by_user uuid,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists allocation_log_alloc_idx on public.allocation_log (allocation_id, created_at);

-- --------------------------------------------------- reading: staff only
alter table public.allocations enable row level security;
alter table public.allocation_lines enable row level security;
alter table public.allocation_checkout_links enable row level security;
alter table public.allocation_log enable row level security;
revoke all on public.allocations, public.allocation_lines, public.allocation_checkout_links, public.allocation_log from anon, authenticated;
grant select on public.allocations, public.allocation_lines, public.allocation_checkout_links, public.allocation_log to authenticated;
do $$
declare t text;
begin
  foreach t in array array['allocations', 'allocation_lines', 'allocation_checkout_links', 'allocation_log'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'Active staff read') then
      execute format('create policy "Active staff read" on public.%I for select to authenticated using ((select public.is_active_staff()))', t);
    end if;
  end loop;
end $$;
-- (no insert / update / delete policies: writes only through the functions below)

-- ------------------------------------------------------------------ helpers
create or replace function public.alloc_job_key(p text) returns text
language sql immutable as $$ select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

create or replace function public.alloc_who() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(full_name), ''), email, 'unknown') from public.user_profiles where user_id = auth.uid() $$;
revoke all on function public.alloc_who() from public, anon, authenticated;

create or replace function public.alloc_log_it(p_alloc bigint, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.allocation_log (allocation_id, job_number, action, detail, by_user, by_name)
  values (p_alloc, (select job_number from public.allocations where id = p_alloc), p_action, p_detail, auth.uid(), public.alloc_who()) $$;
revoke all on function public.alloc_log_it(bigint, text, jsonb) from public, anon, authenticated;

-- Open allocated quantity of one item (all open allocations).
create or replace function public.alloc_open_qty(p_inventory text, p_item text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.qty_open), 0) from public.allocation_lines l join public.allocations a on a.id = l.allocation_id
  where a.status = 'open' and l.inventory = p_inventory
    and coalesce(l.freedom_item_id::text, l.renson_item_id::text) = p_item $$;
revoke all on function public.alloc_open_qty(text, text) from public, anon, authenticated;

-- Nothing open any more: closed (something was checked out) or cancelled.
create or replace function public.alloc_refresh_status(p_alloc bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare v_open numeric; v_out numeric; v_cur text; v_new text;
begin
  select coalesce(sum(qty_open), 0), coalesce(sum(qty_checked_out), 0) into v_open, v_out from public.allocation_lines where allocation_id = p_alloc;
  select status into v_cur from public.allocations where id = p_alloc;
  v_new := case when v_open > 0 then 'open' when v_out > 0 then 'closed' else 'cancelled' end;
  if v_cur = 'open' and v_new <> 'open' then
    update public.allocations set status = v_new, updated_at = now() where id = p_alloc;
    return v_new;
  end if;
  return v_cur;
end $$;
revoke all on function public.alloc_refresh_status(bigint) from public, anon, authenticated;

-- ---------------------------------------------- Check-outs -> allocations
-- p_job null = every open allocation. Returns what was matched.
create or replace function public.allocation_sync(p_job text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; t record; l public.allocation_lines; v_use numeric; v_done jsonb := '[]'; v_n int; v_qty numeric;
begin
  if not public.is_active_staff() then raise exception 'not_allowed'; end if;
  for a in select * from public.allocations
           where status = 'open' and (p_job is null or job_key = public.alloc_job_key(p_job))
           order by id for update loop
    v_n := 0; v_qty := 0;
    for t in
      select 'freedom' kind, x.id::text tx_id, x.item_id::text item, x.quantity qty, x.created_at
        from public.inventory_transactions x
       where x.type = 'check_out' and public.alloc_job_key(x.job_number) = a.job_key and x.created_at >= a.created_at
         and not exists (select 1 from public.allocation_checkout_links k where k.kind = 'freedom' and k.tx_id = x.id::text)
      union all
      select 'renson', x.id::text, x.item_id::text, x.quantity, x.created_at
        from public.renson_transactions x
       where x.type = 'check_out' and public.alloc_job_key(x.job_number) = a.job_key and x.created_at >= a.created_at
         and not exists (select 1 from public.allocation_checkout_links k where k.kind = 'renson' and k.tx_id = x.id::text)
      order by created_at, tx_id
    loop
      select * into l from public.allocation_lines
       where allocation_id = a.id and inventory = t.kind and coalesce(freedom_item_id::text, renson_item_id::text) = t.item and qty_open > 0
       for update;
      v_use := case when l.id is null then 0 else least(greatest(t.qty, 0), l.qty_open) end;
      if v_use > 0 then
        update public.allocation_lines set qty_checked_out = qty_checked_out + v_use, updated_at = now() where id = l.id;
        v_n := v_n + 1; v_qty := v_qty + v_use;
      end if;
      insert into public.allocation_checkout_links (kind, tx_id, allocation_id, line_id, qty)
      values (t.kind, t.tx_id, a.id, l.id, v_use) on conflict (kind, tx_id) do nothing;
    end loop;
    if v_n > 0 then
      update public.allocations set updated_at = now() where id = a.id;
      perform public.alloc_log_it(a.id, 'checked_out', jsonb_build_object('lines', v_n, 'qty', v_qty));
      v_done := v_done || jsonb_build_object('id', a.id, 'job_number', a.job_number, 'lines', v_n, 'qty', v_qty,
        'status', public.alloc_refresh_status(a.id));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'updated', v_done);
end $$;
revoke all on function public.allocation_sync(text) from public, anon;
grant execute on function public.allocation_sync(text) to authenticated;

-- ---------------------------------------------------------- allocate
-- p: {job_number, client, notes, source ('job_list' | 'manual'),
--     document_name, document_hash,
--     lines: [{inventory 'freedom'|'renson', item_id (Freedom uuid /
--              Renson id), qty, source?}]}
-- Same item twice = added up. Every line must fit in Available (stock minus
-- what is already allocated) or NOTHING is saved ('more_than_available').
-- An open allocation of the same job is topped up.
create or replace function public.allocation_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_job text := btrim(coalesce(p ->> 'job_number', '')); v_key text; a public.allocations; e record;
  v_stock numeric; v_code text; v_desc text; v_unit text; v_avail numeric; v_new boolean := false; v_lines jsonb := '[]'; v_ln public.allocation_lines;
begin
  if not public.is_active_staff() then raise exception 'not_allowed'; end if;
  if v_job = '' or length(v_job) > 60 then raise exception 'job_number_missing'; end if;
  v_key := public.alloc_job_key(v_job);
  if v_key = '' then raise exception 'job_number_missing'; end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then raise exception 'lines_missing'; end if;
  if exists (select 1 from jsonb_array_elements(p -> 'lines') x where jsonb_typeof(x -> 'qty') <> 'number') then raise exception 'line_qty_invalid'; end if;
  -- Check-outs of this job already saved count first (never twice).
  perform public.allocation_sync(v_job);

  select * into a from public.allocations where job_key = v_key and status = 'open' for update;
  if a.id is null then
    insert into public.allocations (job_number, job_key, client, notes, created_by, created_by_name)
    values (v_job, v_key, nullif(btrim(p ->> 'client'), ''), nullif(btrim(p ->> 'notes'), ''), auth.uid(), public.alloc_who())
    returning * into a;
    v_new := true;
  end if;

  for e in
    select x ->> 'inventory' inv, x ->> 'item_id' item, sum((x ->> 'qty')::numeric) qty, min(x ->> 'source') src
      from jsonb_array_elements(p -> 'lines') x
     where jsonb_typeof(x -> 'qty') = 'number'
     group by 1, 2 order by 1, 2
  loop
    if e.inv not in ('freedom', 'renson') or e.item is null then raise exception 'line_invalid'; end if;
    if e.qty <= 0 then raise exception 'line_qty_invalid'; end if;
    -- lock the item: two people allocating the same item wait for each other
    if e.inv = 'freedom' then
      if e.item !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'line_invalid'; end if;
      select current_qty, item_code, description || coalesce(' · ' || bar_length_mm || ' mm', ''), unit_of_measure
        into v_stock, v_code, v_desc, v_unit from public.inventory_items where id = e.item::uuid for update;
    else
      if e.item !~ '^[0-9]+$' then raise exception 'line_invalid'; end if;
      select current_qty, item_code, description, unit into v_stock, v_code, v_desc, v_unit from public.renson_items where id = e.item::bigint for update;
    end if;
    if v_code is null then raise exception 'item_not_found'; end if;
    v_avail := coalesce(v_stock, 0) - public.alloc_open_qty(e.inv, e.item);
    if e.qty > v_avail then
      raise exception 'more_than_available: % (available %, asked %)', v_code, greatest(v_avail, 0), e.qty;
    end if;
    select * into v_ln from public.allocation_lines where allocation_id = a.id and inventory = e.inv
       and coalesce(freedom_item_id::text, renson_item_id::text) = e.item for update;
    if v_ln.id is null then
      insert into public.allocation_lines (allocation_id, inventory, freedom_item_id, renson_item_id, item_code, description, unit, qty_allocated)
      values (a.id, e.inv, case when e.inv = 'freedom' then e.item::uuid end, case when e.inv = 'renson' then e.item::bigint end, v_code, v_desc, v_unit, e.qty);
    else
      update public.allocation_lines set qty_allocated = qty_allocated + e.qty, updated_at = now() where id = v_ln.id;
    end if;
    v_lines := v_lines || jsonb_build_object('inventory', e.inv, 'code', v_code, 'qty', e.qty);
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'lines_missing'; end if;
  update public.allocations set updated_at = now(),
    client = coalesce(client, nullif(btrim(p ->> 'client'), '')) where id = a.id;
  perform public.alloc_log_it(a.id, case when v_new then 'allocated' else 'topped_up' end,
    jsonb_build_object('lines', v_lines, 'source', coalesce(p ->> 'source', 'manual'),
      'document_name', p ->> 'document_name', 'document_hash', p ->> 'document_hash'));
  return jsonb_build_object('ok', true, 'id', a.id, 'job_number', a.job_number, 'new', v_new, 'lines', jsonb_array_length(v_lines));
end $$;
revoke all on function public.allocation_create(jsonb) from public, anon;
grant execute on function public.allocation_create(jsonb) to authenticated;

-- ------------------------------------------------- reduce / cancel (staff)
-- p: {allocation_id, reason, lines: [{line_id, qty}]}  or  {allocation_id, reason, all: true}
-- The released quantity goes back to Available. Reason required, logged.
create or replace function public.allocation_release(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.allocations; c jsonb; l public.allocation_lines; v_q numeric; v_log jsonb := '[]';
begin
  if not public.is_active_staff() then raise exception 'not_allowed'; end if;
  if btrim(coalesce(p ->> 'reason', '')) = '' then raise exception 'reason_missing'; end if;
  select * into a from public.allocations where id = (p ->> 'allocation_id')::bigint for update;
  if a.id is null then raise exception 'allocation_not_found'; end if;
  if a.status <> 'open' then raise exception 'allocation_closed'; end if;
  if coalesce((p ->> 'all')::boolean, false) then
    for l in select * from public.allocation_lines where allocation_id = a.id and qty_open > 0 order by id for update loop
      update public.allocation_lines set qty_released = qty_released + l.qty_open, updated_at = now() where id = l.id;
      v_log := v_log || jsonb_build_object('code', l.item_code, 'qty', l.qty_open);
    end loop;
  else
    for c in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]')) loop
      select * into l from public.allocation_lines where id = (c ->> 'line_id')::bigint and allocation_id = a.id for update;
      if l.id is null then raise exception 'line_not_found'; end if;
      if jsonb_typeof(c -> 'qty') <> 'number' or (c ->> 'qty')::numeric <= 0 then raise exception 'line_qty_invalid'; end if;
      v_q := (c ->> 'qty')::numeric;
      if v_q > l.qty_open then raise exception 'more_than_open: % (open %)', l.item_code, l.qty_open; end if;
      update public.allocation_lines set qty_released = qty_released + v_q, updated_at = now() where id = l.id;
      v_log := v_log || jsonb_build_object('code', l.item_code, 'qty', v_q);
    end loop;
  end if;
  if jsonb_array_length(v_log) = 0 then raise exception 'nothing_to_release'; end if;
  update public.allocations set updated_at = now() where id = a.id;
  perform public.alloc_log_it(a.id, 'released', jsonb_build_object('reason', btrim(p ->> 'reason'), 'lines', v_log, 'all', coalesce((p ->> 'all')::boolean, false)));
  return jsonb_build_object('ok', true, 'lines', jsonb_array_length(v_log), 'status', public.alloc_refresh_status(a.id));
end $$;
revoke all on function public.allocation_release(jsonb) from public, anon;
grant execute on function public.allocation_release(jsonb) to authenticated;
