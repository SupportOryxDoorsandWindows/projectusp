-- Local test of supabase/sql/s00155_crate_cost_2026_11_03.sql (never the
-- live project). Fresh database:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/supabase-base.sql -f tests/sql/inventory-base.sql \
--        -f tests/sql/s00155-crate-cost.test.sql
-- Made up: 2 S00155 lines at rate 4 -> share = 900 / 2 x 4 = AED 1,800 per line.
--   A: 10 in stock at 100 before, 10 received at 120 -> average 110; later
--      a Check-out of 5 ENTERED after the Check-in but dated before it (date
--      correction) and one of 3 after -> now 12 on hand at 110.
--      basis = 10 + 10 = 20 -> +90 -> 200; value 12 x 200 = 2,400.
--   B: no stock before, 5 received at 50 -> cost 50; now 5 on hand.
--      basis = 5 -> +360 -> 410; value 5 x 410 = 2,050.
--   C: an item not on S00155 -> untouched.
\set ON_ERROR_STOP 1
-- columns added live by checkin_weighted_average.sql
alter table public.inventory_transactions add column if not exists unit_cost_before numeric, add column if not exists unit_cost_after numeric;
create table if not exists public.transaction_date_corrections (id bigint generated always as identity primary key,
  transaction_id uuid not null, job_number text, source_document_hash text, old_created_at timestamptz not null,
  new_created_at timestamptz not null, reason text not null, corrected_at timestamptz not null default now());

insert into public.inventory_items (id, item_code, description, current_qty, unit_cost, current_value) values
 ('00000000-0000-0000-0000-00000000000a', 'A', 'Item A', 12, 110, 1320),
 ('00000000-0000-0000-0000-00000000000b', 'B', 'Item B', 5, 50, 250),
 ('00000000-0000-0000-0000-00000000000c', 'C', 'Item C', 7, 9, 63);
insert into public.inventory_transactions (id, type, item_id, item_code, quantity, unit_cost_used, value, invoice_number, exchange_rate, unit_cost_before, unit_cost_after, created_at) values
 ('00000000-0000-0000-0000-000000000101', 'check_in', '00000000-0000-0000-0000-00000000000a', 'A', 10, 120, 1200, 'S00155', 4, 100, 110, '2026-10-23 13:14:23+00'),
 ('00000000-0000-0000-0000-000000000102', 'check_in', '00000000-0000-0000-0000-00000000000b', 'B', 5, 50, 250, 'S00155', 4, null, 50, '2026-10-23 13:14:23+00'),
 -- entered 2 Nov, date corrected to 9 Oct (before the Check-in)
 ('00000000-0000-0000-0000-000000000201', 'check_out', '00000000-0000-0000-0000-00000000000a', 'A', 5, 110, 550, null, null, null, null, '2026-10-09 05:00:00+00'),
 ('00000000-0000-0000-0000-000000000202', 'check_out', '00000000-0000-0000-0000-00000000000a', 'A', 3, 110, 330, null, null, null, null, '2026-10-30 05:00:00+00');
insert into public.transaction_date_corrections (transaction_id, old_created_at, new_created_at, reason) values
 ('00000000-0000-0000-0000-000000000201', '2026-11-02 05:00:00+00', '2026-10-09 05:00:00+00', 'test');
create temp table tx_before as select md5(string_agg(t::text, '|' order by id)) h from public.inventory_transactions t;

\i supabase/sql/s00155_crate_cost_2026_11_03.sql
\i supabase/sql/s00155_crate_cost_2026_11_03.sql

do $$
declare a record; b record; c record; n int;
begin
  select * into a from public.inventory_items where item_code = 'A';
  select * into b from public.inventory_items where item_code = 'B';
  select * into c from public.inventory_items where item_code = 'C';
  if a.unit_cost <> 200 or a.current_value <> 2400 then raise exception 'FAIL A: % %', a.unit_cost, a.current_value; end if;
  if b.unit_cost <> 410 or b.current_value <> 2050 then raise exception 'FAIL B: % %', b.unit_cost, b.current_value; end if;
  if c.unit_cost <> 9 or c.current_value <> 63 then raise exception 'FAIL C touched'; end if;
  if a.current_qty <> 12 or b.current_qty <> 5 then raise exception 'FAIL stock changed'; end if;
  select count(*) into n from public.item_cost_corrections;
  if n <> 2 then raise exception 'FAIL log rows (second run must add none): %', n; end if;
  if (select md5(string_agg(t::text, '|' order by id)) from public.inventory_transactions t) <> (select h from tx_before) then
    raise exception 'FAIL transactions changed'; end if;
  raise notice 's00155-crate-cost: all checks passed';
end $$;

-- undo
update public.inventory_items i set unit_cost = k.old_unit_cost, current_value = i.current_qty * k.old_unit_cost
  from public.item_cost_corrections k where k.item_id = i.id and k.source = 'S00155 shipping crate';
do $$ begin
  if (select string_agg(item_code || '=' || unit_cost || '/' || current_value, ',' order by item_code) from public.inventory_items)
     <> 'A=110/1320,B=50/250,C=9/63' then raise exception 'FAIL undo'; end if;
  raise notice 's00155-crate-cost: undo restores costs and values';
end $$;
