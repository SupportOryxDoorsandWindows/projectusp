-- Monthly opening / closing stock (Freedom inventory). Applied 2026-11-04.
--
-- Owner's rule (2026-11-04):
--   * November 2026: opening qty / value = "Opening Count" / "Total opening
--     cost" of FLYSCREEN STOCK OCT 14.xlsx; unit cost = "OPENING COST PER
--     PROFILE". Items not in the file kept their figures. (Set directly the
--     same day, together with clearing the movement history to the 11
--     documents of Transaction_Summary_.xlsx; full copies before the change:
--     backup.inventory_transactions_2026_11_04, backup.inventory_items_2026_11_04.)
--   * Closing = opening + check-ins - check-outs = inventory_items.current_qty;
--     closing value = closing qty x unit cost (check-ins re-average the cost,
--     as before).
--   * Every following month: the opening is last month's closing.
--
-- How: stock_month_balances keeps one row per item per month. On the 1st of
-- each month (Dubai time) roll_stock_month() writes last month's closing,
-- opens the new month with it and copies it into inventory_items.opening_qty /
-- opening_value. Check-in / Check-out are not changed. Safe to run twice: a
-- month that is already open is left alone.
-- Undo: select cron.unschedule('roll-stock-month'); drop function
-- public.roll_stock_month(date); drop table public.stock_month_balances;

create table if not exists public.stock_month_balances (
  month date not null,                      -- first day of the month
  item_id uuid not null references public.inventory_items (id) on delete cascade,
  opening_qty numeric not null default 0,
  opening_value numeric not null default 0,
  closing_qty numeric,                      -- null while the month is open
  closing_value numeric,
  closing_unit_cost numeric,
  closed_at timestamptz,
  primary key (month, item_id)
);
comment on table public.stock_month_balances is
  'Freedom stock per item per month: opening (= last month''s closing) and closing (stock at month end). Written only by roll_stock_month().';

alter table public.stock_month_balances enable row level security;
revoke all on public.stock_month_balances from anon;
revoke insert, update, delete, truncate on public.stock_month_balances from authenticated;
grant select on public.stock_month_balances to authenticated;
drop policy if exists "Staff read month balances" on public.stock_month_balances;
create policy "Staff read month balances" on public.stock_month_balances
  for select to authenticated
  using ((select public.is_active_staff()));

-- Opens p_month (first day of a month). Closes the previous month first if it
-- is open. Returns what it did.
create or replace function public.roll_stock_month(p_month date default (date_trunc('month', now() at time zone 'Asia/Dubai'))::date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_prev date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_closed int := 0;
  v_opened int := 0;
begin
  if exists (select 1 from stock_month_balances where month = v_month) then
    return jsonb_build_object('ok', true, 'month', v_month, 'note', 'already_open');
  end if;

  -- Serialise with Check-in / Check-out while the figures are read.
  lock table inventory_items in share row exclusive mode;

  update stock_month_balances b
     set closing_qty = i.current_qty,
         closing_value = i.current_value,
         closing_unit_cost = i.unit_cost,
         closed_at = now()
    from inventory_items i
   where b.item_id = i.id and b.month = v_prev and b.closing_qty is null;
  get diagnostics v_closed = row_count;

  insert into stock_month_balances (month, item_id, opening_qty, opening_value)
  select v_month, id, coalesce(current_qty, 0), coalesce(current_value, 0) from inventory_items;
  get diagnostics v_opened = row_count;

  update inventory_items
     set opening_qty = coalesce(current_qty, 0),
         opening_value = coalesce(current_value, 0);

  return jsonb_build_object('ok', true, 'month', v_month, 'closed', v_closed, 'opened', v_opened);
end;
$$;
revoke all on function public.roll_stock_month(date) from public, anon, authenticated;

-- November 2026 opens with the figures set from the file today.
insert into public.stock_month_balances (month, item_id, opening_qty, opening_value)
select date '2026-11-01', id, coalesce(opening_qty, 0), coalesce(opening_value, 0)
  from public.inventory_items
on conflict do nothing;

-- Daily at 00:05 Dubai (20:05 UTC); only does something on the 1st.
select cron.schedule('roll-stock-month', '5 20 * * *', $c$
  select public.roll_stock_month()
   where extract(day from now() at time zone 'Asia/Dubai') = 1
$c$);
