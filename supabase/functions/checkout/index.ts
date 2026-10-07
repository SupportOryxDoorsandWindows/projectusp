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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

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

  return json(data, 200);
});
