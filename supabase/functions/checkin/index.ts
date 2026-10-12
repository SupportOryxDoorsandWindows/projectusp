// Phase 2 Check-in. Mirrors the `checkout` function: the browser (fp-pro.js)
// sends the extracted invoice lines with the signed-in person's own token;
// requireStaff() below refuses anyone without an active staff account.
// All writing happens inside checkin_transaction()
// via the service-role client -- this file only validates the request shape
// and forwards it. The service-role key never reaches the browser.
//
// Deployed copy of the Supabase Edge Function `checkin` (kept in the repo so
// it can be reviewed and redeployed; the live version is in Supabase).
//
// Currency: unit_cost on each line is expected already converted to AED by
// the browser (using the rate it fetched from the currency API, or a manual
// entry if the API had nothing); original_unit_cost/currency/exchange_rate/
// rate_date/rate_source are passed through unchanged so the transaction
// keeps a permanent, dated record of exactly what was used.
//
// A line with item_id === null and a `new_item` object is a brand-new
// Master Inventory item (no match existed at all, not even a resolvable
// typo/truncation) -- checkin_transaction() creates the inventory_items row
// itself, but only when new_item carries a code/description/unit and a
// named approver; it never invents any of those.
//
// package_type/package_qty/qty_per_package/package_unit/package_cost are
// optional, purely informational fields recording what a supplier document
// actually said about packaging (e.g. "4 rolls of 200m") -- kept separate
// from quantity/unit_cost, which stay in whatever unit basis Master
// Inventory already uses for that item. All optional; omitted entirely for
// an ordinary (non-bundled) line.
//
// shipping_cost_total/shipping_allocated/landed_unit_cost (Landed Cost
// feature) are also optional and carried per-line rather than as a new
// top-level parameter -- checkin_transaction()'s signature deliberately
// didn't change, to avoid creating a second overload that could collide
// with the existing one at call time. unit_cost above already reflects the
// landed figure (original cost + this line's share of shipping) when the
// browser detected or was given a shipping/freight charge; these three
// fields are purely the audit trail of how that number was reached. All
// omitted entirely for a document with no shipping charge -- existing
// behaviour for those documents is unchanged.
//
// "Teach once, remember": a line may carry an optional `remember` object
// ({supplier_key, code_key, description_key, example}) when a person
// resolved it (Edit / Use this item / New item) or re-confirmed a remembered
// match. Only AFTER checkin_transaction() succeeds are those links saved via
// remember_supplier_aliases() -- the stock logic itself is untouched, and a
// failure to save a link never fails the Check-in (the line just isn't
// remembered). A request {action: "forget_alias", id} removes one link.
//
// Original PDF (2026-10-12): same as `checkout` -- an optional multipart
// "document" is kept in the private bucket "transaction-documents" only after
// the stock was saved and only when its SHA-256 equals pdf_hash; failing to
// keep it never fails the Check-in (document.saved = false, browser offers
// "Try again" = {action: "attach_document"}).

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

