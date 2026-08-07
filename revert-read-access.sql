-- Puts the staff sign-in back. Run in the Supabase SQL editor:
--
--   https://supabase.com/dashboard/project/ylhdsvwzqcshffwohhfy/sql/new
--
-- After running this, the app also needs its sign-in gate restored — see the
-- "Restoring the sign-in" section of README.md. Data will not load without it.

drop policy if exists "Anyone can read systems"           on public.systems;
drop policy if exists "Anyone can read configurations"    on public.configurations;
drop policy if exists "Anyone can read options"           on public.system_options;
drop policy if exists "Anyone can read drawings"          on public.drawings;
drop policy if exists "Anyone can read engineering notes" on public.engineering_notes;
drop policy if exists "Anyone can read glossary"          on public.glossary;
drop policy if exists "Anyone can read kb meta"           on public.kb_meta;

create policy "Signed-in staff can read systems"
  on public.systems for select to authenticated using (true);
create policy "Signed-in staff can read configurations"
  on public.configurations for select to authenticated using (true);
create policy "Signed-in staff can read options"
  on public.system_options for select to authenticated using (true);
create policy "Signed-in staff can read drawings"
  on public.drawings for select to authenticated using (true);
create policy "Signed-in staff can read engineering notes"
  on public.engineering_notes for select to authenticated using (true);
create policy "Signed-in staff can read glossary"
  on public.glossary for select to authenticated using (true);
create policy "Signed-in staff can read kb meta"
  on public.kb_meta for select to authenticated using (true);

update storage.buckets set public = false where id = 'drawings';

drop policy if exists "Anyone can read drawing files" on storage.objects;
create policy "Signed-in staff can read drawing files"
  on storage.objects for select to authenticated
  using (bucket_id = 'drawings');
