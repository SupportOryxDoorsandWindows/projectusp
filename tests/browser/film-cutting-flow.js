// Film Cutting (all active staff since 2026-10-29) in a browser against a stand-in backend
// (nothing real is read or saved; the sign-in is a local stand-in):
//   Admin: upload a job list -> checks -> settings (rolls on hand) ->
//   calculate -> approve (tick + "Yes, approve") -> Excel export, read back:
//   every panel once in "Piece references".
//   Staff: Film Cutting in the menu; sees the Approved plans, uploads and
//   calculates (no "Admins only" / "Testing mode" labels anywhere).
//
//   node tests/browser/film-cutting-flow.js --libs <folder> [--xlsx <job list>] [--shot <png>]
// --libs as in checkin-sweep.js (supabase-js@2.45.4, xlsx-js-style@1.2.0) plus
// highs@1.15.3 as "highs-1.15.3/package". Without --xlsx a made-up job list
// in the Etihad Rail layout is written first.
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

  // ---- Admin ----
  const { p, errors } = await session(browser, "admin");
  check(await p.isVisible("#navFilmCutting"), "admin sees Film Cutting in the menu");
  await p.click("#navFilmCutting");
  await p.waitForLoadState("networkidle"); await p.waitForTimeout(300); // the Approved plans list redraws the page
  await p.setInputFiles("#fcFile", xlsx);
  await p.waitForSelector(".fc-issues", { timeout: 30000 }).catch(async (e) => { console.log("BODY:", (await p.innerText("#fcBody")).slice(0, 600), "ERR:", JSON.stringify(errors)); throw e; });
  const issues = await p.$$eval(".fc-issue", (li) => li.map((x) => x.innerText.replace(/\s+/g, " ")));
  console.log("  checks: " + issues.join(" | "));
  check(issues.some((t) => /LEFT OUT/.test(t)) && issues.some((t) => /curved/.test(t)) && issues.some((t) => /called "Level 5"/.test(t)), "checks: left out, curved, level name");
  check((await p.inputValue("#fcJob")) === "SSF2026-999", "job name from the file name");
  const panels = await p.innerText(".fc-kpis .kpi:first-child b");
  check(panels === "29", "panels read: " + panels);
  await p.click('[data-act="to-settings"]');
  await p.waitForSelector("#fcLimit");
  check((await p.inputValue("#fcAllow")) === "30", "allowance starts at 30 mm");
  check(/950 \+ 830 \+ 30 = 1810 mm → no standard roll fits/.test(await p.innerText("#fcAllowEx")), "allowance example at 30 mm");
  await p.fill("#fcAllow", "20");
  check(/950 \+ 830 \+ 20 = 1800 mm → 1800 mm roll, 0 mm offcut/.test(await p.innerText("#fcAllowEx")), "allowance example at 20 mm");
  await p.fill("#fcAllow", "-5");
  await p.click('[data-act="calculate"]');
  check(/Allowance: a number of millimetres, 0 or more/.test(await p.innerText(".fc-note.bad")), "negative allowance rejected");
  await p.fill("#fcAllow", "20");
  // Not limited first: compare the three plans.
  await p.uncheck("#fcLimit");
  await p.click('[data-act="compare"]');
  await p.waitForFunction(() => !document.querySelector(".fc-note.busy") && /Compare the plans|Couldn't compare/.test(document.querySelector("#fcBody").innerText), null, { timeout: 120000 }).catch(async (e) => { console.log("BODY:", (await p.innerText("#fcBody")).slice(0, 300) + " ... " + (await p.innerText("#fcBody")).slice(-900), "ERR:", JSON.stringify(errors)); throw e; });
  check(!/Couldn't compare/.test(await p.innerText("#fcBody")), "compare ran");
  const cmp = await p.$$eval(".fc-tbl-card:has(h2:text-is('Compare the plans')) tbody tr", (trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ").trim()));
  console.log("  compare: " + cmp.join(" || "));
  check(cmp.length === 3, "three plans compared");
  // Within rolls on hand.
  await p.check("#fcLimit");
  for (const [W, n] of [[1000, "2"], [1200, "1"], [1500, "1"], [1800, "1"]]) await p.fill(`input[data-stock="${W}"][data-k="n"]`, n);
  await p.click('[data-act="calculate"]');
  await p.waitForSelector(".fc-approve", { timeout: 120000 });
  const tiles = await p.$$eval(".fc-kpis .kpi b", (b) => b.map((x) => x.innerText));
  console.log("  result tiles: " + tiles.join(" · "));
  const note = await p.innerText(".fc-note");
  check(/Least film possible/.test(note), "result says least film: " + note.slice(0, 80));
  check(await p.isVisible("text=Fits the rolls"), "fits the rolls on hand");
  const rollsTile = await p.innerText(".fc-kpis .kpi:nth-child(5)");
  check(/Rolls\s+\d+ of 5/.test(rollsTile), "rolls tile: " + rollsTile.replace(/\s+/g, " "));
  const each = await p.innerText(".fc-tbl-card:has(h2:text-is('Rolls on hand'))");
  check(!/0 cuts/.test(each) && /1 roll not used \(50\.0 m each\)/.test(each), "unused rolls in one line, not listed");
  check((await p.$$(".fc-approve [data-act=approve][disabled]")).length === 1, "Approve disabled until the plan is ticked as checked");
  if (shot) await p.screenshot({ path: shot, fullPage: true });
  // Draft export
  const draft = await readDownload(p, '[data-act="export"]');
  check(/DRAFT\.xlsx$/.test(draft.name), "draft export named DRAFT: " + draft.name);
  // Approve
  await p.check("#fcChecked");
  await p.click('[data-act="approve"]');
  await p.click('[data-act="approve-yes"]');
  await p.waitForSelector("text=Approved · version 1", { timeout: 15000 });
  check(db.plans.length === 1 && db.plans[0].plan.cuts.length > 0, "approved plan saved with its cuts");
  const exp = await readDownload(p, '[data-act="export"]');
  check(/v1\.xlsx$/.test(exp.name), "approved export: " + exp.name);
  check(JSON.stringify(exp.wb.SheetNames) === JSON.stringify(["Summary", "Cutting results", "Piece references", "Production batches", "Rolls"]), "sheets: " + exp.wb.SheetNames.join(", "));
  const pr = X.utils.sheet_to_json(exp.wb.Sheets["Piece references"], { header: 1 }).slice(3).filter((r) => r[0]);
  const ids = pr.map((r) => r[0]);
  check(ids.length === 29 && new Set(ids).size === 29 && pr.every((r) => r[8]), "every panel once, each with its cut (" + ids.length + ")");
  const res = X.utils.sheet_to_json(exp.wb.Sheets["Cutting results"], { header: 1 });
  check(JSON.stringify(res[2]) === JSON.stringify(["Cut ID", "Level", "Ref #", "Location", "Roll no.", "Stock width (mm)", "Cut length (mm)", "Pieces", "Pattern (mm)", "Used width incl. gaps", "Offcut width (mm)", "Stock area (m²)", "Panel area (m²)", "Utilization", "Piece IDs"]), "the result columns, in order (Roll no. after Location)");
  check(res.slice(3).every((r) => r[9] === String(r[8]).split(" + ").slice(0, -1).reduce((a, w) => a + Number(w), 0) + 20 && /\+ 20 allowance$/.test(r[8]) && r[10] === r[5] - r[9] && r[9] <= r[5] && Number.isInteger(r[4])), "used width = panels + 20 allowance, spare = stock - used");
  const cutIds = res.slice(3).filter((r) => r[0]).flatMap((r) => String(r[14]).split(", "));
  check(cutIds.length === 29 && new Set(cutIds).size === 29, "cut list holds each panel once");
  const sum = X.utils.sheet_to_json(exp.wb.Sheets.Summary, { header: 1 });
  check(sum.some((r) => /^APPROVED · version 1/.test(String(r[1] || ""))), "summary says approved");
  await p.waitForFunction(() => true, null, { timeout: 1000 }); await p.waitForTimeout(800); // the record is written just after the download starts
  check(db.log.map((l) => l.action).join(",") === "imported,calculated,exported,approved,exported", "record: " + db.log.map((l) => l.action).join(","));
  // Saved plans list + export from it
  await p.click('[data-act="to-settings"]'); await p.click('[data-act="back-upload"]');
  await p.click("#navFilmCutting");
  await p.waitForSelector('[data-act="export-saved"]', { timeout: 10000 });
  const saved = await readDownload(p, '[data-act="export-saved"]');
  check(/v1\.xlsx$/.test(saved.name), "export again from Approved plans: " + saved.name);
  check(Object.keys(db.files).length === 1 && Object.keys(db.files)[0] === fileHashBefore + ".xlsx", "original Excel kept once as <sha256>.xlsx");
  check(db.plans[0].source_file_path === fileHashBefore + ".xlsx", "plan points at the kept file");
  const orig = await readDownload(p, '[data-act="download-original"]');
  const origFile = orig.file;
  check(orig.name === path.basename(xlsx), "original downloads under its own name: " + orig.name);
  check(/Content-Type: application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/.test(db.uploadHead || "") && !/upsert/i.test(db.uploadHead || ""), "upload sent the file as Excel");
  check(fs.statSync(origFile).size > 0, "original file downloads");
  check(crypto.createHash("sha256").update(fs.readFileSync(xlsx)).digest("hex") === fileHashBefore, "uploaded file unchanged");
  check(!errors.length, "admin: no page errors " + JSON.stringify(errors));

  check(!(await p.$(".fc-test")) && !/Admins only|Testing mode/.test(await p.innerText("#v-film-cutting")), "admin: no Admins only / Testing mode labels");

  // ---- Staff ----
  const s = await session(browser, "staff");
  check(await s.p.isVisible("#navFilmCutting"), "staff: Film Cutting in the menu");
  check(await s.p.isVisible("nav.side-nav .side-group-opt"), "staff: Optimization heading");
  await s.p.click("#navFilmCutting");
  await s.p.waitForSelector('[data-act="export-saved"]', { timeout: 10000 });
  check(true, "staff: sees the Approved plans");
  await s.p.setInputFiles("#fcFile", xlsx);
  await s.p.waitForSelector('[data-act="to-settings"]:not([disabled])', { timeout: 30000 });
  await s.p.click('[data-act="to-settings"]');
  await s.p.uncheck("#fcLimit");
  await s.p.click('[data-act="calculate"]');
  await s.p.waitForSelector(".fc-approve", { timeout: 120000 });
  check(/Least film possible/.test(await s.p.innerText(".fc-note")), "staff: calculates");
  check(!/Admins only|Testing mode/.test(await s.p.innerText("#v-film-cutting")), "staff: no Admins only / Testing mode labels");
  check(!s.errors.length, "staff: no page errors " + JSON.stringify(s.errors));
  await browser.close();
  if (fail.length) { console.log("FAILED: " + fail.length); process.exit(1); }
  console.log("film-cutting flow: all checks passed");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
