// Staff accounts and permissions (Admin → User Management).
//
// Every request carries the caller's own sign-in token. This function checks
// it, looks up the caller's profile, and only then acts -- so hiding the
// Admin screen is never the only protection. The service-role key stays in
// this runtime; it never reaches the browser.
//
// Actions (POST JSON):
//   {action: "invite", email, full_name, can_delete}   Admin only. Creates the
//       account (or reuses one that already exists) and returns a one-time
//       token; the browser turns it into a link the Admin sends to the person
//       (?invite=… or ?reset=… on the site), where they set their own password.
//   {action: "reset_link", user_id}                    Admin only. New link to
//       set a password (forgotten password, or an invite link that expired).
//   {action: "set_access", user_id, role?, can_delete?, active?, full_name?}
//       Admin only. Rules live in admin_set_user_access(): an Admin can't
//       remove their own Admin access or deactivate themselves, and the last
//       active Admin can't be removed. A deactivated account is also blocked
//       from signing in.
//   {action: "bootstrap", token}                       Creates the FIRST Admin
//       from a one-time token placed in admin_bootstrap_tokens (SQL editor /
//       service role only). The token is deleted when used.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: p } = await supabase.from("user_profiles").select("*").eq("user_id", data.user.id).maybeSingle();
  return p && p.active ? p : null;
}

// One-time token for "set your password": an invite for a new account, a
// recovery link for one that already exists.
async function passwordLink(email: string) {
  let kind = "invite";
  let { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email });
  if (error && /already|registered|exists/i.test(error.message)) {
    kind = "reset";
    ({ data, error } = await supabase.auth.admin.generateLink({ type: "recovery", email }));
  }
  if (error || !data?.user || !data?.properties?.hashed_token) throw new Error(error?.message || "no_link");
  return { kind, user: data.user, token: data.properties.hashed_token };
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const action = body?.action;

  try {
    if (action === "bootstrap") {
      const token = str(body.token, 200);
      if (!token) return json({ ok: false, error: "invalid_token" }, 400);
      const hash = await sha256(token);
      const { data: row } = await supabase.from("admin_bootstrap_tokens").select("*").eq("token_sha256", hash).maybeSingle();
      if (!row || new Date(row.expires_at) < new Date()) return json({ ok: false, error: "invalid_token" }, 403);
      await supabase.from("admin_bootstrap_tokens").delete().eq("token_sha256", hash);
      const link = await passwordLink(row.email);
      const { error } = await supabase.from("user_profiles").upsert({
        user_id: link.user.id, email: row.email, full_name: row.full_name, role: "admin", can_delete: true, active: true, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true, kind: link.kind, token: link.token, email: row.email });
    }

    const me = await caller(req);
    if (!me) return json({ ok: false, error: "sign_in_required" }, 401);
    if (me.role !== "admin") return json({ ok: false, error: "not_admin" }, 403);

    if (action === "invite") {
      const email = str(body.email, 200)?.toLowerCase();
      if (!email || !EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
      const link = await passwordLink(email);
      const { data: existing } = await supabase.from("user_profiles").select("user_id").eq("user_id", link.user.id).maybeSingle();
      if (!existing) {
        const { error } = await supabase.from("user_profiles").insert({
          user_id: link.user.id, email, full_name: str(body.full_name, 120), role: "user",
          can_delete: body.can_delete === true, active: true, updated_by: me.user_id,
        });
        if (error) throw error;
      }
      return json({ ok: true, kind: link.kind, token: link.token, existed: !!existing });
    }

    if (action === "reset_link") {
      const id = typeof body.user_id === "string" && UUID_RE.test(body.user_id) ? body.user_id : null;
      if (!id) return json({ ok: false, error: "invalid_user" }, 400);
      const { data: p } = await supabase.from("user_profiles").select("email").eq("user_id", id).maybeSingle();
      if (!p) return json({ ok: false, error: "no_such_user" }, 404);
      const link = await passwordLink(p.email);
      return json({ ok: true, kind: link.kind, token: link.token });
    }

    if (action === "set_access") {
      const id = typeof body.user_id === "string" && UUID_RE.test(body.user_id) ? body.user_id : null;
      if (!id) return json({ ok: false, error: "invalid_user" }, 400);
      const { data, error } = await supabase.rpc("admin_set_user_access", {
        p_actor: me.user_id, p_target: id,
        p_role: typeof body.role === "string" ? body.role : null,
        p_can_delete: typeof body.can_delete === "boolean" ? body.can_delete : null,
        p_active: typeof body.active === "boolean" ? body.active : null,
        p_full_name: str(body.full_name, 120),
      });
      if (error) throw error;
      if (!data?.ok) return json(data, 400);
      if (typeof body.active === "boolean") {
        // Deactivated: can't sign in either (and is refused by every function).
        await supabase.auth.admin.updateUserById(id, { ban_duration: body.active ? "none" : "876000h" });
      }
      return json(data);
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    console.error("user-admin error", e);
    return json({ ok: false, error: "server_error", detail: String((e as Error)?.message || e) }, 500);
  }
});
