/* Supabase connection details.
   Safe to commit: the publishable key only grants what Row Level Security
   allows, and every table restricts reads to signed-in staff. The service_role
   key must never appear here — it belongs only in push_to_supabase.py, in an
   environment variable on the machine doing the upload. */
window.ORYX_CONFIG = {
  supabaseUrl: "https://ylhdsvwzqcshffwohhfy.supabase.co",
  supabaseKey: "sb_publishable_-8lQTmwPyAsmJXKATTcbpg_OtKG9qJF",
  drawingsBucket: "drawings",
  // Drawings live in a private bucket and are served through signed URLs.
  // Eight hours covers a working day without a reload.
  signedUrlSeconds: 28800,
};
