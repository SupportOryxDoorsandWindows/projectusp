-- Check-out dates corrected to the production completion dates (2026-11-03).
-- User's request: the 10 Check-outs entered by Paulo Averil on 2 Nov 2026 were
-- completed in October ("please change the check out dates"). User's answers:
-- replace the date (original kept in the log below); 26397 = 29 Oct (last
-- completion); 26052 F1-5 and F1-7 = both 29 Oct; 26399 / 26391 (no
-- completion date) = the job list's printout date (22 Oct / 7 Oct).
-- Each Check-out keeps its time of day (Dubai), only the day changes.
-- ONLY inventory_transactions.created_at of these Check-outs changes: stock,
-- values, codes, quantities, people and documents are untouched.
-- UNDO: see the end of this file.

create table if not exists public.transaction_date_corrections (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.inventory_transactions(id),
  job_number text,
  source_document_hash text,
  old_created_at timestamptz not null,
  new_created_at timestamptz not null,
  reason text not null,
  corrected_at timestamptz not null default now()
);
alter table public.transaction_date_corrections enable row level security;
revoke all on public.transaction_date_corrections from anon, authenticated;
grant select on public.transaction_date_corrections to authenticated;
-- (no DROP: the Supabase connector asks a confirmation that never reaches the user)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'transaction_date_corrections'
                 and policyname = 'transaction_date_corrections_staff_read') then
    create policy transaction_date_corrections_staff_read on public.transaction_date_corrections
      for select to authenticated using (public.is_active_staff());
  end if;
end $$;

with fix(hash, new_day) as (values
  ('9a5bde81a2aae26a3e3fe1d5cde0c3b37322b7e5b8819a5d14cd4883e29783c4', date '2026-10-09'), -- 26294 Bushra Alzawawi
  ('cbeefaf1f6674bb1f42900a5cb0f13da54aa6538a9554982eaeaa251bdd5bb7a', date '2026-10-13'), -- 26273 Tim Dimmer
  ('57b35dabfd8a8fdadc17de293cf97816a8cb69e5a1d07cd446e301b026f9369c', date '2026-10-19'), -- 26371 Monique Hageman
  ('a8422912f07ee6fae62810785977e7c804944cf085027196e0f0bb5d0d432a43', date '2026-10-29'), -- 26052 F1-5 Totti Baker
  ('4f73ac6fb7b99c61764f62f3baca2fc675aa72803befbeb91b964afaa886bfaa', date '2026-10-29'), -- 26052 F1-7 Totti Baker
  ('3c6c21bb42c7b7ba558bad3787f6fbc8442488fe22bb36efee1e55fd0f9f60e2', date '2026-10-27'), -- 26256 James Clough
  ('ade1cfbc61afa7a166d82afd82ea24fb6cf59d9b4bc944d6dba14ff358c44c54', date '2026-10-29'), -- 26397 Eurolux / Steve Cass
  ('941ba75054703859abae0c3b221b2917d831b71a1da5f48d08d40b8f6498c6e2', date '2026-10-26'), -- 25313 Deepak Khullar
  ('f8dcfa7b18edcd64cc0d093a79859b137a436313f1cbcd1250ec3231e3bd62e7', date '2026-10-22'), -- 26399 Sara Apostolides (printout date)
  ('1611638ef49eb0003b6e2221e959f4664cc847565f8cd87f672c3e58397987d9', date '2026-10-07')  -- 26391 Catriona Hanley (printout date)
),
rows as (
  select t.id, t.job_number, t.source_document_hash, t.created_at as old_at,
         ((f.new_day + (t.created_at at time zone 'Asia/Dubai')::time) at time zone 'Asia/Dubai') as new_at
  from public.inventory_transactions t join fix f on f.hash = t.source_document_hash
  where t.type = 'check_out'
    and (t.created_at at time zone 'Asia/Dubai')::date = date '2026-11-02'   -- only rows not corrected yet
),
logged as (
  insert into public.transaction_date_corrections (transaction_id, job_number, source_document_hash, old_created_at, new_created_at, reason)
  select id, job_number, source_document_hash, old_at, new_at,
         'Check-out entered 2 Nov 2026; date set to the production completion date (owner''s request 2026-11-03)'
  from rows returning transaction_id, new_created_at
)
update public.inventory_transactions t set created_at = l.new_created_at
from logged l where t.id = l.transaction_id;

-- UNDO (puts back the entry dates, then empties the log):
--   update public.inventory_transactions t set created_at = c.old_created_at
--   from public.transaction_date_corrections c where c.transaction_id = t.id;
--   delete from public.transaction_date_corrections;
