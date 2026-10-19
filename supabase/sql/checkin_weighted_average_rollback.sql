-- GO BACK: undo supabase/sql/checkin_weighted_average.sql (2026-10-20).
--
-- Puts back checkin_transaction exactly as it was live before the weighted
-- average (a Check-in adds stock but leaves the item's unit_cost unchanged).
-- Run it in the Supabase SQL editor. It does NOT change any item's current
-- cost back: costs already averaged stay as they are. To also put an item's
-- cost back, each averaged Check-in line keeps unit_cost_before /
-- unit_cost_after (see the end of this file). The two columns are kept
-- (harmless; they stay empty from then on).

CREATE OR REPLACE FUNCTION public.checkin_transaction(p_supplier text, p_invoice_number text, p_po_number text, p_document_date date, p_pdf_hash text, p_doc_name text, p_currency text, p_exchange_rate numeric, p_rate_date date, p_rate_source text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dup int;
  v_line jsonb;
  v_new jsonb;
  v_item record;
  v_qty numeric;
  v_line_cost numeric;
  v_orig_cost numeric;
  v_ship_total numeric;
  v_ship_alloc numeric;
  v_landed_cost numeric;
  v_new_item_id uuid;
  v_new_code text;
  v_new_desc text;
  v_results jsonb := '[]'::jsonb;
begin
  if p_pdf_hash is not null then
    select count(*) into v_dup from inventory_transactions where source_document_hash = p_pdf_hash;
    if v_dup > 0 then
      return jsonb_build_object('ok', false, 'error', 'duplicate_document');
    end if;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line->>'quantity')::numeric;
    if v_qty <= 0 then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    -- Landed-cost fields (Check-in's shipping/freight allocation) are
    -- computed by the browser -- see ciShippingAllocation() in fp-pro.js --
    -- and carried per-line here, same pattern as package_type/package_cost
    -- below, rather than as a new top-level parameter (adding one would
    -- create a second overload of this function alongside the existing
    -- 11-arg signature and risk a "function is not unique" ambiguity at
    -- call time). All three are optional/nullable: absent entirely for a
    -- document with no shipping charge, which leaves every existing
    -- calculation below completely unchanged.
    v_ship_total := (v_line->>'shipping_cost_total')::numeric;
    v_ship_alloc := (v_line->>'shipping_allocated')::numeric;
    v_landed_cost := (v_line->>'landed_unit_cost')::numeric;

    if v_line->>'item_id' is not null then
      select * into v_item from inventory_items where id = (v_line->>'item_id')::uuid for update;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'item_not_found', 'item_id', v_line->>'item_id');
      end if;
      v_line_cost := coalesce((v_line->>'unit_cost')::numeric, v_item.unit_cost);
      v_orig_cost := (v_line->>'original_unit_cost')::numeric;

      update inventory_items
        set current_qty = current_qty + v_qty,
            current_value = (current_qty + v_qty) * unit_cost,
            updated_at = now()
        where id = v_item.id;

      insert into inventory_transactions
        (type, item_id, item_code, description, quantity, unit,
         unit_cost_used, value, classification, source_document_name, source_document_hash,
         supplier, invoice_number, po_number, document_date,
         original_currency, original_unit_cost, original_value, exchange_rate,
         rate_date, rate_source,
         package_type, package_qty, qty_per_package, package_unit, package_cost,
         shipping_cost_total, shipping_allocated, landed_unit_cost)
      values
        ('check_in', v_item.id, v_item.item_code, v_item.description,
         v_qty, coalesce(v_line->>'unit', ''),
         v_line_cost, v_qty * v_line_cost,
         v_item.classification, p_doc_name, p_pdf_hash,
         p_supplier, p_invoice_number, p_po_number, p_document_date,
         p_currency, v_orig_cost, v_orig_cost * v_qty, p_exchange_rate,
         p_rate_date, p_rate_source,
         v_line->>'package_type', (v_line->>'package_qty')::numeric, (v_line->>'qty_per_package')::numeric,
         v_line->>'package_unit', (v_line->>'package_cost')::numeric,
         v_ship_total, v_ship_alloc, v_landed_cost);

      v_results := v_results || jsonb_build_object(
        'item_id', v_item.id, 'item_code', v_item.item_code,
        'added', v_qty, 'new_qty', v_item.current_qty + v_qty, 'is_new_item', false);

    else
      v_new := v_line->'new_item';
      if v_new is null then
        return jsonb_build_object('ok', false, 'error', 'missing_new_item_data');
      end if;

      v_new_code := nullif(trim(v_new->>'item_code'), '');
      v_new_desc := nullif(trim(v_new->>'description'), '');
      if v_new_code is null or v_new_desc is null or nullif(trim(v_new->>'unit_of_measure'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'invalid_new_item');
      end if;
      if nullif(trim(v_new->>'approved_by'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'approver_required');
      end if;

      v_line_cost := (v_line->>'unit_cost')::numeric;
      if v_line_cost is null or v_line_cost <= 0 then
        return jsonb_build_object('ok', false, 'error', 'missing_unit_cost_for_new_item');
      end if;
      v_orig_cost := (v_line->>'original_unit_cost')::numeric;

      if exists (select 1 from inventory_items where lower(item_code) = lower(v_new_code)) then
        return jsonb_build_object('ok', false, 'error', 'duplicate_code', 'item_code', v_new_code);
      end if;

      insert into inventory_items
        (item_code, description, classification, category, unit_of_measure,
         unit_cost, opening_qty, opening_value, current_qty, current_value, buffer_level, status)
      values
        (v_new_code, v_new_desc, 'freedom', nullif(trim(v_new->>'category'), ''),
         coalesce(nullif(trim(v_new->>'unit_of_measure'), ''), 'pcs'),
         v_line_cost, 0, 0, v_qty, v_qty * v_line_cost,
         nullif(v_new->>'buffer_level', '')::numeric, 'active')
      returning id into v_new_item_id;

      insert into inventory_transactions
        (type, item_id, item_code, description, quantity, unit,
         unit_cost_used, value, classification, source_document_name, source_document_hash,
         supplier, invoice_number, po_number, document_date,
         original_currency, original_unit_cost, original_value, exchange_rate,
         rate_date, rate_source, approved_by, is_new_item,
         package_type, package_qty, qty_per_package, package_unit, package_cost,
         shipping_cost_total, shipping_allocated, landed_unit_cost)
      values
        ('check_in', v_new_item_id, v_new_code, v_new_desc,
         v_qty, coalesce(v_line->>'unit', ''),
         v_line_cost, v_qty * v_line_cost,
         'freedom', p_doc_name, p_pdf_hash,
         p_supplier, p_invoice_number, p_po_number, p_document_date,
         p_currency, v_orig_cost, v_orig_cost * v_qty, p_exchange_rate,
         p_rate_date, p_rate_source, trim(v_new->>'approved_by'), true,
         v_line->>'package_type', (v_line->>'package_qty')::numeric, (v_line->>'qty_per_package')::numeric,
         v_line->>'package_unit', (v_line->>'package_cost')::numeric,
         v_ship_total, v_ship_alloc, v_landed_cost);

      v_results := v_results || jsonb_build_object(
        'item_id', v_new_item_id, 'item_code', v_new_code,
        'added', v_qty, 'new_qty', v_qty, 'is_new_item', true);
    end if;
  end loop;

  if p_currency is not null and p_currency <> 'AED' and p_exchange_rate is not null and p_exchange_rate > 0 then
    insert into exchange_rates (currency, rate_to_aed, updated_at)
      values (p_currency, p_exchange_rate, now())
      on conflict (currency) do update set rate_to_aed = excluded.rate_to_aed, updated_at = now();
  end if;

  return jsonb_build_object('ok', true, 'lines', v_results);
end;
$function$;

revoke execute on function public.checkin_transaction(text,text,text,date,text,text,text,numeric,date,text,jsonb) from public, anon, authenticated;
grant execute on function public.checkin_transaction(text,text,text,date,text,text,text,numeric,date,text,jsonb) to service_role;

-- Optional, only if told to: every item's cost before its FIRST averaged
-- Check-in. Look before you change anything:
--   select distinct on (item_id) item_id, item_code, unit_cost_before, created_at
--   from inventory_transactions where unit_cost_after is not null
--   order by item_id, created_at;
