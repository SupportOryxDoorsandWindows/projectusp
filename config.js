/* Supabase connection details.
   Safe to commit: this key is read-only. No table has an insert, update or
   delete policy, so it cannot change anything. The service_role key must never
   appear here — it belongs only in push_to_supabase.py, in an environment
   variable on the machine doing the upload.

   Note that read access is open: anyone who loads the page sees the product
   data, with no sign-in. To restrict it to Oryx staff again, run
   revert-read-access.sql and restore the sign-in gate (see README.md). */
window.ORYX_CONFIG = {
  supabaseUrl: "https://ylhdsvwzqcshffwohhfy.supabase.co",
  supabaseKey: "sb_publishable_-8lQTmwPyAsmJXKATTcbpg_OtKG9qJF",
  drawingsBucket: "drawings",
};
