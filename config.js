/* Supabase connection details.
   Safe to commit: this is the publishable key. It can't change anything by
   itself -- every write goes through an Edge Function that requires a
   signed-in staff account, and the permission tables only answer a signed-in
   person (about themselves, or everyone for an Admin). The service_role key
   must never appear here — it belongs only in push_to_supabase.py, in an
   environment variable on the machine doing the upload.

   Everyone signs in (boot.js). Note that the product data tables are still
   readable with this key (see README.md, "Who can see the data"). */
window.ORYX_CONFIG = {
  supabaseUrl: "https://ylhdsvwzqcshffwohhfy.supabase.co",
  supabaseKey: "sb_publishable_-8lQTmwPyAsmJXKATTcbpg_OtKG9qJF",
  drawingsBucket: "drawings",
};
