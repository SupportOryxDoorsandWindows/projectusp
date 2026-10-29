// Reload keeps the page (user's request 2026-10-29): app.js showView
// remembers the open page per tab (sessionStorage "oryx_view") and boot.js
// presses that page's menu button again once all page scripts are loaded.
// Stand-in backend (same as film-cutting-flow.js); nothing real is read.
//   node tests/browser/reload-keeps-page.js --libs <folder>
// --libs as in film-cutting-flow.js.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const libDir = opt("--libs"), shot = opt("--shot");
let xlsx = opt("--xlsx");
if (!libDir) { console.error("usage: --libs <folder> [--xlsx <file>] [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "supabase-supabase-js-2.45.4/package/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style-1.2.0/package/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/highs@1.15.3/build/highs.js": "highs-1.15.3/package/build/highs.js",
  "https://cdn.jsdelivr.net/npm/highs@1.15.3/build/highs.wasm": "highs-1.15.3/package/build/highs.wasm",
};
const X = require(path.join(libDir, "xlsx-js-style-1.2.0/package"));

if (!xlsx) {
  const H = ["Ref #", "Location", null, "Width (mm)", "Height (mm)", "SQM", "Qty", "Total Sqm"];
  const rows = [[], [], H,
    [1, "Room A", "Door", 775, 2500, null, 2], [null, null, null, 920, 2680, null, 4], [null, null, null, 280, 2680, null, 1],
    [2, "Room B - completed", "Door", 775, 2505, null, null], [null, null, null, 1080, 2680, null, 2], [null, null, "Curve", 1040, 2680, null, 2],
    [3, "Room C", null, 970, 2680, null, 5], [null, null, null, 900, 2680, null, 3], [null, null, null, 190, 2680, null, 2],
    [12, null, null, null, null, null, "=SUM"], [],
    ["LEVEL 6"], [1, "Room D", null, 860, 2680, null, 4], [null, null, null, 1200, 2680, null, 1], [2, "Room E", "Door", 775, 2510, null, 1], [null, null, null, 930, 2680, null, 2],
  ];
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), "ETIHAD RAIL");
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["notes"]]), "Sheet2");
  xlsx = path.join(os.tmpdir(), "SSF2026-999 Test job.xlsx");
  X.writeFile(wb, xlsx);
}
const fileHashBefore = crypto.createHash("sha256").update(fs.readFileSync(xlsx)).digest("hex");

// Stand-in for supabase/sql/film_cutting.sql + film_cutting_open_to_staff.sql
// (every active staff account; both test accounts are active).
const db = { plans: [], log: [], files: {} }; // files: stand-in for the "film-cut-files" bucket
function rpc(name, a, admin) {
  const err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  const ok = (b) => ({ status: 200, body: b });
  if (name === "log_film_cut") { db.log.push({ action: a.p_action, job: a.p_job, plan_id: a.p_plan_id, details: a.p_details }); return ok(null); }
  if (name === "approve_film_cut_plan") {
    const fp = a.p_plan.source_file_path;
    if (fp && (!db.files[fp] || fp.split(".")[0] !== a.p_plan.source_file_hash)) return err("file_not_stored");
    const v = db.plans.filter((p) => p.job === a.p_plan.job).length + 1;
    const row = Object.assign({ id: "plan-" + (db.plans.length + 1), version: v, approved_by_name: "Admin Test", approved_at: new Date().toISOString() }, a.p_plan);
    db.plans.unshift(row); db.log.push({ action: "approved", job: row.job, plan_id: row.id });
    return ok({ id: row.id, version: v, approved_by_name: "Admin Test", file_kept: !!fp });
  }
  return err("unknown rpc " + name);
}

