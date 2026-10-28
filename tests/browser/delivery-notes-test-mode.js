// Delivery notes, Admin TEST mode, in a browser against a stand-in backend
// (nothing real is read or saved; the sign-in is a local stand-in):
//   Admin: "Test with a job list" -> TEST notes (no Check-out is ever sent)
//   -> confirm (TEST-0001) -> printed note says TEST -> delete.
//   Staff: no Test button, no test notes.
//
//   node tests/browser/delivery-notes-test-mode.js --pdf <job list> --libs <folder> [--shot <png>]
// --libs as in checkin-sweep.js (pdfjs-dist@4.7.76 as "pdfjs", supabase-js@2.45.4, xlsx-js-style@1.2.0).
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const pdf = opt("--pdf"), libDir = opt("--libs"), shot = opt("--shot");
if (!pdf || !libDir) { console.error("usage: --pdf <file> --libs <folder> [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "supabase-supabase-js-2.45.4/package/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style-1.2.0/package/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs/package/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs/package/build/pdf.worker.min.mjs",
};

// Stand-in for supabase/sql/delivery_notes_test_mode.sql (what each person may do).
const db = { notes: [], history: [], testSeq: 0, stockCalls: 0 };
const now = () => new Date().toISOString();
function rpc(name, a, admin) {
  const err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  const ok = (b) => ({ status: 200, body: b });
  if (name === "can_correct_delivery_notes") return ok(admin);
  if (name === "prepare_delivery_test_notes") {
    if (!admin) return err("not_allowed");
    let created = 0, existing = 0;
    for (const e of a.p_notes) {
      if (db.notes.some((n) => n.is_test && n.source_document_hash === a.p_hash && n.kind === e.kind)) { existing++; continue; }
      const n = { id: "t" + (db.notes.length + 1), is_test: true, kind: e.kind, source_document_hash: a.p_hash, source_document_name: a.p_doc_name,
        job_number: a.p_job, client: a.p_client, customer_ref: a.p_client, dn_number: null, corrected_count: 0, flags: e.flags || [],
        created_by_name: "Admin Test", created_at: now(), lines: e.lines, delivery_address: e.delivery_address || null,
        contact_no: e.contact_no, secondary_contact_no: e.secondary_contact_no, ral_code: e.ral_code || "" };
      db.notes.unshift(n); created++; db.history.push({ note_id: n.id, action: "prepared", by_name: "Admin Test", created_at: now() });
    }
    return ok({ created, existing });
  }
  const n = db.notes.find((x) => x.id === a.p_id);
  if (!n) return err("not_found");
  if (n.is_test && !admin) return err("not_allowed");
  if (name === "confirm_delivery_note") {
    Object.assign(n, a.p_fields);
    const miss = [n.kind === "powder_coating" && !n.ral_code && "ral_code", !n.delivery_address && "delivery_address", !n.delivered_by && "delivered_by", !n.delivery_date && "delivery_date"].filter(Boolean);
    if (miss.length) return err("missing:" + miss.join(","));
    n.dn_number = "TEST-" + String(++db.testSeq).padStart(4, "0");
    db.history.push({ note_id: n.id, action: "confirmed", by_name: "Admin Test", created_at: now() });
    return ok(n);
  }
  if (name === "save_delivery_note") { Object.assign(n, a.p_fields); return ok(n); }
  if (name === "delete_test_delivery_note") {
    if (!admin) return err("not_allowed");
    if (!n.is_test) return err("not_a_test_note");
    db.notes = db.notes.filter((x) => x !== n); return ok(null);
  }
  return err("unknown rpc " + name);
}

async function session(browser, role) {
  const admin = role === "admin";
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|websocket/i.test(m.text())) errors.push(m.text()); });
  await p.routeWebSocket(/realtime/, () => {});
  await p.route("https://app.local/**", (route) => {
    let f = new URL(route.request().url()).pathname; if (f === "/") f = "/index.html";
    const full = path.join(repo, decodeURIComponent(f));
    if (!full.startsWith(repo) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".css": "text/css", ".json": "application/json" };
    route.fulfill({ status: 200, contentType: types[path.extname(full)] || "application/octet-stream", body: fs.readFileSync(full) });
  });
  await p.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = route.request().url();
    if (!cdn[url]) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(libDir, cdn[url])) });
  });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const user = { id: "00000000-0000-0000-0000-00000000000" + (admin ? "1" : "2"), aud: "authenticated", role: "authenticated", email: role + "@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: role, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: role, user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/checkout") || u.pathname.startsWith("/functions/v1/checkin")) { db.stockCalls++; return send(500, { ok: false }); }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}"), admin); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: admin ? "Admin Test" : "Staff Test", role: admin ? "admin" : "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "delivery_notes") return send(200, db.notes.filter((n) => admin || !n.is_test)); // as the read policy
    if (table === "delivery_note_history") { const id = (u.searchParams.get("note_id") || "").replace(/^eq\./, ""); return send(200, db.history.filter((h) => h.note_id === id)); }
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
  await p.click('nav button[data-v="delivery-notes"]');
  await p.waitForTimeout(800);
  return { p, errors };
}

