-- Staff-only reading (applied 2026-10-14). Replaces open-read-access.sql /
-- revert-read-access.sql.
--
-- Before: the product data, Master Inventory (stock, costs), every Check-in /
-- Check-out (clients, order numbers, who did it) and the drawings could be
-- READ by anyone with the public key in config.js (public GitHub page).
-- After: only a signed-in, ACTIVE staff account (is_active_staff()) can read
-- them; anonymous visitors and switched-off accounts get nothing. Writes are
-- unchanged (there were never write policies on these tables).
--
-- The site loads everything only after sign-in (boot.js), and since this
-- change the drawings use temporary signed links (boot.js signDrawingLinks),
-- so staff see no difference.
--
-- NOT changed: department_files table + department-files bucket. They belong
-- to another Oryx app that works without a Supabase sign-in (see
-- department_files_partial_lock.sql).
--
-- Policies are changed with ALTER (renamed, roles + rule replaced) rather
-- than dropped, because the Supabase connector times out on DROP.

alter policy "Anyone can read systems" on public.systems to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read systems" on public.systems rename to "Staff read systems";
revoke select on public.systems from anon;

alter policy "Anyone can read configurations" on public.configurations to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read configurations" on public.configurations rename to "Staff read configurations";
revoke select on public.configurations from anon;

alter policy "Anyone can read options" on public.system_options to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read options" on public.system_options rename to "Staff read options";
revoke select on public.system_options from anon;

alter policy "Anyone can read drawings" on public.drawings to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read drawings" on public.drawings rename to "Staff read drawings";
revoke select on public.drawings from anon;

alter policy "Anyone can read engineering notes" on public.engineering_notes to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read engineering notes" on public.engineering_notes rename to "Staff read engineering notes";
revoke select on public.engineering_notes from anon;

alter policy "Anyone can read glossary" on public.glossary to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read glossary" on public.glossary rename to "Staff read glossary";
revoke select on public.glossary from anon;

alter policy "Anyone can read kb meta" on public.kb_meta to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read kb meta" on public.kb_meta rename to "Staff read kb meta";
revoke select on public.kb_meta from anon;

alter policy "Anyone can read inventory items" on public.inventory_items to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read inventory items" on public.inventory_items rename to "Staff read inventory items";
revoke select on public.inventory_items from anon;

alter policy "Anyone can read inventory transactions" on public.inventory_transactions to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read inventory transactions" on public.inventory_transactions rename to "Staff read inventory transactions";
revoke select on public.inventory_transactions from anon;

alter policy "Anyone can read exchange rates" on public.exchange_rates to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read exchange rates" on public.exchange_rates rename to "Staff read exchange rates";
revoke select on public.exchange_rates from anon;

alter policy "Anyone can read supplier item aliases" on public.supplier_item_aliases to authenticated using ((select public.is_active_staff()));
alter policy "Anyone can read supplier item aliases" on public.supplier_item_aliases rename to "Staff read supplier item aliases";
revoke select on public.supplier_item_aliases from anon;

-- Drawings bucket: private, staff only (the site asks for signed links).
alter policy "Anyone can read drawing files" on storage.objects
  to authenticated using (bucket_id = 'drawings' and (select public.is_active_staff()));
alter policy "Anyone can read drawing files" on storage.objects rename to "Staff read drawing files";
update storage.buckets set public = false where id = 'drawings';

-- Undo (back to readable by anyone):
--   alter policy "Staff read systems" on public.systems to anon, authenticated using (true);
--   alter policy "Staff read systems" on public.systems rename to "Anyone can read systems";
--   grant select on public.systems to anon;
--   alter policy "Staff read configurations" on public.configurations to anon, authenticated using (true);
--   alter policy "Staff read configurations" on public.configurations rename to "Anyone can read configurations";
--   grant select on public.configurations to anon;
--   alter policy "Staff read options" on public.system_options to anon, authenticated using (true);
--   alter policy "Staff read options" on public.system_options rename to "Anyone can read options";
--   grant select on public.system_options to anon;
--   alter policy "Staff read drawings" on public.drawings to anon, authenticated using (true);
--   alter policy "Staff read drawings" on public.drawings rename to "Anyone can read drawings";
--   grant select on public.drawings to anon;
--   alter policy "Staff read engineering notes" on public.engineering_notes to anon, authenticated using (true);
--   alter policy "Staff read engineering notes" on public.engineering_notes rename to "Anyone can read engineering notes";
--   grant select on public.engineering_notes to anon;
--   alter policy "Staff read glossary" on public.glossary to anon, authenticated using (true);
--   alter policy "Staff read glossary" on public.glossary rename to "Anyone can read glossary";
--   grant select on public.glossary to anon;
--   alter policy "Staff read kb meta" on public.kb_meta to anon, authenticated using (true);
--   alter policy "Staff read kb meta" on public.kb_meta rename to "Anyone can read kb meta";
--   grant select on public.kb_meta to anon;
--   alter policy "Staff read inventory items" on public.inventory_items to anon, authenticated using (true);
--   alter policy "Staff read inventory items" on public.inventory_items rename to "Anyone can read inventory items";
--   grant select on public.inventory_items to anon;
--   alter policy "Staff read inventory transactions" on public.inventory_transactions to anon, authenticated using (true);
--   alter policy "Staff read inventory transactions" on public.inventory_transactions rename to "Anyone can read inventory transactions";
--   grant select on public.inventory_transactions to anon;
--   alter policy "Staff read exchange rates" on public.exchange_rates to anon, authenticated using (true);
--   alter policy "Staff read exchange rates" on public.exchange_rates rename to "Anyone can read exchange rates";
--   grant select on public.exchange_rates to anon;
--   alter policy "Staff read supplier item aliases" on public.supplier_item_aliases to anon, authenticated using (true);
--   alter policy "Staff read supplier item aliases" on public.supplier_item_aliases rename to "Anyone can read supplier item aliases";
--   grant select on public.supplier_item_aliases to anon;
--   alter policy "Staff read drawing files" on storage.objects to anon, authenticated using (bucket_id = 'drawings');
--   alter policy "Staff read drawing files" on storage.objects rename to "Anyone can read drawing files";
--   update storage.buckets set public = true where id = 'drawings';
