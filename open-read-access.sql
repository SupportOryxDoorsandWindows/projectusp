-- Run this once in the Supabase SQL editor to remove the sign-in requirement.
--
--   https://supabase.com/dashboard/project/ylhdsvwzqcshffwohhfy/sql/new
--
-- Paste the whole file, press Run.
--
-- What it does: makes every table readable without signing in, and moves the
-- drawings into a public bucket so their URLs never expire.
--
-- What it does NOT do: grant any write access. No insert, update or delete
-- policy exists on any table, so the key in config.js can only read. Changing
-- data still requires the service_role key via push_to_supabase.py.
--
-- Consequence to be aware of: the product data becomes readable by anyone on
-- the internet, not only Oryx staff. The site is a public page and its key is
-- visible in the source. To go back to staff-only, see revert-read-access.sql.

drop policy if exists "Signed-in staff can read systems"           on public.systems;
drop policy if exists "Signed-in staff can read configurations"    on public.configurations;
drop policy if exists "Signed-in staff can read options"           on public.system_options;
drop policy if exists "Signed-in staff can read drawings"          on public.drawings;
drop policy if exists "Signed-in staff can read engineering notes" on public.engineering_notes;
drop policy if exists "Signed-in staff can read glossary"          on public.glossary;
drop policy if exists "Signed-in staff can read kb meta"           on public.kb_meta;

create policy "Anyone can read systems"
  on public.systems for select to anon, authenticated using (true);
create policy "Anyone can read configurations"
  on public.configurations for select to anon, authenticated using (true);
create policy "Anyone can read options"
  on public.system_options for select to anon, authenticated using (true);
create policy "Anyone can read drawings"
  on public.drawings for select to anon, authenticated using (true);
create policy "Anyone can read engineering notes"
  on public.engineering_notes for select to anon, authenticated using (true);
create policy "Anyone can read glossary"
  on public.glossary for select to anon, authenticated using (true);
create policy "Anyone can read kb meta"
  on public.kb_meta for select to anon, authenticated using (true);

-- Drawings: public bucket, so URLs are permanent and CDN-cached.
update storage.buckets set public = true where id = 'drawings';

drop policy if exists "Signed-in staff can read drawing files" on storage.objects;
create policy "Anyone can read drawing files"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'drawings');