(async () => {
  const browser = await chromium.launch();
  const step = (t) => console.log("·", t);

  // ---- Admin ----
  const { p, errors } = await session(browser, "admin");
  step("admin sees 'Test with a job list': " + (await p.isVisible("#dnTestLabel")));
  await p.setInputFiles("#dnTestFile", pdf);
  await p.waitForFunction(() => /test note|already exist/.test(document.querySelector("#dnPrepStatus").textContent), null, { timeout: 30000 });
  step("prepared: " + (await p.innerText("#dnPrepStatus")));
  step("filters: " + (await p.innerText("#dnFilters")).replace(/\s+/g, " "));
  step("list: " + (await p.$$eval("#dnList tbody tr", (trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ").trim()).join(" || "))));
  await p.click('#dnList tr[data-dn-id]:has-text("Powder coating")');
  await p.waitForSelector('#dnDetail h2:has-text("Powder coating")');
  step("detail warning: " + (await p.innerText("#dnDetail .dn-msg.bad")).slice(0, 60) + "…");
  await p.fill("#dnRal", "RAL9010 TEST"); await p.dispatchEvent("#dnRal", "change");
  await p.fill("#dnDriver", "Test driver"); await p.dispatchEvent("#dnDriver", "change");
  await p.fill("#dnDate", "2026-10-28"); await p.dispatchEvent("#dnDate", "change");
  await p.click("#dnConfirm");
  await p.waitForSelector("#dnDetail .dn-msg.ok", { timeout: 10000 });
  step("confirmed: " + (await p.innerText("#dnDetail .dn-detail-st")).replace(/\s+/g, " "));
  step("printed note banner: " + (await p.innerText("#dnDetail .dn-sheet .test")));
  if (shot) await p.screenshot({ path: shot, fullPage: true });
  await p.click("#dnDeleteAsk"); await p.click("#dnDeleteYes");
  await p.waitForFunction(() => /deleted/.test(document.querySelector("#dnPrepStatus").textContent), null, { timeout: 10000 });
  step("after delete: " + (await p.innerText("#dnFilters")).replace(/\s+/g, " ") + " | notes left " + db.notes.length);
  step("Check-out / Check-in calls sent: " + db.stockCalls);
  console.log("ADMIN ERRORS " + JSON.stringify(errors));

  // ---- Staff ----
  const s = await session(browser, "staff");
  step("staff sees 'Test with a job list': " + (await s.p.isVisible("#dnTestLabel")));
  step("staff filters: " + (await s.p.innerText("#dnFilters")).replace(/\s+/g, " "));
  step("staff list: " + (await s.p.innerText("#dnList")).replace(/\s+/g, " ").slice(0, 80));
  console.log("STAFF ERRORS " + JSON.stringify(s.errors));
  await browser.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
