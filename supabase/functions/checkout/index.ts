// Phase 1/2 Check-out. Called by the browser (fp-pro.js) with the signed-in
// person's own token; requireStaff() below refuses anyone without an active
// staff account (user-permissions update -- nothing else here changed).
//
// All the actual writing happens inside the checkout_transaction() Postgres
// function via the service-role client -- this file only validates the
// request shape and forwards it. The service-role key never reaches the
// browser; it is injected into this runtime by Supabase automatically.
//
// Phase 2: checkout_transaction() no longer blocks on insufficient stock --
// negative current_qty is allowed and expected, corrected by a later
// Check-in. Duplicate-document rejection is unchanged.
//
// Original PDF (2026-10-12): the browser may send the request as
// multipart/form-data -- "payload" (the same JSON as before) plus "document"
// (the PDF). The file is kept in the private bucket "transaction-documents"
// only AFTER the stock was saved, and only when its SHA-256 equals pdf_hash
// (the fingerprint on the transaction rows). A failure to keep it never fails
// the Check-out: the answer says document.saved = false and the browser offers
// "Try again" ({action: "attach_document"} with the same file). Plain JSON
// requests (manual adjustments, older pages) behave exactly as before.
//
// Kept in the repo so it can be reviewed and redeployed; the live version is
// in Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function requireStaff(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: p } = await supabase.from("user_profiles").select("user_id, active, email, full_name").eq("user_id", data.user.id).maybeSingle();
  return p && p.active ? p : null;
}

// ---- Original PDF kept with the transaction (same block in checkout and checkin) ----
const DOC_BUCKET = "transaction-documents";
const MAX_DOC_BYTES = 25 * 1024 * 1024; // = the bucket's own limit

type KeptFile = { bytes: Uint8Array; name: string };

// JSON as before, or multipart: "payload" (JSON) + optional "document" (PDF).
async function readRequest(req: Request): Promise<{ body: any; file: KeptFile | null; fileProblem: string | null }> {
  if (!/multipart\/form-data/i.test(req.headers.get("content-type") || "")) {
    return { body: await req.json(), file: null, fileProblem: null };
  }
  const form = await req.formData();
  const body = JSON.parse(String(form.get("payload") || "null"));
  const f = form.get("document");
  if (!f || typeof f === "string") return { body, file: null, fileProblem: null };
  if (f.size > MAX_DOC_BYTES) return { body, file: null, fileProblem: "too_large" };
  if (!f.size) return { body, file: null, fileProblem: "empty_file" };
  return { body, file: { bytes: new Uint8Array(await f.arrayBuffer()), name: String(f.name || "document.pdf").slice(0, 300) }, fileProblem: null };
}

async function sha256Hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A PDF starts with "%PDF-" (within the first 1 KB, per the PDF spec).
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
function looksLikePdf(bytes: Uint8Array) {
  const end = Math.min(bytes.length, 1024) - PDF_MAGIC.length;
  for (let i = 0; i <= end; i++) if (PDF_MAGIC.every((b, k) => bytes[i + k] === b)) return true;
  return false;
}

// Never overwrites: a file already kept for this fingerprint stays as it is.
async function keepDocument(kind: string, hash: string, file: KeptFile, staff: any) {
  const path = `${kind === "check_in" ? "check-in" : "check-out"}/${hash}.pdf`;
  const up = await supabase.storage.from(DOC_BUCKET).upload(path, file.bytes, { contentType: "application/pdf", upsert: false });
  const e: any = up.error;
  if (e && !(String(e.statusCode || e.status) === "409" || /already exists|duplicate/i.test(e.message || ""))) {
    console.error("keep document upload", e);
    return { saved: false, error: "upload_failed", detail: e.message };
  }
  const { error } = await supabase.from("transaction_documents").upsert({
    document_hash: hash, kind, storage_path: path, file_name: file.name, size_bytes: file.bytes.length,
    uploaded_by: staff.user_id, uploaded_by_name: staff.full_name || staff.email,
  }, { onConflict: "document_hash", ignoreDuplicates: true });
  if (error) {
    console.error("keep document record", error);
    return { saved: false, error: "record_failed", detail: error.message };
  }
  return { saved: true };
}

