-- department-files bucket + department_files table (applied 2026-10-12).
--
-- NOT used by the inventory system: they belong to another Oryx app (staff
-- "challenge evidence" / instructions uploads) that is still in use and talks
-- to Supabase without a Supabase sign-in, so it acts as an anonymous visitor.
-- Before this, anyone with the public key could read, upload AND delete.
--
-- Partial lock (keeps that app working):
--  * nobody anonymous can delete files or rows any more (delete only from the
--    Supabase dashboard / service role);
--  * uploads only accept pictures, videos, PDF, text/CSV and Office files
--    (no web pages, scripts or programs);
--  * reading and uploading stay open, because the app needs them.
-- The delete policies are switched off (USING false) rather than dropped,
-- because the Supabase connector times out on DROP.

alter policy dept_bucket_anon_delete on storage.objects using (false);
alter policy dept_files_anon_delete on public.department_files using (false);

update storage.buckets
   set allowed_mime_types = array[
     'image/*', 'video/*', 'application/pdf', 'text/plain', 'text/csv',
     'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
 where id = 'department-files';

-- Undo (only if that app really needs anonymous delete back):
--   alter policy dept_bucket_anon_delete on storage.objects using (bucket_id = 'department-files');
--   alter policy dept_files_anon_delete on public.department_files using (true);
--   update storage.buckets set allowed_mime_types = null where id = 'department-files';
--
-- Still open (next step, needs a change in that app): anyone can read every
-- file and upload new ones. The full fix is for that app to upload/read
-- through a server function or Supabase sign-in, then make the bucket private.
