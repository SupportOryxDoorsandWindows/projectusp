// One Check-out for every stock category (2026-11-02): a FREEDOM job list
// must go through Check-out exactly as before. Runs the job list through the
// site as an Admin (Renson pilot on, so renson.js is active) and as a regular
// user, acknowledges every unmatched row, confirms, and prints what was sent
// to the Freedom Check-out function (stand-in backend; nothing real is
// touched). Run it on the code before the change (--repo <old checkout>) and
// after; the two outputs must be identical.
//   node tests/browser/checkout-same-freedom.js --pdf <Freedom job list> \
//        --node-modules <dir with @supabase/supabase-js@2.45.4, pdfjs-dist@4.7.76> [--repo <dir>]
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const pdf = opt("--pdf"), nm = opt("--node-modules");
const repo = path.resolve(opt("--repo") || path.join(__dirname, "../.."));
if (!pdf || !nm) { console.error("usage: --pdf <file> --node-modules <dir> [--repo <dir>]"); process.exit(2); }
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};
const ITEMS = [
  { id: "f-330068", item_code: "330068", description: "ZLS1-Brake Lever-01", current_qty: 100, unit_cost: 2.47, status: "active", bar_length_mm: null },
  { id: "f-620001", item_code: "620001", description: "IZLX Drawbar Mohair Holder", current_qty: 20, unit_cost: 30, status: "active", bar_length_mm: 5100 },
  { id: "f-310004-5100", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", current_qty: 40, unit_cost: 50, status: "active", bar_length_mm: 5100 },
  { id: "f-310004-2900", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", current_qty: 10, unit_cost: 30, status: "active", bar_length_mm: 2900 },
];

async function run(browser, role) {
  const admin = role === "admin";
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [], sent = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept());
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
  const user = { id: "00000000-0000-0000-0000-00000000000" + (admin ? "1" : "2"), aud: "authenticated", role: "authenticated", email: role + "@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: role, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: role, user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/checkout")) {
      const type = req.headers()["content-type"] || "";
      const body = /multipart/.test(type) ? JSON.parse((await new Response(req.postDataBuffer(), { headers: { "content-type": type } }).formData()).get("payload")) : JSON.parse(req.postData() || "{}");
      sent.push(body);
      return send(200, { ok: true, lines: body.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })), document: { saved: true } });
    }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpc = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpc === "renson_access") return send(200, admin);
    if (rpc) return send(200, null);
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: role, role: admin ? "admin" : "user", can_delete: true, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "inventory_items") return send(200, ITEMS);
    if (table === "renson_items") return send(200, admin ? [{ id: 1, item_code: "1118", description: "Somfy Situo 1", current_qty: 0, unit_cost: null }] : []);
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
  await p.waitForTimeout(1500);
  await p.click('nav button[data-v="fp"]'); await p.waitForTimeout(300);
  await p.setInputFiles("#fpPdf", pdf); await p.click("#fpExtract");
  await p.waitForSelector("#fpOut table", { timeout: 60000 });
  const preview = (await p.innerText("#fpOut")).replace(/\s+/g, " ");
  for (let k = 0; k < 80; k++) { const b = p.locator('#fpOut button[data-act="skip"]:not(.on):text-is("Acknowledge")').first(); if (!(await b.count())) break; await b.click(); await p.waitForTimeout(40); }
  if (!(await p.inputValue("#fpClient"))) await p.fill("#fpClient", "Test Client");
  await p.click("#fpConfirm");
  await p.waitForSelector("#fpDone .fp-done", { timeout: 30000 });
  const done = (await p.innerText("#fpDone")).replace(/\s+/g, " ");
  const rensonBox = await p.$("#fpRenson table");
  await p.close();
  return { role, payload: sent, preview, done, rensonBox: !!rensonBox, errors };
}

(async () => {
  const browser = await chromium.launch();
  const out = [];
  for (const role of ["admin", "user"]) out.push(await run(browser, role));
  await browser.close();
  // pdf_hash is the same file both times; strip nothing else.
  console.log(JSON.stringify(out, null, 1));
})();
