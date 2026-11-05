-- Materials in Transit (2026-11-05, "Feature Development: Materials in
-- Transit" + the owner's answers): everything Oryx has ordered from a
-- supplier but not yet received.
--
-- Owner's answers:
--   * Cost of received goods comes from the supplier invoice through the
--     NORMAL Check-in (Freedom page or Renson box) -- unchanged. A transit
--     record only counts quantities; it never changes stock or cost.
--   * "Pending QC" is a status label only (received goods still go into
--     stock at Check-in, as today).
--   * Purchase orders live here (no separate Purchase Orders page).
--
-- NEVER stock: nothing here writes inventory_items / inventory_transactions
-- / renson_*; it only reads them to check that a Check-in really happened.
-- Pending quantity = ordered - received - cancelled (generated column).
-- Writes only through the functions below (no write policies); every
-- change is logged in transit_log (kept even if an order is deleted).
-- No DROP anywhere (the Supabase connector's DROP confirmation never
-- reaches the user); re-running this file is safe.
--
-- Who may do what:
--   active staff  read, create a PO, edit its dates / payment / status /
--                 notes / refs, receive (after a Check-in), add documents
--   Admins        + change ordered quantities / prices / lines, cancel
--                 quantities, delete a PO that has nothing received,
--                 link a Check-in someone else entered

-- ------------------------------------------------------------------ tables
create table if not exists public.transit_orders (
  id bigint generated always as identity primary key,
  po_number text not null check (btrim(po_number) <> '' and length(po_number) <= 60),
  -- "PO26-2106", "po 26 2106" and "PO26/2106" are the same PO.
  po_key text generated always as (upper(regexp_replace(po_number, '[^A-Za-z0-9]', '', 'g'))) stored,
  supplier text not null check (btrim(supplier) <> '' and length(supplier) <= 160),
  supplier_group text not null check (supplier_group in ('Freedom', 'Renson', 'Fusion', 'Other')),
  inventory text not null check (inventory in ('freedom', 'renson')),
  po_date date,
  quote_ref text check (length(quote_ref) <= 60),
  currency text not null default 'AED' check (currency ~ '^[A-Z]{3}$'),
  rate_to_aed numeric not null default 1 check (rate_to_aed > 0),
  expected_delivery date,
  payment_status text not null default 'tbc' check (payment_status in ('tbc', 'unpaid', 'partially_paid', 'paid')),
  delivery_status text not null default 'ordered'
    check (delivery_status in ('ordered', 'in_transit', 'partially_received', 'pending_qc', 'completed', 'cancelled')),
  notes text check (length(notes) <= 2000),
  source text not null default 'manual' check (source in ('manual', 'pdf', 'excel')),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists transit_orders_po_key on public.transit_orders (po_key);

create table if not exists public.transit_lines (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.transit_orders(id) on delete cascade,
  line_no int not null check (line_no > 0),
  item_code text check (length(item_code) <= 60),
  description text not null check (btrim(description) <> '' and length(description) <= 300),
  freedom_item_id uuid references public.inventory_items(id),
  renson_item_id bigint references public.renson_items(id),
  unit text check (length(unit) <= 30),
  qty_ordered numeric not null check (qty_ordered > 0),
  qty_received numeric not null default 0 check (qty_received >= 0),
  qty_cancelled numeric not null default 0 check (qty_cancelled >= 0),
  qty_pending numeric generated always as (qty_ordered - qty_received - qty_cancelled) stored,
  unit_price numeric check (unit_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- never more received + cancelled than ordered (an over-delivery needs an
  -- Admin to raise the ordered quantity first, with a reason)
  check (qty_received + qty_cancelled <= qty_ordered),
  check (freedom_item_id is null or renson_item_id is null),
  unique (order_id, line_no)
);
-- the same material once per PO (same code AND same wording; one code can
-- have several bar lengths, written differently)
create unique index if not exists transit_lines_no_duplicate
  on public.transit_lines (order_id, upper(coalesce(item_code, '')), lower(btrim(description)));
create index if not exists transit_lines_order_idx on public.transit_lines (order_id);

-- One delivery received against a PO (= one Check-in).
create table if not exists public.transit_receipts (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.transit_orders(id),
  receive_key uuid not null unique,      -- one per "Receive" -- a retry never counts twice
  delivery_note_no text check (length(delivery_note_no) <= 60),
  delivery_date date,
  checkin_kind text not null check (checkin_kind in ('freedom', 'renson')),
  checkin_tx_ids text[] not null check (cardinality(checkin_tx_ids) > 0),
  checkin_reference text,                -- invoice / document number
  document_name text,
  received_by uuid,
  received_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists transit_receipts_order_idx on public.transit_receipts (order_id);
create table if not exists public.transit_receipt_lines (
  receipt_id bigint not null references public.transit_receipts(id),
  line_id bigint not null references public.transit_lines(id),
  qty numeric not null check (qty > 0),
  primary key (receipt_id, line_id)
);

-- Supporting documents (PO, quote...) in the PRIVATE bucket transit-documents.
create table if not exists public.transit_documents (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.transit_orders(id) on delete cascade,
  kind text not null default 'other' check (kind in ('po', 'quote', 'other')),
  name text not null check (length(name) <= 300),
  path text not null unique,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);

-- Audit trail (no foreign key: kept when an order is deleted).
create table if not exists public.transit_log (
  id bigint generated always as identity primary key,
  order_id bigint,
  po_number text,
  action text not null,
  detail jsonb,
  by_user uuid,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists transit_log_order_idx on public.transit_log (order_id, created_at);

-- ------------------------------------------------------------ access rules
create or replace function public.transit_access() returns boolean
language sql stable security definer set search_path = '' as $$ select public.is_active_staff() $$;
revoke all on function public.transit_access() from public, anon;
grant execute on function public.transit_access() to authenticated;

do $$ declare t text; begin
  foreach t in array array['transit_orders', 'transit_lines', 'transit_receipts', 'transit_receipt_lines', 'transit_documents', 'transit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_staff_read') then
      execute format('create policy %I on public.%I for select to authenticated using ((select public.transit_access()))', t || '_staff_read', t);
    end if;
  end loop;
end $$;

-- Private bucket for the PO / quote files (PDF or Excel, 25 MB). Name =
-- <order id>/<sha256>.<ext>; no update / delete policy (never replaced).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transit-documents', 'transit-documents', false, 26214400, array['application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'])
on conflict (id) do nothing;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'transit_documents_staff_read') then
    create policy transit_documents_staff_read on storage.objects for select to authenticated
      using (bucket_id = 'transit-documents' and (select public.transit_access()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'transit_documents_staff_add') then
    create policy transit_documents_staff_add on storage.objects for insert to authenticated
      with check (bucket_id = 'transit-documents' and (select public.transit_access())
        and name ~ '^[0-9]+/[0-9a-f]{64}\.(pdf|xlsx|xls)$');
  end if;
end $$;

-- ------------------------------------------------------------------ helpers
create or replace function public.transit_who() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(full_name), ''), email, 'unknown') from public.user_profiles where user_id = auth.uid() $$;
revoke all on function public.transit_who() from public, anon, authenticated;

create or replace function public.transit_log_it(p_order bigint, p_action text, p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.transit_log (order_id, po_number, action, detail, by_user, by_name)
  values (p_order, (select po_number from public.transit_orders where id = p_order), p_action, p_detail, auth.uid(), public.transit_who()) $$;
revoke all on function public.transit_log_it(bigint, text, jsonb) from public, anon, authenticated;

-- After any quantity change: everything received = Completed; nothing left
-- but something cancelled and nothing received = Cancelled; some received
-- and still pending = Partially received (unless it is marked Pending QC).
create or replace function public.transit_refresh_status(p_order bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare v_pend numeric; v_recv numeric; v_cur text; v_new text;
begin
  select coalesce(sum(qty_pending), 0), coalesce(sum(qty_received), 0) into v_pend, v_recv from public.transit_lines where order_id = p_order;
  select delivery_status into v_cur from public.transit_orders where id = p_order;
  if v_pend <= 0 then v_new := case when v_recv > 0 then 'completed' else 'cancelled' end;
  elsif v_recv > 0 then v_new := case when v_cur = 'pending_qc' then 'pending_qc' else 'partially_received' end;
  else v_new := case when v_cur in ('completed', 'cancelled', 'partially_received') then 'ordered' else v_cur end;
  end if;
  if v_new is distinct from v_cur then
    update public.transit_orders set delivery_status = v_new, updated_at = now() where id = p_order;
  end if;
  return v_new;
end $$;
revoke all on function public.transit_refresh_status(bigint) from public, anon, authenticated;

-- One line from JSON: checks and the link to the inventory item.
-- Freedom: the browser sends the chosen item id (one code can have several
-- bar lengths); it must exist and carry the same code. Renson: found by code.
create or replace function public.transit_line_values(p_inventory text, e jsonb,
  out o_code text, out o_desc text, out o_unit text, out o_qty numeric, out o_price numeric, out o_fid uuid, out o_rid bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  o_code := nullif(upper(btrim(e ->> 'item_code')), '');
  o_desc := btrim(coalesce(e ->> 'description', ''));
  o_unit := nullif(btrim(e ->> 'unit'), '');
  if o_desc = '' then raise exception 'line_description_missing'; end if;
  if jsonb_typeof(e -> 'qty_ordered') <> 'number' or (e ->> 'qty_ordered')::numeric <= 0 then raise exception 'line_qty_invalid'; end if;
  o_qty := (e ->> 'qty_ordered')::numeric;
  if e ? 'unit_price' and jsonb_typeof(e -> 'unit_price') = 'number' then
    o_price := (e ->> 'unit_price')::numeric;
    if o_price < 0 then raise exception 'line_price_invalid'; end if;
  elsif e ? 'unit_price' and jsonb_typeof(e -> 'unit_price') not in ('null') then raise exception 'line_price_invalid';
  end if;
  if p_inventory = 'freedom' then
    if nullif(e ->> 'freedom_item_id', '') is not null then
      select id into o_fid from public.inventory_items
        where id = (e ->> 'freedom_item_id')::uuid and (o_code is null or upper(btrim(item_code)) = o_code);
      if o_fid is null then raise exception 'line_item_mismatch'; end if;
    end if;
  elsif o_code is not null then
    select id into o_rid from public.renson_items where upper(item_code) = o_code;
  end if;
end $$;
revoke all on function public.transit_line_values(text, jsonb) from public, anon, authenticated;

create or replace function public.transit_group_of(p_supplier text) returns text
language sql immutable as $$
  select case when p_supplier ~* 'renson' then 'Renson' when p_supplier ~* 'freedom' then 'Freedom'
              when p_supplier ~* 'fusion' then 'Fusion' else 'Other' end $$;

-- ----------------------------------------------------------- create a PO
-- p: {po_number, supplier, supplier_group?, inventory?, po_date, quote_ref,
--     currency, rate_to_aed, expected_delivery, payment_status,
--     delivery_status ('ordered' | 'in_transit'), notes, source,
--     lines: [{item_code, description, unit, qty_ordered, unit_price, freedom_item_id}]}
create or replace function public.transit_create_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_group text; v_inv text; v_cur text; v_rate numeric; e jsonb; n int := 0; lv record; v_status text;
begin
  if not public.transit_access() then raise exception 'not_allowed'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'invalid_request'; end if;
  if btrim(coalesce(p ->> 'po_number', '')) = '' then raise exception 'po_number_missing'; end if;
  if btrim(coalesce(p ->> 'supplier', '')) = '' then raise exception 'supplier_missing'; end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then raise exception 'lines_missing'; end if;
  if jsonb_array_length(p -> 'lines') > 1000 then raise exception 'too_many_lines'; end if;
  if exists (select 1 from public.transit_orders where po_key = upper(regexp_replace(p ->> 'po_number', '[^A-Za-z0-9]', '', 'g'))) then
    raise exception 'duplicate_po';
  end if;
  v_group := coalesce(nullif(p ->> 'supplier_group', ''), public.transit_group_of(p ->> 'supplier'));
  v_inv := coalesce(nullif(p ->> 'inventory', ''), case when v_group = 'Renson' then 'renson' else 'freedom' end);
  v_cur := upper(coalesce(nullif(btrim(p ->> 'currency'), ''), 'AED'));
  if v_cur = 'AED' then v_rate := 1;
  elsif jsonb_typeof(p -> 'rate_to_aed') = 'number' and (p ->> 'rate_to_aed')::numeric > 0 then v_rate := (p ->> 'rate_to_aed')::numeric;
  else raise exception 'rate_missing';
  end if;
  v_status := coalesce(nullif(p ->> 'delivery_status', ''), 'ordered');
  if v_status not in ('ordered', 'in_transit') then raise exception 'status_invalid'; end if;
  insert into public.transit_orders (po_number, supplier, supplier_group, inventory, po_date, quote_ref, currency, rate_to_aed,
      expected_delivery, payment_status, delivery_status, notes, source, created_by, created_by_name)
  values (btrim(p ->> 'po_number'), btrim(p ->> 'supplier'), v_group, v_inv, nullif(p ->> 'po_date', '')::date,
      nullif(btrim(p ->> 'quote_ref'), ''), v_cur, v_rate, nullif(p ->> 'expected_delivery', '')::date,
      coalesce(nullif(p ->> 'payment_status', ''), 'tbc'), v_status, nullif(btrim(p ->> 'notes'), ''),
      coalesce(nullif(p ->> 'source', ''), 'manual'), auth.uid(), public.transit_who())
  returning id into v_id;
  for e in select * from jsonb_array_elements(p -> 'lines') loop
    n := n + 1;
    select * into lv from public.transit_line_values(v_inv, e);
    begin
      insert into public.transit_lines (order_id, line_no, item_code, description, freedom_item_id, renson_item_id, unit, qty_ordered, unit_price)
      values (v_id, n, lv.o_code, lv.o_desc, lv.o_fid, lv.o_rid, lv.o_unit, lv.o_qty, lv.o_price);
    exception when unique_violation then raise exception 'duplicate_line: %', coalesce(lv.o_code, lv.o_desc);
    end;
  end loop;
  perform public.transit_log_it(v_id, 'created', jsonb_build_object('lines', n, 'supplier', btrim(p ->> 'supplier'),
    'currency', v_cur, 'rate_to_aed', v_rate, 'source', coalesce(nullif(p ->> 'source', ''), 'manual')));
  return jsonb_build_object('id', v_id, 'lines', n);
end $$;

-- ------------------------------------------------ edit a PO (staff fields)
-- p: {id, expected_delivery?, payment_status?, delivery_status?, notes?,
--     quote_ref?, po_date?, supplier?} -- only the keys present change.
create or replace function public.transit_update_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.transit_orders; v_pend numeric; v_recv numeric; v_new text; ch jsonb := '{}'; k text;
begin
  if not public.transit_access() then raise exception 'not_allowed'; end if;
  select * into o from public.transit_orders where id = (p ->> 'id')::bigint for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if p ? 'delivery_status' and (p ->> 'delivery_status') is distinct from o.delivery_status then
    v_new := p ->> 'delivery_status';
    select coalesce(sum(qty_pending), 0), coalesce(sum(qty_received), 0) into v_pend, v_recv from public.transit_lines where order_id = o.id;
    if v_new not in ('ordered', 'in_transit', 'partially_received', 'pending_qc', 'completed', 'cancelled') then raise exception 'status_invalid'; end if;
    if v_new = 'cancelled' then raise exception 'cancel_through_admin'; end if;           -- cancelling = transit_cancel (Admins)
    if o.delivery_status = 'cancelled' then raise exception 'order_cancelled'; end if;
    if v_new = 'completed' and v_pend > 0 then raise exception 'still_pending'; end if;  -- Completed only when all received
    if v_new <> 'completed' and v_pend <= 0 then raise exception 'nothing_pending'; end if;
    if v_new = 'partially_received' and v_recv <= 0 then raise exception 'nothing_received'; end if;
    if v_new in ('ordered') and v_recv > 0 then raise exception 'already_received'; end if;
    ch := ch || jsonb_build_object('delivery_status', jsonb_build_array(o.delivery_status, v_new));
    update public.transit_orders set delivery_status = v_new where id = o.id;
  end if;
  if p ? 'payment_status' and (p ->> 'payment_status') is distinct from o.payment_status then
    if (p ->> 'payment_status') not in ('tbc', 'unpaid', 'partially_paid', 'paid') then raise exception 'payment_status_invalid'; end if;
    ch := ch || jsonb_build_object('payment_status', jsonb_build_array(o.payment_status, p ->> 'payment_status'));
    update public.transit_orders set payment_status = p ->> 'payment_status' where id = o.id;
  end if;
  if p ? 'expected_delivery' and nullif(p ->> 'expected_delivery', '')::date is distinct from o.expected_delivery then
    ch := ch || jsonb_build_object('expected_delivery', jsonb_build_array(o.expected_delivery, nullif(p ->> 'expected_delivery', '')));
    update public.transit_orders set expected_delivery = nullif(p ->> 'expected_delivery', '')::date where id = o.id;
  end if;
  if p ? 'po_date' and nullif(p ->> 'po_date', '')::date is distinct from o.po_date then
    ch := ch || jsonb_build_object('po_date', jsonb_build_array(o.po_date, nullif(p ->> 'po_date', '')));
    update public.transit_orders set po_date = nullif(p ->> 'po_date', '')::date where id = o.id;
  end if;
  foreach k in array array['notes', 'quote_ref', 'supplier'] loop
    if p ? k and nullif(btrim(p ->> k), '') is distinct from (to_jsonb(o) ->> k) then
      if k = 'supplier' and nullif(btrim(p ->> k), '') is null then raise exception 'supplier_missing'; end if;
      ch := ch || jsonb_build_object(k, jsonb_build_array(to_jsonb(o) ->> k, nullif(btrim(p ->> k), '')));
      execute format('update public.transit_orders set %I = $1 where id = $2', k) using nullif(btrim(p ->> k), ''), o.id;
    end if;
  end loop;
  if ch = '{}' then return jsonb_build_object('changed', false); end if;
  update public.transit_orders set updated_at = now() where id = o.id;
  perform public.transit_log_it(o.id, 'updated', ch);
  return jsonb_build_object('changed', true, 'changes', ch);
end $$;

-- ------------------------------------- Admins: change lines (with a reason)
-- p: {order_id, reason, changes: [
--   {action:'add', item_code, description, unit, qty_ordered, unit_price, freedom_item_id}
--   {action:'edit', line_id, qty_ordered?, unit_price?, description?, unit?}
--   {action:'remove', line_id}            -- only a line with nothing received
-- ], rate_to_aed?, currency?}
create or replace function public.transit_admin_change(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.transit_orders; c jsonb; l public.transit_lines; lv record; v_no int; log jsonb := '[]';
begin
  if not (public.transit_access() and public.is_admin()) then raise exception 'admins_only'; end if;
  if btrim(coalesce(p ->> 'reason', '')) = '' then raise exception 'reason_missing'; end if;
  select * into o from public.transit_orders where id = (p ->> 'order_id')::bigint for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if p ? 'currency' or p ? 'rate_to_aed' then
    if upper(coalesce(p ->> 'currency', o.currency)) = 'AED' then
      update public.transit_orders set currency = 'AED', rate_to_aed = 1 where id = o.id;
    elsif jsonb_typeof(p -> 'rate_to_aed') = 'number' and (p ->> 'rate_to_aed')::numeric > 0 then
      update public.transit_orders set currency = upper(coalesce(p ->> 'currency', o.currency)), rate_to_aed = (p ->> 'rate_to_aed')::numeric where id = o.id;
    else raise exception 'rate_missing';
    end if;
    log := log || jsonb_build_object('currency', jsonb_build_array(o.currency || ' ' || o.rate_to_aed, upper(coalesce(p ->> 'currency', o.currency)) || ' ' || coalesce(p ->> 'rate_to_aed', '1')));
  end if;
  for c in select * from jsonb_array_elements(coalesce(p -> 'changes', '[]')) loop
    if c ->> 'action' = 'add' then
      select * into lv from public.transit_line_values(o.inventory, c);
      select coalesce(max(line_no), 0) + 1 into v_no from public.transit_lines where order_id = o.id;
      begin
        insert into public.transit_lines (order_id, line_no, item_code, description, freedom_item_id, renson_item_id, unit, qty_ordered, unit_price)
        values (o.id, v_no, lv.o_code, lv.o_desc, lv.o_fid, lv.o_rid, lv.o_unit, lv.o_qty, lv.o_price);
      exception when unique_violation then raise exception 'duplicate_line: %', coalesce(lv.o_code, lv.o_desc);
      end;
      log := log || jsonb_build_object('add', jsonb_build_object('line_no', v_no, 'code', lv.o_code, 'qty', lv.o_qty, 'price', lv.o_price));
    else
      select * into l from public.transit_lines where id = (c ->> 'line_id')::bigint and order_id = o.id for update;
      if l.id is null then raise exception 'line_not_found'; end if;
      if c ->> 'action' = 'remove' then
        if l.qty_received > 0 or exists (select 1 from public.transit_receipt_lines where line_id = l.id) then raise exception 'line_has_receipts'; end if;
        delete from public.transit_lines where id = l.id;
        log := log || jsonb_build_object('remove', jsonb_build_object('line_no', l.line_no, 'code', l.item_code, 'qty', l.qty_ordered));
      elsif c ->> 'action' = 'edit' then
        if c ? 'qty_ordered' then
          if jsonb_typeof(c -> 'qty_ordered') <> 'number' or (c ->> 'qty_ordered')::numeric <= 0 then raise exception 'line_qty_invalid'; end if;
          if (c ->> 'qty_ordered')::numeric < l.qty_received + l.qty_cancelled then raise exception 'below_received'; end if;
        end if;
        if c ? 'unit_price' and jsonb_typeof(c -> 'unit_price') = 'number' and (c ->> 'unit_price')::numeric < 0 then raise exception 'line_price_invalid'; end if;
        if c ? 'description' and btrim(coalesce(c ->> 'description', '')) = '' then raise exception 'line_description_missing'; end if;
        update public.transit_lines set
          qty_ordered = case when c ? 'qty_ordered' then (c ->> 'qty_ordered')::numeric else qty_ordered end,
          unit_price = case when c ? 'unit_price' then (c ->> 'unit_price')::numeric else unit_price end,
          description = case when c ? 'description' then btrim(c ->> 'description') else description end,
          unit = case when c ? 'unit' then nullif(btrim(c ->> 'unit'), '') else unit end,
          updated_at = now()
        where id = l.id;
        log := log || jsonb_build_object('edit', jsonb_build_object('line_no', l.line_no, 'code', l.item_code,
          'before', jsonb_build_object('qty_ordered', l.qty_ordered, 'unit_price', l.unit_price, 'description', l.description, 'unit', l.unit),
          'after', c - 'action' - 'line_id'));
      else raise exception 'action_invalid';
      end if;
    end if;
  end loop;
  if not exists (select 1 from public.transit_lines where order_id = o.id) then raise exception 'lines_missing'; end if;
  update public.transit_orders set updated_at = now() where id = o.id;
  perform public.transit_refresh_status(o.id);
  perform public.transit_log_it(o.id, 'admin_change', jsonb_build_object('reason', btrim(p ->> 'reason'), 'changes', log));
  return jsonb_build_object('ok', true, 'changes', jsonb_array_length(log));
end $$;

-- --------------------------------------- Admins: cancel remaining quantities
-- p: {order_id, reason, line_id? (none = every line), qty? (none = all pending)}
create or replace function public.transit_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.transit_orders; l public.transit_lines; v_qty numeric; log jsonb := '[]'; v_status text;
begin
  if not (public.transit_access() and public.is_admin()) then raise exception 'admins_only'; end if;
  if btrim(coalesce(p ->> 'reason', '')) = '' then raise exception 'reason_missing'; end if;
  select * into o from public.transit_orders where id = (p ->> 'order_id')::bigint for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if p ? 'qty' and p ->> 'line_id' is null then raise exception 'qty_needs_line'; end if;
  for l in select * from public.transit_lines where order_id = o.id
      and (p ->> 'line_id' is null or id = (p ->> 'line_id')::bigint) order by line_no for update loop
    v_qty := case when p ? 'qty' then (p ->> 'qty')::numeric else l.qty_pending end;
    if v_qty is null or v_qty < 0 or v_qty > l.qty_pending then raise exception 'cancel_more_than_pending'; end if;
    if v_qty = 0 then continue; end if;
    update public.transit_lines set qty_cancelled = qty_cancelled + v_qty, updated_at = now() where id = l.id;
    log := log || jsonb_build_object('line_no', l.line_no, 'code', l.item_code, 'qty', v_qty);
  end loop;
  if jsonb_array_length(log) = 0 then raise exception 'nothing_to_cancel'; end if;
  v_status := public.transit_refresh_status(o.id);
  perform public.transit_log_it(o.id, 'cancelled', jsonb_build_object('reason', btrim(p ->> 'reason'), 'lines', log));
  return jsonb_build_object('ok', true, 'lines', jsonb_array_length(log), 'status', v_status);
end $$;

-- --------------------------- Admins: delete a PO that has nothing received
create or replace function public.transit_delete_order(p_id bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.transit_orders;
begin
  if not (public.transit_access() and public.is_admin()) then raise exception 'admins_only'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'reason_missing'; end if;
  select * into o from public.transit_orders where id = p_id for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if exists (select 1 from public.transit_receipts where order_id = o.id) then raise exception 'order_has_receipts'; end if;
  perform public.transit_log_it(o.id, 'deleted', jsonb_build_object('reason', btrim(p_reason), 'supplier', o.supplier,
    'lines', (select jsonb_agg(jsonb_build_object('code', item_code, 'description', description, 'qty', qty_ordered, 'price', unit_price) order by line_no)
              from public.transit_lines where order_id = o.id)));
  delete from public.transit_orders where id = o.id;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------ receive (after Check-in)
-- p: {receive_key (uuid, made by the browser once per Receive), order_id,
--     delivery_note_no, delivery_date, checkin_kind ('freedom'|'renson'),
--     checkin_tx_ids [ids of the Check-in's stock lines], checkin_reference,
--     document_name, lines: [{line_id, qty}]}
-- The Check-in must already be saved: every id must be a 'check_in' line of
-- that inventory, entered by the same person (an Admin may link anyone's),
-- and not already linked to another delivery of this PO. A retry with the
-- same receive_key returns the first result and changes nothing.
create or replace function public.transit_receive(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.transit_orders; v_key uuid; v_rid bigint; e jsonb; l public.transit_lines; v_ids text[]; v_found int;
        v_admin boolean := public.is_admin(); v_n int := 0; v_status text; seen bigint[] := '{}';
begin
  if not public.transit_access() then raise exception 'not_allowed'; end if;
  v_key := (p ->> 'receive_key')::uuid;
  if v_key is null then raise exception 'receive_key_missing'; end if;
  perform pg_advisory_xact_lock(hashtext('transit_receive'));
  select id into v_rid from public.transit_receipts where receive_key = v_key;
  if v_rid is not null then
    return jsonb_build_object('already', true, 'receipt_id', v_rid,
      'status', (select delivery_status from public.transit_orders o2 join public.transit_receipts r on r.order_id = o2.id where r.id = v_rid));
  end if;
  select * into o from public.transit_orders where id = (p ->> 'order_id')::bigint for update;
  if o.id is null then raise exception 'order_not_found'; end if;
  if o.delivery_status in ('cancelled', 'completed') then raise exception 'order_closed'; end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then raise exception 'lines_missing'; end if;
  if coalesce(p ->> 'checkin_kind', '') <> o.inventory then raise exception 'checkin_wrong_inventory'; end if;
  if jsonb_typeof(p -> 'checkin_tx_ids') <> 'array' or jsonb_array_length(p -> 'checkin_tx_ids') = 0 then raise exception 'checkin_missing'; end if;
  select array_agg(distinct x) into v_ids from jsonb_array_elements_text(p -> 'checkin_tx_ids') x;
  if o.inventory = 'freedom' then
    if exists (select 1 from unnest(v_ids) x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'checkin_not_found'; end if;
    select count(*) into v_found from public.inventory_transactions t
      where t.id = any (v_ids::uuid[]) and t.type = 'check_in' and (v_admin or t.performed_by = auth.uid());
  else
    if exists (select 1 from unnest(v_ids) x where x !~ '^[0-9]+$') then raise exception 'checkin_not_found'; end if;
    select count(*) into v_found from public.renson_transactions t
      where t.id = any (v_ids::bigint[]) and t.type = 'check_in' and (v_admin or t.performed_by = auth.uid());
  end if;
  if v_found <> cardinality(v_ids) then raise exception 'checkin_not_found'; end if;
  if exists (select 1 from public.transit_receipts r where r.order_id = o.id and r.checkin_tx_ids && v_ids) then
    raise exception 'checkin_already_used';
  end if;
  insert into public.transit_receipts (order_id, receive_key, delivery_note_no, delivery_date, checkin_kind, checkin_tx_ids,
      checkin_reference, document_name, received_by, received_by_name)
  values (o.id, v_key, nullif(btrim(p ->> 'delivery_note_no'), ''), nullif(p ->> 'delivery_date', '')::date, o.inventory, v_ids,
      nullif(left(btrim(p ->> 'checkin_reference'), 120), ''), nullif(left(p ->> 'document_name', 300), ''), auth.uid(), public.transit_who())
  returning id into v_rid;
  for e in select * from jsonb_array_elements(p -> 'lines') loop
    if jsonb_typeof(e -> 'qty') <> 'number' or (e ->> 'qty')::numeric <= 0 then raise exception 'qty_invalid'; end if;
    select * into l from public.transit_lines where id = (e ->> 'line_id')::bigint and order_id = o.id for update;
    if l.id is null then raise exception 'line_not_found'; end if;
    if l.id = any (seen) then raise exception 'line_twice'; end if;
    seen := seen || l.id;
    if (e ->> 'qty')::numeric > l.qty_pending then raise exception 'more_than_pending: % (pending %)', coalesce(l.item_code, l.description), l.qty_pending; end if;
    insert into public.transit_receipt_lines (receipt_id, line_id, qty) values (v_rid, l.id, (e ->> 'qty')::numeric);
    update public.transit_lines set qty_received = qty_received + (e ->> 'qty')::numeric, updated_at = now() where id = l.id;
    v_n := v_n + 1;
  end loop;
  -- a delivery ends "Pending QC" / sets the received status afresh
  update public.transit_orders set delivery_status = case when delivery_status = 'pending_qc' then 'partially_received' else delivery_status end where id = o.id;
  v_status := public.transit_refresh_status(o.id);
  update public.transit_orders set updated_at = now() where id = o.id;
  perform public.transit_log_it(o.id, 'received', jsonb_build_object('receipt_id', v_rid, 'lines', v_n,
    'delivery_note_no', nullif(btrim(p ->> 'delivery_note_no'), ''), 'checkin_reference', nullif(btrim(p ->> 'checkin_reference'), ''),
    'checkin_lines', cardinality(v_ids)));
  return jsonb_build_object('already', false, 'receipt_id', v_rid, 'lines', v_n, 'status', v_status);
end $$;

-- ------------------------------------------------ supporting documents
create or replace function public.transit_add_document(p_order bigint, p_kind text, p_name text, p_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not public.transit_access() then raise exception 'not_allowed'; end if;
  if not exists (select 1 from public.transit_orders where id = p_order) then raise exception 'order_not_found'; end if;
  if p_path !~ ('^' || p_order || '/[0-9a-f]{64}\.(pdf|xlsx|xls)$')
     or not exists (select 1 from storage.objects where bucket_id = 'transit-documents' and name = p_path) then
    raise exception 'file_not_stored';
  end if;
  select id into v_id from public.transit_documents where path = p_path;
  if v_id is not null then return jsonb_build_object('id', v_id, 'already', true); end if;
  insert into public.transit_documents (order_id, kind, name, path, uploaded_by, uploaded_by_name)
  values (p_order, coalesce(nullif(p_kind, ''), 'other'), left(coalesce(nullif(btrim(p_name), ''), 'document'), 300), p_path, auth.uid(), public.transit_who())
  returning id into v_id;
  perform public.transit_log_it(p_order, 'document_added', jsonb_build_object('name', p_name, 'kind', p_kind));
  return jsonb_build_object('id', v_id, 'already', false);
end $$;

do $$ declare f text; begin
  foreach f in array array['transit_create_order(jsonb)', 'transit_update_order(jsonb)', 'transit_admin_change(jsonb)',
      'transit_cancel(jsonb)', 'transit_delete_order(bigint, text)', 'transit_receive(jsonb)', 'transit_add_document(bigint, text, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Go back (from the SQL Editor; stock is never involved):
--   drop the functions transit_*, the tables transit_log, transit_documents,
--   transit_receipt_lines, transit_receipts, transit_lines, transit_orders,
--   the two storage policies transit_documents_staff_*, and the bucket
--   transit-documents (after emptying it).