// Signed-in staff only (user-permissions update): the caller's own sign-in
// token is checked and their profile must be active. Nothing below changed.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

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

  // Remembered matches list -> "Forget" one link.
  if (body && body.action === "forget_alias") {
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
    if (!id) return json({ ok: false, error: "invalid_id" }, 400);
    const { error, count } = await supabase
      .from("supplier_item_aliases")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) {
      console.error("forget_alias error", error);
      return json({ ok: false, error: "server_error", detail: error.message }, 500);
    }
    return json({ ok: (count ?? 0) > 0 });
  }

  const {
    supplier, invoice_number, po_number, document_date, pdf_hash, source_document_name,
    currency, exchange_rate, rate_date, rate_source, lines,
  } = body || {};

  if (!Array.isArray(lines) || lines.length === 0) {
    return json({ ok: false, error: "missing_lines" }, 400);
  }
  for (const l of lines) {
    const isExisting = typeof l?.item_id === "string";
    const isNew = l && l.item_id == null && l.new_item && typeof l.new_item === "object";
    if (!l || !(isExisting || isNew) || typeof l.quantity !== "number" || l.quantity <= 0) {
      return json({ ok: false, error: "invalid_line", line: l }, 400);
    }
    if (isNew) {
      const ni = l.new_item;
      if (!ni.item_code || !ni.description || !ni.unit_of_measure || !ni.approved_by) {
        return json({ ok: false, error: "invalid_new_item", line: l }, 400);
      }
      if (typeof l.unit_cost !== "number" || l.unit_cost <= 0) {
        return json({ ok: false, error: "missing_unit_cost_for_new_item", line: l }, 400);
      }
    }
  }
  if (currency && currency !== "AED" && !(typeof exchange_rate === "number" && exchange_rate > 0)) {
    return json({ ok: false, error: "missing_exchange_rate" }, 400);
  }

  const doc = await checkFileForTransaction(file, fileProblem, pdf_hash);

  const { data, error } = await supabase.rpc("checkin_transaction_by", {
    ...actor,
    p_supplier: supplier ? String(supplier) : null,
    p_invoice_number: invoice_number ? String(invoice_number) : null,
    p_po_number: po_number ? String(po_number) : null,
    p_document_date: document_date ? String(document_date) : null,
    p_pdf_hash: pdf_hash ? String(pdf_hash) : null,
    p_doc_name: source_document_name ? String(source_document_name) : null,
    p_currency: currency ? String(currency) : null,
    p_exchange_rate: typeof exchange_rate === "number" ? exchange_rate : null,
    p_rate_date: rate_date ? String(rate_date) : null,
    p_rate_source: rate_source ? String(rate_source) : null,
    p_lines: lines.map((l: any) => ({
      item_id: l.item_id ?? null,
      quantity: l.quantity,
      unit: l.unit || "",
      unit_cost: typeof l.unit_cost === "number" ? l.unit_cost : null,
      original_unit_cost: typeof l.original_unit_cost === "number" ? l.original_unit_cost : null,
      package_type: l.package_type ? String(l.package_type) : null,
      package_qty: typeof l.package_qty === "number" ? l.package_qty : null,
      qty_per_package: typeof l.qty_per_package === "number" ? l.qty_per_package : null,
      package_unit: l.package_unit ? String(l.package_unit) : null,
      package_cost: typeof l.package_cost === "number" ? l.package_cost : null,
      shipping_cost_total: typeof l.shipping_cost_total === "number" ? l.shipping_cost_total : null,
      shipping_allocated: typeof l.shipping_allocated === "number" ? l.shipping_allocated : null,
      landed_unit_cost: typeof l.landed_unit_cost === "number" ? l.landed_unit_cost : null,
      new_item: l.item_id
        ? null
        : {
            item_code: String(l.new_item.item_code),
            description: String(l.new_item.description),
            category: l.new_item.category ? String(l.new_item.category) : null,
            unit_of_measure: String(l.new_item.unit_of_measure),
            buffer_level: typeof l.new_item.buffer_level === "number" ? l.new_item.buffer_level : null,
            approved_by: String(l.new_item.approved_by),
          },
    })),
  });

  if (error) {
    console.error("checkin_transaction error", error);
    return json({ ok: false, error: "server_error", detail: error.message }, 500);
  }

  if (data && data.ok === false) {
    const status = data.error === "duplicate_document" ? 409 : 400;
    return json(data, status);
  }

  // Teach once, remember -- only after the stock was saved. data.lines comes
  // back in the same order as `lines`, so a brand-new item's id is taken from
  // there. Never fails the Check-in.
  let remembered = 0;
  try {
    const results = Array.isArray(data?.lines) ? data.lines : [];
    const entries = lines
      .map((l: any, k: number) => {
        const r = l && typeof l.remember === "object" && l.remember ? l.remember : null;
        const itemId = typeof l.item_id === "string" ? l.item_id : results[k]?.item_id;
        if (!r || !itemId) return null;
        return {
          item_id: itemId,
          supplier: str(supplier, 200),
          supplier_key: str(r.supplier_key, 200),
          code_key: str(r.code_key, 300),
          description_key: str(r.description_key, 300),
          example: str(r.example, 300),
        };
      })
      .filter((e: any) => e && e.supplier_key && (e.code_key || e.description_key));
    if (entries.length) {
      const { data: rem, error: remErr } = await supabase.rpc("remember_supplier_aliases", { p_entries: entries });
      if (remErr) console.error("remember_supplier_aliases error", remErr);
      else remembered = rem?.saved ?? 0;
    }
  } catch (e) {
    console.error("remember step failed", e);
  }

  // Keep the original PDF -- after the stock was saved; never fails the Check-in.
  let document: unknown = null;
  if (doc.hash) {
    try { document = await keepDocument("check_in", doc.hash, file!, staff); }
    catch (e) { console.error("keep document", e); document = { saved: false, error: "upload_failed" }; }
  } else if (doc.problem) document = { saved: false, error: doc.problem };

  return json({ ...data, remembered, document }, 200);
});
