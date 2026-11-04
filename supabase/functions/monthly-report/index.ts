// Monthly stock movements report (Freedom + Renson), emailed on the 1st.
// User's request 2026-11-04 ("automate the reports to be sent on the 1st of
// each month"; transactions + summary; emailed; test recipient first).
//
// READ-ONLY on stock: it only reads inventory_transactions / inventory_items /
// renson_* and writes its own tables (stock_value_snapshots, monthly_reports)
// and the private bucket monthly-reports. Nothing here changes stock.
//
// Who may call it (verify_jwt is OFF at the gateway because the scheduler has
// no user token; this function checks every caller itself):
//   * the scheduler (pg_cron + pg_net, supabase/sql/monthly_report.sql):
//     header x-report-token = the token kept in Vault, checked by
//     monthly_report_token_ok() (service_role only). Action "monthly": the
//     previous calendar month (Dubai), records the month-end stock values.
//     With the same token, "preview" / "send" + month (tests from SQL).
//   * an active Admin with their own sign-in token (Authorization: Bearer):
//     {action: "send", month?: "YYYY-MM"} -- sends that month (default: the
//     previous month) to the recipients now; {action: "preview", month?}
//     builds and keeps the file but sends nothing. These never record a
//     month-end value.
// Recipients: table report_recipients (active rows). Email through
// Microsoft 365 (the company's Outlook; user's choice 2026-11-04): Microsoft
// Graph sendMail, app-only (client credentials) with Mail.Send, from the
// mailbox in report_settings 'sender' (kept in the database, not in this
// public code); secrets MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.
// The report is also kept in that mailbox's Sent Items.

import { createClient } from "npm:@supabase/supabase-js@2";
import XLSX from "npm:xlsx-js-style@1.2.0";
import { reportPeriod, freedomLine, rensonLine, buildWorkbook, fileName, emailHtml, graphMessage } from "./report.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-report-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function readAll(build: () => any, max = 100000) {
  const out: any[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function caller(req: Request): Promise<{ kind: "scheduler" } | { kind: "admin"; name: string } | null> {
  const token = req.headers.get("x-report-token");
  if (token) {
    const { data, error } = await supabase.rpc("monthly_report_token_ok", { p_token: token });
    return !error && data === true ? { kind: "scheduler" } : null;
  }
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: p } = await supabase.from("user_profiles").select("role, active, full_name, email").eq("user_id", data.user.id).maybeSingle();
  return p && p.active && p.role === "admin" ? { kind: "admin", name: p.full_name || p.email } : null;
}

async function stockValues() {
  const freedom = await readAll(() => supabase.from("inventory_items").select("id, current_value, current_qty, status").order("id"));
  const shown = freedom.filter((i) => !(i.status === "inactive" && Number(i.current_qty) === 0));
  const renson = await readAll(() => supabase.from("renson_items").select("id, current_value").order("id"));
  const sum = (a: any[]) => Math.round(a.reduce((s, i) => s + Number(i.current_value || 0), 0) * 100) / 100;
  return { Freedom: { value: sum(shown), items: shown.length }, Renson: { value: sum(renson), items: renson.length } };
}