// Checked BEFORE the stock is saved, kept only AFTER it was.
async function checkFileForTransaction(file: KeptFile | null, fileProblem: string | null, pdfHash: unknown) {
  if (!file) return { hash: null, problem: fileProblem };
  if (!looksLikePdf(file.bytes)) return { hash: null, problem: "not_a_pdf" };
  const hash = await sha256Hex(file.bytes);
  if (typeof pdfHash !== "string" || hash !== pdfHash) return { hash: null, problem: "different_file" };
  return { hash, problem: null };
}

// {action: "attach_document"} + the file: keep the PDF of a transaction that
// is already saved (a failed keep, or an older one). Only the exact file
// works: its fingerprint must be on a saved transaction.
async function attachDocument(body: any, file: KeptFile | null, fileProblem: string | null, staff: any) {
  if (!file) return json({ ok: false, error: fileProblem || "missing_document" }, 400);
  if (!looksLikePdf(file.bytes)) return json({ ok: false, error: "not_a_pdf" }, 400);
  const hash = await sha256Hex(file.bytes);
  if (typeof body.expected_hash === "string" && body.expected_hash && body.expected_hash !== hash) {
    return json({ ok: false, error: "different_file" }, 400);
  }
  const { data: tx, error } = await supabase.from("inventory_transactions")
    .select("type").eq("source_document_hash", hash).limit(1).maybeSingle();
  if (error) return json({ ok: false, error: "server_error", detail: error.message }, 500);
  if (!tx) return json({ ok: false, error: "no_transaction" }, 404);
  const kept = await keepDocument(tx.type, hash, file, staff);
  return json({ ok: kept.saved, document: kept }, kept.saved ? 200 : 500);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  // The signed-in person is recorded on every movement (Activity timeline):
  // the *_by wrapper stamps them, then runs the unchanged stock function.
  const staff = await requireStaff(req);
  if (!staff) {
    return json({ ok: false, error: "sign_in_required" }, 401);
  }
  const actor = { p_actor_id: staff.user_id, p_actor_name: staff.full_name || staff.email, p_actor_email: staff.email };

  let body: any, file: KeptFile | null, fileProblem: string | null;
  try {
    ({ body, file, fileProblem } = await readRequest(req));
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (body && body.action === "attach_document") return attachDocument(body, file, fileProblem, staff);

  const { job_number, client, pdf_hash, source_document_name, lines } = body || {};

  if (!job_number || typeof job_number !== "string") {
    return json({ ok: false, error: "missing_job_number" }, 400);
  }
  if (!client || typeof client !== "string") {
    return json({ ok: false, error: "missing_client" }, 400);
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return json({ ok: false, error: "missing_lines" }, 400);
  }
  for (const l of lines) {
    if (!l || typeof l.item_id !== "string" || typeof l.quantity !== "number" || l.quantity <= 0) {
      return json({ ok: false, error: "invalid_line", line: l }, 400);
    }
  }

  const doc = await checkFileForTransaction(file, fileProblem, pdf_hash);

  const { data, error } = await supabase.rpc("checkout_transaction_by", {
    ...actor,
    p_job_number: job_number,
    p_client: client,
    p_pdf_hash: pdf_hash ? String(pdf_hash) : null,
    p_doc_name: source_document_name ? String(source_document_name) : null,
    p_lines: lines.map((l: any) => ({
      item_id: l.item_id,
      quantity: l.quantity,
      unit: l.unit || "",
    })),
  });

  if (error) {
    console.error("checkout_transaction error", error);
    return json({ ok: false, error: "server_error", detail: error.message }, 500);
  }

  if (data && data.ok === false) {
    const status = data.error === "duplicate_document" ? 409 : 400;
    return json(data, status);
  }

  // The stock is saved; now keep the original PDF (never fails the Check-out).
  let document: unknown = null;
  if (doc.hash) {
    try { document = await keepDocument("check_out", doc.hash, file!, staff); }
    catch (e) { console.error("keep document", e); document = { saved: false, error: "upload_failed" }; }
  } else if (doc.problem) document = { saved: false, error: doc.problem };

  return json({ ...data, document }, 200);
});
