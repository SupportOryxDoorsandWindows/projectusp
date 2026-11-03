-- Quotation S00155 (Freedom Screens Global, checked in 23 Oct 2026, 29 lines)
-- went in WITHOUT its "Shipping Crate 1.00 Units USD 900.00" line: the reader
-- did not treat the crate as shipping then (fixed 2026-11-03 in
-- fp-checkin-read.js). Owner's decision 2026-11-03: "Add it to current cost"
-- -- raise the average cost of the 29 items by what the crate would have added,
-- on the stock still on hand; past Check-outs (60 lines since) keep their
-- values; the S00155 Check-in lines themselves are NOT rewritten.
--
-- How (the same rules the Check-in uses):
--   * shipping is split EQUALLY per line: USD 900 / 29 lines x the line's own
--     exchange rate (3.6725) = AED 113.97 per line;
--   * weighted average (checkin_weighted_average.sql): had the share been in
--     the price, the average after the Check-in would have been higher by
--     share / (stock before + qty received) -- or share / qty received when
--     the average was not used (no stock / no cost before);
--   * "stock before" = current stock minus every movement ENTERED after the
--     Check-in (entry time = transaction_date_corrections.old_created_at when
--     a date was corrected); it reproduces every line's stored average
--     exactly (checked 2026-11-03);
--   * no Check-in of these items since, so today's cost = that average; the
--     correction is added to it (6 decimals, like the Check-in), and
--     current_value = stock x new cost (as stored everywhere).
-- Every change is logged in item_cost_corrections (old/new cost and value).
-- UNDO: see the end of this file.

create table if not exists public.item_cost_corrections (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.inventory_items(id),
  item_code text,
  source text not null,
  share_aed numeric not null,
  stock_basis numeric not null,
  old_unit_cost numeric,
  new_unit_cost numeric not null,
  qty_on_hand numeric not null,
  old_value numeric,
  new_value numeric not null,
  reason text not null,
  corrected_at timestamptz not null default now()
);
alter table public.item_cost_corrections enable row level security;
revoke all on public.item_cost_corrections from anon, authenticated;
grant select on public.item_cost_corrections to authenticated;
-- (no DROP: the Supabase connector asks a confirmation that never reaches the user)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'item_cost_corrections'
                 and policyname = 'item_cost_corrections_staff_read') then
    create policy item_cost_corrections_staff_read on public.item_cost_corrections
      for select to authenticated using (public.is_active_staff());
  end if;
end $$;

with e as (
  select t.*, coalesce(d.old_created_at, t.created_at) as entered
  from public.inventory_transactions t left join public.transaction_date_corrections d on d.transaction_id = t.id
),
c as (select * from e where type = 'check_in' and invoice_number = 'S00155'),
n as (select count(*)::numeric as lines from c),
x as (
  select c.item_id, c.item_code, c.quantity as q, c.unit_cost_before as b, c.exchange_rate as r,
         (900 / (select lines from n)) * c.exchange_rate as share_aed,
         i.current_qty - (select coalesce(sum(case when t.type = 'check_in' then t.quantity else -t.quantity end), 0)
                          from e t where t.item_id = c.item_id and (t.entered > c.entered or t.id = c.id)) as s_before,
         i.unit_cost as now_cost, i.current_qty as now_qty, i.current_value as now_value
  from c join public.inventory_items i on i.id = c.item_id
  where not exists (select 1 from public.item_cost_corrections k where k.source = 'S00155 shipping crate')   -- once only
),
y as (
  select x.*, case when s_before > 0 and coalesce(b, 0) > 0 then s_before + q else q end as basis from x
),
z as (
  select y.*, round(now_cost + share_aed / basis, 6) as new_cost from y
),
logged as (
  insert into public.item_cost_corrections (item_id, item_code, source, share_aed, stock_basis, old_unit_cost, new_unit_cost,
                                            qty_on_hand, old_value, new_value, reason)
  select item_id, item_code, 'S00155 shipping crate', round(share_aed, 6), basis, now_cost, new_cost,
         now_qty, now_value, now_qty * new_cost,
         'S00155 checked in 23 Oct 2026 without its Shipping Crate USD 900; added to the average cost of the stock on hand (owner''s decision 2026-11-03)'
  from z returning item_id, new_unit_cost, new_value
)
update public.inventory_items i set unit_cost = l.new_unit_cost, current_value = l.new_value
from logged l where i.id = l.item_id;

-- UNDO (puts back the costs and values, then empties the log):
--   update public.inventory_items i set unit_cost = k.old_unit_cost, current_value = i.current_qty * k.old_unit_cost
--   from public.item_cost_corrections k where k.item_id = i.id and k.source = 'S00155 shipping crate';
--   delete from public.item_cost_corrections where source = 'S00155 shipping crate';
-- (only valid while those items' stock / cost have not moved since; otherwise
--  subtract new_unit_cost - old_unit_cost from today's cost instead.)
