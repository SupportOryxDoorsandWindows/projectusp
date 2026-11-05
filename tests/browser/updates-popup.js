// What's New pop-up when the app is opened (updates.js popNew), against a
// stand-in backend. Run:
//   node tests/browser/updates-popup.js --node-modules <dir with @supabase/supabase-js@2.45.4,
//        xlsx-js-style@1.2.0, pdfjs-dist@4.7.76> [--shot <png>]
// Checks: the newest unread updates (last 14 days) open by themselves, oldest
// first, "Next update" then "Got it"; each is marked read; an old one (over
// 14 days) or an already-read one never pops; a reload in the same tab
// doesn't pop again; nothing pops when there is nothing new.
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
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
// TEST DATA only (never written to the live table).
const UPDATES = [
  { id: "u-new", status: "published", category: "improvement", title: "Test update B (newest)", summary: "Second.", details: "Step 1.\nStep 2.", publisher_name: "Admin Test", published_at: ago(0.1), created_at: ago(1), updated_at: ago(0.1) },
  { id: "u-mid", status: "published", category: "new_feature", title: "Test update A", summary: "First.", details: null, publisher_name: "Admin Test", published_at: ago(2), created_at: ago(3), updated_at: ago(2) },
  { id: "u-read", status: "published", category: "bug_fix", title: "Already read", summary: "x", publisher_name: "Admin Test", published_at: ago(1), created_at: ago(1), updated_at: ago(1) },
  { id: "u-old", status: "published", category: "bug_fix", title: "Old update", summary: "x", publisher_name: "Admin Test", published_at: ago(30), created_at: ago(30), updated_at: ago(30) },
];

async function session(browser, state) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
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
  const user = { id: "00000000-0000-0000-0000-000000000002", aud: "authenticated", role: "authenticated", email: "staff@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: "staff", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "staff", user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: "Staff Test", role: "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "system_updates") return send(200, /status=eq\.published/.test(u.search) ? state.updates : []);
    if (table === "system_update_reads") {
      if (req.method() === "POST") { JSON.parse(req.postData() || "[]").forEach((r) => state.reads.add(r.update_id)); state.posts.push(JSON.parse(req.postData() || "[]")); return send(201, []); }
      return send(200, [...state.reads].map((update_id) => ({ update_id })));
    }
    if (u.pathname.startsWith("/rest/v1/rpc/")) return send(200, null);
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 }).catch(async (e) => { console.error(errors, (await p.innerText("body")).slice(0, 500)); throw e; });
  await p.waitForTimeout(2500);
  return { p, errors, ctx };
}

const fail = [];
const check = (ok, t) => { console.log((ok ? "ok  " : "FAIL") + " · " + t); if (!ok) fail.push(t); };

(async () => {
  const browser = await chromium.launch();
  const state = { updates: UPDATES, reads: new Set(["u-read"]), posts: [] };
  const { p, errors } = await session(browser, state);
  const dlg = "#updDetail[open]";
  check(!!(await p.$(dlg)), "app opened: an update pops by itself");
  let t = await p.innerText("#updDetail");
  check(/Test update A/.test(t) && /1 of 2/.test(t) && /Next update/.test(t), "oldest new one first (A), '1 of 2', Next update");
  if (shot) await p.screenshot({ path: shot });
  check(state.reads.has("u-mid"), "A marked read");
  await p.click("[data-upd-next]"); await p.waitForTimeout(400);
  t = await p.innerText("#updDetail");
  check(/Test update B/.test(t) && /2 of 2/.test(t) && /Got it/.test(t) && /Step 1\.\s*Step 2\./.test(t), "then B, '2 of 2', Got it, instructions shown");
  await p.click("#updDetail [data-upd-close]"); await p.waitForTimeout(300);
  check(!(await p.$(dlg)) && state.reads.has("u-new"), "Got it: closed, B marked read");
  check(!state.posts.flat().some((r) => r.update_id === "u-old" || r.update_id === "u-read"), "old (30 days) and already-read updates never popped");
  await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(2500);
  check(!(await p.$(dlg)), "reload: nothing pops again");
  check(!errors.length, "no page errors " + errors.join(" | "));

  // Nothing new = no pop-up
  const s2 = await session(browser, { updates: [UPDATES[3]], reads: new Set(), posts: [] });
  check(!(await s2.p.$(dlg)), "nothing new in the last 14 days: no pop-up");

  // Closed without reading the second: it pops next time the app is opened (new tab), not on this one
  const st3 = { updates: UPDATES, reads: new Set(["u-read"]), posts: [] };
  const s3 = await session(browser, st3);
  await s3.p.click("#updDetail [data-upd-close]"); await s3.p.waitForTimeout(300);
  check(st3.reads.has("u-mid") && !st3.reads.has("u-new"), "Close on the first: only that one marked read");
  const s4 = await session(browser, st3);
  t = await s4.p.innerText("#updDetail").catch(() => "");
  check(/Test update B/.test(t) && !/of 2/.test(t), "next time the app is opened: B pops (alone)");

  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
