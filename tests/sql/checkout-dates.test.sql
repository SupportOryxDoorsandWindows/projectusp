-- Local test of supabase/sql/checkout_dates_2026_11_03.sql (never the live
-- project). Run on a fresh database after supabase-base.sql + inventory-base.sql:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/supabase-base.sql -f tests/sql/inventory-base.sql \
--        -f tests/sql/checkout-dates.test.sql
-- Made-up rows: 2 lines of 26294 (entered 2 Nov 09:23 Dubai), 1 line of 26391
-- (2 Nov 10:42), one other Check-out on 2 Nov that is NOT in the list, and a
-- Check-in carrying a listed hash. Only the listed Check-outs may move.
insert into public.inventory_transactions (id, type, job_number, item_code, quantity, value, source_document_hash, created_at) values
 ('00000000-0000-0000-0000-000000000001','check_out','26294','A',1,10,'9a5bde81a2aae26a3e3fe1d5cde0c3b37322b7e5b8819a5d14cd4883e29783c4','2026-11-02 05:23:42+00'),
 ('00000000-0000-0000-0000-000000000002','check_out','26294','B',2,20,'9a5bde81a2aae26a3e3fe1d5cde0c3b37322b7e5b8819a5d14cd4883e29783c4','2026-11-02 05:23:42+00'),
 ('00000000-0000-0000-0000-000000000003','check_out','26391','C',3,30,'1611638ef49eb0003b6e2221e959f4664cc847565f8cd87f672c3e58397987d9','2026-11-02 06:42:11+00'),
 ('00000000-0000-0000-0000-000000000004','check_out','99999','D',4,40,'ffff','2026-11-02 07:00:00+00'),
 ('00000000-0000-0000-0000-000000000005','check_in','x','E',5,50,'9a5bde81a2aae26a3e3fe1d5cde0c3b37322b7e5b8819a5d14cd4883e29783c4','2026-11-02 08:00:00+00');

\i supabase/sql/checkout_dates_2026_11_03.sql
-- running it twice changes nothing more
\i supabase/sql/checkout_dates_2026_11_03.sql

do $$
declare n int;
begin
  -- 26294 -> 9 Oct, same time of day (09:23:42 Dubai = 05:23:42 UTC)
  select count(*) into n from public.inventory_transactions where job_number = '26294' and created_at = '2026-10-09 05:23:42+00';
  if n <> 2 then raise exception 'FAIL 26294 lines: %', n; end if;
  -- 26391 -> printout date 7 Oct
  select count(*) into n from public.inventory_transactions where job_number = '26391' and created_at = '2026-10-07 06:42:11+00';
  if n <> 1 then raise exception 'FAIL 26391: %', n; end if;
  -- not listed / not a check_out: unchanged
  select count(*) into n from public.inventory_transactions where id in ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005')
    and created_at::date = '2026-11-02';
  if n <> 2 then raise exception 'FAIL others moved'; end if;
  -- quantities / values untouched
  select count(*) into n from public.inventory_transactions where (quantity, value) in ((1,10),(2,20),(3,30),(4,40),(5,50));
  if n <> 5 then raise exception 'FAIL values changed'; end if;
  -- one log row per moved line, even after the second run
  select count(*) into n from public.transaction_date_corrections;
  if n <> 3 then raise exception 'FAIL log rows: %', n; end if;
  raise notice 'checkout-dates: all checks passed';
end $$;

-- undo restores the entry dates exactly
update public.inventory_transactions t set created_at = c.old_created_at
  from public.transaction_date_corrections c where c.transaction_id = t.id;
do $$ begin
  if (select count(*) from public.inventory_transactions where created_at::date = '2026-11-02') <> 5 then raise exception 'FAIL undo'; end if;
  raise notice 'checkout-dates: undo restores the dates';
end $$;