async function sendEmail(to: string[], subject: string, html: string, name: string, bytes: Uint8Array) {
  const tenant = Deno.env.get("MS_TENANT_ID"), client = Deno.env.get("MS_CLIENT_ID"), secret = Deno.env.get("MS_CLIENT_SECRET");
  if (!tenant || !client || !secret) return { sent: false, error: "Microsoft 365 sending is not set up yet (secrets MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)." };
  const { data: s } = await supabase.from("report_settings").select("value").eq("key", "sender").maybeSingle();
  const sender = s && s.value;
  if (!sender) return { sent: false, error: "No sender mailbox in report_settings." };
  const tok = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const tj = await tok.json().catch(() => ({}));
  if (!tok.ok || !tj.access_token) return { sent: false, error: `Microsoft sign-in failed (${tok.status}): ${String(tj.error_description || tj.error || "").slice(0, 300)}` };
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tj.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(graphMessage({ to, subject, html, fileName: name, contentBase64: btoa(bin) })),
  });
  if (res.status === 202) return { sent: true, from: sender };
  const body = await res.text();
  return { sent: false, error: `Microsoft Graph ${res.status}: ${body.slice(0, 300)}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await caller(req);
  if (!who) return json({ error: "not_allowed" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  // The scheduler sends {"action":"monthly"}; with its token a test may also
  // ask for "preview" / "send" of a given month (never records a month-end value).
  const action = who.kind === "scheduler" ? (body.action || "monthly") : body.action;
  if (who.kind === "admin" && action === "monthly") return json({ error: "monthly is for the scheduler only" }, 403);
  if (!["monthly", "send", "preview"].includes(action)) return json({ error: "unknown action" }, 400);

  let period;
  try { period = reportPeriod(new Date(), action === "monthly" ? null : body.month || null); } catch (e) { return json({ error: String((e as Error).message) }, 400); }

  try {
    const freedomRows = await readAll(() => supabase.from("inventory_transactions")
      .select("id, type, created_at, job_number, client, supplier, invoice_number, po_number, item_code, description, quantity, unit, unit_cost_used, value, original_currency, original_unit_cost, source_document_name, performed_by_name")
      .gte("created_at", period.start.toISOString()).lt("created_at", period.end.toISOString()).order("created_at").order("id"));
    const rensonRows = await readAll(() => supabase.from("renson_transactions").select("*")
      .neq("type", "opening_import").gte("created_at", period.start.toISOString()).lt("created_at", period.end.toISOString()).order("created_at").order("id"));
    const rensonItems = await readAll(() => supabase.from("renson_items").select("id, description, unit").order("id"));
    const itemsById = new Map(rensonItems.map((i: any) => [String(i.id), i]));

    // Stock values: now (= end of the month when the scheduler runs on the 1st)
    // and the month-end value recorded by the previous monthly run, if any.
    const now = await stockValues();
    const { data: prev } = await supabase.from("stock_value_snapshots").select("inventory, value, taken_at")
      .eq("kind", "month_end").eq("period_key", prevKey(period.key));
    const opening = (n: string) => { const p = (prev || []).find((r: any) => r.inventory === n); return p ? Number(p.value) : null; };
    const monthEnd = action === "monthly";
    const inventories = [
      { name: "Freedom", lines: freedomRows.map(freedomLine), opening: opening("Freedom"), closing: monthEnd ? now.Freedom.value : null },
      { name: "Renson", lines: rensonRows.map((r: any) => rensonLine(r, itemsById)), opening: opening("Renson"), closing: monthEnd ? now.Renson.value : null,
        note: "No Renson movements in this month." },
    ];
    const notes = [
      "Check-out dates = the date the job list was checked out (or its corrected completion date).",
      "Adjustments are stock counts and hand corrections; they are not purchases or usage.",
      monthEnd ? "End-of-month values were recorded when this report was made (1st of the month, 6:00 Dubai)."
        : `Sent on request; stock value today: Freedom AED ${now.Freedom.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}, Renson AED ${now.Renson.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}.`,
    ];
    if (inventories.some((i) => i.opening == null)) notes.push("Start-of-month value 'not recorded': the first automatic month-end value is recorded on 1 Dec 2026.");
    const preparedAt = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (Dubai)";
    const { wb, totals } = buildWorkbook(XLSX, { period, inventories, preparedAt, notes } as any);
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    const name = fileName(period);

    if (monthEnd) {
      await supabase.from("stock_value_snapshots").upsert([
        { kind: "month_end", period_key: period.key, inventory: "Freedom", value: now.Freedom.value, items: now.Freedom.items },
        { kind: "month_end", period_key: period.key, inventory: "Renson", value: now.Renson.value, items: now.Renson.items },
      ], { onConflict: "kind,period_key,inventory" });
    }
    const path = `${period.key}/${new Date().toISOString().replace(/[:.]/g, "-")}-${action}.xlsx`;
    const up = await supabase.storage.from("monthly-reports").upload(path, bytes, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const { data: rec } = await supabase.from("report_recipients").select("email").eq("active", true);
    const to = (rec || []).map((r: any) => r.email);
    let mail: any = { sent: false, error: action === "preview" ? "preview only" : "no active recipients" };
    if (action !== "preview" && to.length) mail = await sendEmail(to, `Oryx stock movements — ${period.label}`, emailHtml({ period, inventories, totals }), name, bytes);

    await supabase.from("monthly_reports").insert({
      period_key: period.key, action, requested_by: who.kind === "admin" ? who.name : "scheduler",
      file_path: up.error ? null : path, sent_to: mail.sent ? to : [], status: mail.sent ? "sent" : action === "preview" ? "built" : "not_sent",
      error: mail.sent ? (up.error ? "file not kept: " + up.error.message : null) : mail.error,
      freedom_lines: freedomRows.length, renson_lines: rensonRows.length,
    });
    return json({ ok: true, period: period.key, file: up.error ? null : path, freedom_lines: freedomRows.length, renson_lines: rensonRows.length, email: mail });
  } catch (e) {
    await supabase.from("monthly_reports").insert({ period_key: period.key, action, requested_by: who.kind === "admin" ? who.name : "scheduler", status: "failed", error: String((e as Error).message).slice(0, 500) });
    return json({ error: String((e as Error).message) }, 500);
  }
});

function prevKey(key: string) {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
