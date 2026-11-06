// Kanban editors (supabase/sql/kanban_editors.sql), against a stand-in
// backend. Run:
//   node tests/browser/kanban-editor.js --node-modules <dir with @supabase/supabase-js@2.45.4,
//        xlsx-js-style@1.2.0, pdfjs-dist@4.7.76> [--shot <png>]
// Checks: a regular user sees the Kanban levels read-only (Freedom item panel
// and Renson item); a user with can_edit_kanban gets the boxes in both and
// Save calls set_item_kanban_levels / renson_set_levels; an Admin sees a
// "Kanban levels" column in User Management and switching it calls
// admin_set_kanban_editor. No stock writes. All data here is made up.
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const nm = opt("--node-modules"), shot = opt("--shot");
if (!nm) { console.error("usage: --node-modules <dir> [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};
const ITEMS = [{ id: "11111111-0000-0000-0000-000000000001", item_code: "KB1", description: "Test bar (made up)", bar_length_mm: null, current_qty: 40,
  unit_cost: 2.5, current_value: 100, status: "active", unit_of_measure: "pcs", buffer_level: null, critical_level: null }];
const RENSON = [{ id: 1, item_code: "RN1", alt_code: null, description: "Test fitting (made up)", unit: "pcs", current_qty: 12, unit_cost: 3,
  current_value: 36, buffer_level: null, critical_level: null }];
const PEOPLE = [
  { user_id: "00000000-0000-0000-0000-000000000001", email: "admin@example.test", full_name: "Admin Test", role: "admin", can_delete: true, can_edit_kanban: false, active: true },
  { user_id: "00000000-0000-0000-0000-000000000002", email: "staff@example.test", full_name: "Staff Test", role: "user", can_delete: false, can_edit_kanban: false, active: true },
  { user_id: "00000000-0000-0000-0000-000000000003", email: "kanban@example.test", full_name: "Kanban Editor", role: "user", can_delete: false, can_edit_kanban: true, active: true },
];

async function session(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [], calls = [], writes = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|websocket/i.test(m.text())) errors.push(m.text()); });
  await p.routeWebSocket(/realtime/, () => {});
  await p.route("https://app.local/**", (route) => {
    let f = new URL(route.request().url()).pathname; if (f === "/") f = "/index.html";
    const full = path.join(repo, decodeURIComponent(f));
    if (!full.startsWith(repo) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".json": "application/json" };
    route.fulfill({ status: 200, contentType: types[path.extname(full)] || "application/octet-stream", body: fs.readFileSync(full) });
  });
  await p.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = route.request().url();
    if (!cdn[url]) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(nm, cdn[url])) });
  });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const prof = PEOPLE.find((x) => x.email.startsWith(who));
  const user = { id: prof.user_id, aud: "authenticated", role: "authenticated", email: prof.email, app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "t", user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/")) { writes.push(u.pathname); return send(200, { ok: true, users: [] }); }
    const rpc = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpc) {
      const a = JSON.parse(req.postData() || "{}"); calls.push({ rpc, a });
      if (rpc === "renson_access") return send(200, true);
      if (rpc === "set_item_kanban_levels") return send(200, { ok: true, changed: true, buffer_level: a.p_trigger, critical_level: a.p_critical, set_by_name: prof.full_name, set_at: new Date().toISOString() });
      if (rpc === "renson_set_levels") return send(200, { trigger: a.p_trigger, critical: a.p_critical });
      if (rpc === "admin_set_kanban_editor") { const t = PEOPLE.find((x) => x.user_id === a.p_user_id); t.can_edit_kanban = a.p_on; return send(200, { ok: true, changed: true, can_edit_kanban: a.p_on }); }
      if (/checkin|checkout|adjust|import/.test(rpc)) writes.push(rpc);
      return send(200, null);
    }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (req.method() !== "GET" && table !== "system_update_reads") writes.push(req.method() + " " + table);
    if (table === "user_profiles") {
      const one = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
      const eqId = (u.searchParams.get("user_id") || "").replace(/^eq\./, "");
      const rows = eqId ? PEOPLE.filter((x) => x.user_id === eqId) : prof.role === "admin" ? PEOPLE : [prof];
      return send(200, one ? rows[0] : rows);
    }
    if (table === "inventory_items") return send(200, ITEMS);
    if (table === "renson_items") return send(200, RENSON);
    if (table === "app_feature_flags") return send(200, [{ key: "renson_pilot", enabled: true }]);
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 }).catch(async (e) => { console.error(who, errors, (await p.innerText("body")).slice(0, 400)); throw e; });
  await p.waitForTimeout(2000);
  return { p, errors, calls, writes };
}