async function session(browser, role) {
  const admin = role === "admin";
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
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
    route.fulfill({ status: 200, contentType: url.endsWith(".wasm") ? "application/wasm" : "application/javascript", body: fs.readFileSync(path.join(libDir, cdn[url])) });
  });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const user = { id: "00000000-0000-0000-0000-00000000000" + (admin ? "1" : "2"), aud: "authenticated", role: "authenticated", email: role + "@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: role, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: role, user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    // Storage stand-in: upload (never overwrite), signed link, download.
    let m;
    if ((m = u.pathname.match(/^\/storage\/v1\/object\/film-cut-files\/(.+)$/)) && req.method() === "POST") {
      const name = decodeURIComponent(m[1]);
      if (!/^[0-9a-f]{64}\.(xlsx|xlsm|xls)$/.test(name)) return send(403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
      if (db.files[name]) return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      // Playwright does not hand over the file bytes of a browser upload
      // (only the form-data headers), so the stand-in keeps the headers and
      // serves the uploaded test file itself on download.
      db.files[name] = fileFromUpload(req);
      db.uploadHead = req.postDataBuffer().toString("latin1");
      return send(200, { Key: "film-cut-files/" + name });
    }
    if ((m = u.pathname.match(/^\/storage\/v1\/object\/sign\/film-cut-files\/(.+)$/)) && req.method() === "POST") {
      const name = decodeURIComponent(m[1]);
      if (!db.files[name]) return send(404, { statusCode: "404", error: "not_found", message: "Object not found" });
      return send(200, { signedURL: "/object/sign/film-cut-files/" + encodeURIComponent(name) + "?token=t" });
    }
    if ((m = u.pathname.match(/^\/storage\/v1\/object\/sign\/film-cut-files\/(.+)$/)) && req.method() === "GET") {
      const name = decodeURIComponent(m[1]), dl = u.searchParams.get("download");
      return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "Content-Disposition": "attachment; filename=\"" + (dl || name) + "\"" }, body: db.files[name] ? fs.readFileSync(xlsx) : Buffer.alloc(0) });
    }
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}"), admin); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: admin ? "Admin Test" : "Staff Test", role: admin ? "admin" : "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "film_cut_plans") {
      const id = (u.searchParams.get("id") || "").replace(/^eq\./, "");
      if (id) { const row = db.plans.find((x) => x.id === id) || null; return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? row : [row]); }
      return send(200, db.plans);
    }
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
  await p.waitForTimeout(800);
  return { p, errors };
}

const fail = [];
const check = (ok, t) => { console.log((ok ? "ok  " : "FAIL") + " · " + t); if (!ok) fail.push(t); };

// supabase-js sends a File as multipart/form-data (Supabase Storage keeps
// only the file part): take the part that is not "cacheControl".
function fileFromUpload(req) {
  const body = req.postDataBuffer();
  const m = /boundary=(.+)$/.exec(req.headers()["content-type"] || "");
  if (!m) return body;
  const sep = Buffer.from("--" + m[1]);
  let at = body.indexOf(sep), out = body;
  while (at >= 0) {
    const next = body.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = body.subarray(at + sep.length, next);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString();
    if (!/name="cacheControl"/.test(head)) { out = part.subarray(headEnd + 4, part.length - 2); break; }
    at = next;
  }
  return out;
}

async function readDownload(p, click) {
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click(click)]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fc-dl-")), dl.suggestedFilename()); // never over the uploaded file
  await dl.saveAs(file);
  return { name: dl.suggestedFilename(), file, wb: X.readFile(file) };
}

(async () => {
  const browser = await chromium.launch();
  const { p, errors } = await session(browser, "admin");
  const on = async () => [await p.evaluate(() => document.querySelector(".view.on").id), await p.evaluate(() => (document.querySelector("nav button.on") || {}).dataset && document.querySelector("nav button.on").dataset.v)];
  check((await on())[0] === "v-dashboard", "first open: Dashboard " + (await on()));
  for (const v of ["film-cutting", "delivery-notes", "master-inventory", "activity", "admin"]) {
    await p.click('nav button[data-v="' + v + '"]');
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
    await p.waitForTimeout(1500);
    const [view, nav] = await on();
    check(view === "v-" + v && nav === v, "after reload on " + v + ": " + view + " / " + nav);
  }
  // Film Cutting really loaded its data after the reload (Approved plans asked for).
  await p.click('nav button[data-v="film-cutting"]');
  await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(1500);
  check(/Choose the job list/.test(await p.innerText("#fcBody")), "film cutting page drawn after reload");
  // Nothing remembered (a new tab): starts on the Dashboard.
  await p.evaluate(() => sessionStorage.removeItem("oryx_view"));
  await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(1500);
  check(await p.evaluate(() => document.querySelector(".view.on").id) === "v-dashboard", "nothing remembered: Dashboard");
  // Staff: a remembered Admin-only page is never reopened.
  const s2 = await session(browser, "staff");
  await s2.p.evaluate(() => sessionStorage.setItem("oryx_view", "admin"));
  await s2.p.reload({ waitUntil: "networkidle" }); await s2.p.waitForTimeout(1500);
  check(await s2.p.evaluate(() => document.querySelector(".view.on").id) === "v-dashboard", "staff: remembered Admin page not reopened");
  // A reload cuts off requests still running ("Failed to fetch"), and the
  // stand-in does not answer the Admin screen's "last active" call.
  const real = errors.concat(s2.errors).filter((e) => !/Failed to fetch|admin_user_last_active/.test(e));
  check(!real.length, "no page errors " + JSON.stringify(real));
  await browser.close();
  if (fail.length) { console.log("FAILED: " + fail.length); process.exit(1); }
  console.log("reload checks passed");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
