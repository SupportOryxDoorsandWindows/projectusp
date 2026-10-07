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
  const { data: p } = await supabase.from("user_profiles").select("user_id, active").eq("user_id", data.user.id).maybeSingle();
  return p && p.active ? p : null;
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
  if (!(await requireStaff(req))) {
    return json({ ok: false, error: "sign_in_required" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

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

  const { data, error } = await supabase.rpc("checkin_transaction", {
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

  return json({ ...data, remembered }, 200);
});