const fail = [];
const check = (ok, t) => { console.log((ok ? "ok  " : "FAIL") + " · " + t); if (!ok) fail.push(t); };

async function freedomPanel(p) {
  await p.click('nav button[data-v="master-inventory"]'); await p.waitForTimeout(1200);
  await p.click('tr[data-mi-row]'); await p.waitForTimeout(1200);
}
async function rensonPanel(p) {
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  await p.selectOption("#rnInventory", "renson"); await p.waitForTimeout(1200);
  await p.click('tr[data-rn-item]'); await p.waitForSelector("#rnItemDlg[open]");
}

(async () => {
  const browser = await chromium.launch();

  // Regular user: read-only
  {
    const { p, errors, calls, writes } = await session(browser, "staff");
    await freedomPanel(p);
    check(!(await p.$("#idMinIn")) && /Kanban trigger level/.test(await p.innerText("#idMin")), "regular user: Freedom Kanban read-only");
    await rensonPanel(p);
    check(!(await p.$("#rnLvT")) && /Only Admins and Kanban editors change these/.test(await p.innerText("#rnItemBody")), "regular user: Renson Kanban read-only");
    check(!calls.some((c) => /kanban|levels/.test(c.rpc)) && !writes.length, "regular user: nothing sent " + JSON.stringify(writes));
    check(!errors.length, "regular user: no page errors " + errors.join(" | "));
    check(!(await p.isVisible("#navAdmin")), "regular user: no User Management");
  }

  // Kanban editor (not an Admin): edits both
  {
    const { p, errors, calls, writes } = await session(browser, "kanban");
    check(!(await p.isVisible("#navAdmin")), "Kanban editor: still no User Management (not an Admin)");
    await freedomPanel(p);
    check(!!(await p.$("#idMinIn")) && /Admins and Kanban editors/.test(await p.innerText("#idMin")), "Kanban editor: Freedom boxes shown");
    await p.fill("#idMinIn", "30"); await p.fill("#idCritIn", "10"); await p.click("#idMinSave"); await p.waitForTimeout(800);
    const f = calls.find((c) => c.rpc === "set_item_kanban_levels");
    check(f && f.a.p_item_id === ITEMS[0].id && f.a.p_trigger === 30 && f.a.p_critical === 10, "Kanban editor: Freedom Save = set_item_kanban_levels(30, 10)");
    if (shot) await p.screenshot({ path: shot });
    await rensonPanel(p);
    check(!!(await p.$("#rnLvT")), "Kanban editor: Renson boxes shown");
    await p.fill("#rnLvT", "20"); await p.fill("#rnLvC", "5"); await p.click('[data-rn-dlg="levels"]'); await p.waitForTimeout(800);
    const r = calls.find((c) => c.rpc === "renson_set_levels");
    check(r && r.a.p_item_code === "RN1" && r.a.p_trigger === 20 && r.a.p_critical === 5, "Kanban editor: Renson Save = renson_set_levels(20, 5)");
    check(!writes.length, "Kanban editor: no stock writes " + JSON.stringify(writes));
    check(!errors.length, "Kanban editor: no page errors " + errors.join(" | "));
  }

  // Admin: User Management column
  {
    const { p, errors, calls } = await session(browser, "admin");
    await p.click("#navAdmin"); await p.waitForTimeout(1500);
    const head = await p.innerText(".um-people thead");
    check(/Kanban levels/.test(head), "admin: User Management has a Kanban levels column");
    const row = (email) => p.locator("#umRows tr", { hasText: email });
    check(/Always/.test(await row("admin@example.test").innerText()), "admin row: Always");
    const box = row("staff@example.test").locator('input[data-set="can_edit_kanban"]');
    check(!(await box.isChecked()), "staff: Off");
    await box.check(); await p.waitForTimeout(1000);
    const c = calls.find((x) => x.rpc === "admin_set_kanban_editor");
    check(c && c.a.p_user_id === PEOPLE[1].user_id && c.a.p_on === true && /can now set Kanban levels/.test(await p.innerText("#v-admin")), "admin: switch on = admin_set_kanban_editor(staff, true), message shown");
    check(!errors.length, "admin: no page errors " + errors.join(" | "));
  }

  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
