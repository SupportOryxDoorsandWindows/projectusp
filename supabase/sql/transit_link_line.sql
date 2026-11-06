-- Link a PO line to its Master Inventory item afterwards (2026-11-06, owner:
-- "is it possible to have the materials in transit reflected in the Master
-- Inventory?"; answer "Link them in the PO"). Run after
-- materials_in_transit.sql. No DROP. Re-run safe.
--
-- Master Inventory shows, per item, what is still pending on open POs: only
-- lines LINKED to that item (transit_lines.freedom_item_id / renson_item_id).
-- Lines saved without a link (310028 has several bar lengths, so the person
-- must choose; or the item was not in Master yet) can now be linked from the
-- PO window by any active staff member:
--   transit_link_line(p_line_id, p_item_id text)
--     Freedom PO: p_item_id = inventory_items.id (uuid); Renson PO:
--     renson_items.id. The item must carry the SAME code as the line (a line
--     without a code can't be linked: never guessed from the description),
--     and the line must not be linked yet (no re-pointing). Logged in
--     transit_log ('link'). Nothing else changes: not the quantities, the
--     status, the stock or the costs.

create or replace function public.transit_link_line(p_line_id bigint, p_item_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.transit_lines; o public.transit_orders; v_fid uuid; v_rid bigint; v_desc text;
begin
  if not public.transit_access() then raise exception 'not_allowed'; end if;
  select * into l from public.transit_lines where id = p_line_id for update;
  if l.id is null then raise exception 'line_not_found'; end if;
  select * into o from public.transit_orders where id = l.order_id;
  if l.freedom_item_id is not null or l.renson_item_id is not null then raise exception 'already_linked'; end if;
  if l.item_code is null then raise exception 'line_has_no_code'; end if;
  if nullif(btrim(coalesce(p_item_id, '')), '') is null then raise exception 'item_missing'; end if;
  if o.inventory = 'renson' then
    if p_item_id !~ '^[0-9]+$' then raise exception 'line_item_mismatch'; end if;
    select id, description into v_rid, v_desc from public.renson_items
      where id = p_item_id::bigint and upper(btrim(item_code)) = upper(btrim(l.item_code));
    if v_rid is null then raise exception 'line_item_mismatch'; end if;
    update public.transit_lines set renson_item_id = v_rid, updated_at = now() where id = l.id;
  else
    if p_item_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'line_item_mismatch'; end if;
    select id, description || coalesce(' · ' || bar_length_mm || ' mm', '') into v_fid, v_desc from public.inventory_items
      where id = p_item_id::uuid and upper(btrim(item_code)) = upper(btrim(l.item_code));
    if v_fid is null then raise exception 'line_item_mismatch'; end if;
    update public.transit_lines set freedom_item_id = v_fid, updated_at = now() where id = l.id;
  end if;
  perform public.transit_log_it(o.id, 'link', jsonb_build_object('line_no', l.line_no, 'code', l.item_code, 'item', v_desc));
  return jsonb_build_object('ok', true, 'line_id', l.id, 'item', v_desc);
end $$;
revoke all on function public.transit_link_line(bigint, text) from public, anon;
grant execute on function public.transit_link_line(bigint, text) to authenticated;
