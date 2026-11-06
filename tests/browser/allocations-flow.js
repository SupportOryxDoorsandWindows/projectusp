// Allocated Materials (allocations.js + the "Allocate instead" button on the
// Check-out page + Master Inventory's Allocated / Available columns), against
// a stand-in backend (its rules are tested on Postgres in
// tests/sql/allocations.test.sql). Run:
//   node tests/browser/allocations-flow.js --pdf <made-up Freedom job list, as for
//        checkout-same-freedom.js> --node-modules <dir with @supabase/supabase-js@2.45.4,
//        pdfjs-dist@4.7.76, xlsx-js-style@1.2.0> [--shot <png>]
// Checks: the job list is allocated instead of checked out (no Check-out sent),
// a short line is capped at what is available, a line can be unticked;
// Master Inventory shows Total stock / Allocated / Available, hover and click;
// the page lists the job, release needs a reason; allocating by hand; after a
// real Check-out the allocation note is shown; no stock writes from allocating.
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const pdf = opt("--pdf"), nm = opt("--node-modules"), shot = opt("--shot");
if (!pdf || !nm) { console.error("usage: --pdf <file> --node-modules <dir> [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style/dist/xlsx.bundle.js",
};
// Made-up items (same as checkout-same-freedom.js)
const ITEMS = [
  { id: "f-330068", item_code: "330068", description: "ZLS1-Brake Lever-01", current_qty: 100, unit_cost: 2.47, status: "active", bar_length_mm: null, unit_of_measure: "pcs" },
  { id: "f-620001", item_code: "620001", description: "IZLX Drawbar Mohair Holder", current_qty: 20, unit_cost: 30, status: "active", bar_length_mm: 5100, unit_of_measure: "pcs" },
  { id: "f-310004-5100", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", current_qty: 40, unit_cost: 50, status: "active", bar_length_mm: 5100, unit_of_measure: "pcs", buffer_level: 39 },
  { id: "f-310004-2900", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", current_qty: 10, unit_cost: 30, status: "active", bar_length_mm: 2900, unit_of_measure: "pcs" },
];
const RENSON = [{ id: 7, item_code: "R7", description: "Renson part (made up)", unit: "pc", current_qty: 12, unit_cost: 3 }];
const now = () => new Date().toISOString();

// In-memory stand-in for supabase/sql/allocations.sql
const db = { allocs: [], lines: [], log: [], calls: [], stockWrites: [], syncNext: null };
function addAlloc(job, client, lines) {
  let a = db.allocs.find((x) => x.status === "open" && x.job_number.replace(/\W/g, "") === job.replace(/\W/g, ""));
  if (!a) { a = { id: db.allocs.length + 1, job_number: job, client, status: "open", created_by_name: "Staff Test", created_at: now(), updated_at: now(), notes: null }; db.allocs.push(a); }
  for (const l of lines) {
    const it = l.inventory === "renson" ? RENSON.find((i) => String(i.id) === String(l.item_id)) : ITEMS.find((i) => i.id === l.item_id);
    let x = db.lines.find((y) => y.allocation_id === a.id && y.inventory === l.inventory && String(y.freedom_item_id || y.renson_item_id) === String(l.item_id));
    if (x) { x.qty_allocated += l.qty; x.qty_open += l.qty; continue; }
    db.lines.push({ id: db.lines.length + 1, allocation_id: a.id, inventory: l.inventory, freedom_item_id: l.inventory === "freedom" ? l.item_id : null, renson_item_id: l.inventory === "renson" ? Number(l.item_id) : null,
      item_code: it.item_code, description: it.description, unit: it.unit_of_measure || it.unit, qty_allocated: l.qty, qty_checked_out: 0, qty_released: 0, qty_open: l.qty, created_at: now(), updated_at: now() });
  }
  return a;
}
const openQty = (inv, id) => db.lines.filter((l) => l.inventory === inv && String(l.freedom_item_id || l.renson_item_id) === String(id) && db.allocs.find((a) => a.id === l.allocation_id).status === "open").reduce((s, l) => s + l.qty_open, 0);
// Another job already holds all 20 Mohair Holders: none available.
addAlloc("OTHER-1", "Someone", [{ inventory: "freedom", item_id: "f-620001", qty: 20 }]);

function rpc(name, a) {
  db.calls.push({ name, a });
  const ok = (b) => ({ status: 200, body: b }), err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  if (name === "renson_access") return ok(true);
  if (name === "allocation_sync") { const r = db.syncNext; db.syncNext = null; return ok({ ok: true, updated: r ? [r] : [] }); }
  if (name === "allocation_create") {
    const p = a.p;
    for (const l of p.lines) {
      const it = l.inventory === "renson" ? RENSON.find((i) => String(i.id) === String(l.item_id)) : ITEMS.find((i) => i.id === l.item_id);
      const av = it.current_qty - openQty(l.inventory, l.item_id);
      if (l.qty > av) return err(`more_than_available: ${it.item_code} (available ${av}, asked ${l.qty})`);
    }
    const al = addAlloc(p.job_number, p.client, p.lines);
    db.log.push({ id: db.log.length + 1, allocation_id: al.id, action: "allocated", detail: { lines: p.lines.map((l) => ({ code: l.item_id, qty: l.qty })), source: p.source }, by_name: "Staff Test", created_at: now() });
    return ok({ ok: true, id: al.id, job_number: al.job_number, new: true, lines: p.lines.length });
  }
  if (name === "allocation_release") {
    const p = a.p;
    if (!String(p.reason || "").trim()) return err("reason_missing");
    const al = db.allocs.find((x) => x.id === p.allocation_id);
    for (const c of p.all ? db.lines.filter((l) => l.allocation_id === al.id).map((l) => ({ line_id: l.id, qty: l.qty_open })) : p.lines) {
      const l = db.lines.find((x) => x.id === c.line_id);
      if (c.qty > l.qty_open) return err(`more_than_open: ${l.item_code} (open ${l.qty_open})`);
      l.qty_released += c.qty; l.qty_open -= c.qty;
    }
    if (!db.lines.some((l) => l.allocation_id === al.id && l.qty_open > 0)) al.status = "cancelled";
    db.log.push({ id: db.log.length + 1, allocation_id: al.id, action: "released", detail: { reason: p.reason, all: !!p.all, lines: [] }, by_name: "Staff Test", created_at: now() });
    return ok({ ok: true, status: al.status });
  }
  return ok(null);
}

async function session(browser) {
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [], sent = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|websocket/i.test(m.text())) errors.push(m.text()); });
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
  const user = { id: "00000000-0000-0000-0000-000000000002", aud: "authenticated", role: "authenticated", email: "staff@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: "t", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "t", user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/checkout")) {
      const type = req.headers()["content-type"] || "";
      const body = /multipart/.test(type) ? JSON.parse((await new Response(req.postDataBuffer(), { headers: { "content-type": type } }).formData()).get("payload")) : JSON.parse(req.postData() || "{}");
      sent.push(body);
      return send(200, { ok: true, lines: body.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })), document: { saved: true } });
    }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const name = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (name) { const r = rpc(name, JSON.parse(req.postData() || "{}")); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (req.method() !== "GET" && table !== "system_update_reads") db.stockWrites.push(req.method() + " " + table);
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: "Staff Test", role: "user", can_delete: true, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "inventory_items") return send(200, ITEMS);
    if (table === "renson_items") return send(200, RENSON);
    if (table === "allocations") return send(200, u.searchParams.get("status") === "eq.open" ? db.allocs.filter((a) => a.status === "open") : db.allocs.slice().reverse());
    if (table === "allocation_lines") return send(200, u.searchParams.get("qty_open") === "gt.0" ? db.lines.filter((l) => l.qty_open > 0) : db.lines);
    if (table === "allocation_log") return send(200, db.log.filter((x) => String(x.allocation_id) === (u.searchParams.get("allocation_id") || "").replace("eq.", "")));
    // 300 Mohair Holders on an open PO (Materials in Transit), linked to the item
    if (table === "transit_orders") return send(200, [{ id: 1, po_number: "PO-T1", delivery_status: "ordered", expected_delivery: null }]);
    if (table === "transit_lines") return send(200, [{ id: 1, order_id: 1, freedom_item_id: "f-620001", renson_item_id: null, qty_pending: 300, unit: "pcs" }]);
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
  await p.waitForTimeout(1500);
  return { p, errors, sent };
}

const fail = [];
const check = (ok, t) => { console.log((ok ? "ok  " : "FAIL") + " · " + t); if (!ok) fail.push(t); };

async function readJobList(p) {
  await p.click('nav button[data-v="fp"]'); await p.waitForTimeout(300);
  await p.setInputFiles("#fpPdf", pdf); await p.click("#fpExtract");
  await p.waitForSelector("#fpOut table", { timeout: 60000 });
  for (let k = 0; k < 80; k++) { const b = p.locator('#fpOut button[data-act="skip"]:not(.on):text-is("Acknowledge")').first(); if (!(await b.count())) break; await b.click(); await p.waitForTimeout(40); }
  if (!(await p.inputValue("#fpClient"))) await p.fill("#fpClient", "Test Client");
}

(async () => {
  const browser = await chromium.launch();
  const { p, errors, sent } = await session(browser);
  const menu = await p.$$eval("nav.side-nav button[data-v]", (b) => b.map((x) => x.textContent.trim()));
  check(menu.indexOf("Allocated Materials") === menu.indexOf("Materials in Transit") + 1, "menu: Allocated Materials right after Materials in Transit");

  // 1. Job list -> Allocate instead
  await readJobList(p);
  const job = await p.inputValue("#fpJobNumber");
  check(await p.isVisible("#fpAllocate") && await p.isEnabled("#fpAllocate"), "Check-out page: \"Allocate instead\" next to Confirm (job " + job + ")");
  await p.click("#fpAllocate"); await p.waitForSelector("#alNewDlg[open]");
  const t = await p.innerText("#alNewDlg");
  const mohair = p.locator("#alNewDlg tr", { hasText: "620001" });
  const mc = await mohair.locator("td").allInnerTexts();
  check(/Allocate this job list/i.test(t) && mc[4].trim() === "0" && /^0\s*1 short/.test(mc[5].trim()) && await mohair.locator("input[type=checkbox]").isDisabled(), "allocate window: 620001 none available: 0, marked short, can't be ticked (" + mc.slice(3).join("|").replace(/\s+/g, " ") + ")");
  if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-allocate.png") });
  // untick the 330068 line
  const brake = p.locator("#alNewDlg tr", { hasText: "330068" });
  await brake.locator("input[type=checkbox]").uncheck(); await p.waitForTimeout(150);
  await p.click("#alNewDlg [data-al-save]"); await p.waitForTimeout(1200);
  const c = db.calls.filter((x) => x.name === "allocation_create").pop();
  check(c && c.a.p.job_number === job && c.a.p.source === "job_list" && !c.a.p.lines.some((l) => l.item_id === "f-330068") && !c.a.p.lines.some((l) => l.item_id === "f-620001") && c.a.p.lines.length === 1,
    "saved: job number, from the job list, 330068 unticked and 620001 short left out " + JSON.stringify(c && c.a.p.lines));
  check(/Allocated — \d+ materials? reserved for job/.test(await p.innerText("#fpDone")) && !sent.length, "done: allocated message, NO Check-out sent");
  check(!db.stockWrites.length, "no table writes " + JSON.stringify(db.stockWrites));

  // 2. Master Inventory columns
  await p.click('nav button[data-v="master-inventory"]'); await p.waitForTimeout(1800);
  const head = await p.innerText("#miItemsTable thead");
  const cells = async (id) => (await p.$$eval(`tr[data-mi-row="${id}"] td`, (td) => td.slice(1, 6).map((x) => x.innerText.trim())));
  const m = await cells("f-620001");
  check(/Physical stock\s+Allocated\s+In transit\s+Available\s+Forecast available/.test(head), "Master Inventory: Physical stock, Allocated, In transit, Available, Forecast available (in that order)");
  check(m.join("|") === "20|20|300|0|300", "620001: 20 physical, 20 allocated (other job), 300 in transit, 0 available, 300 forecast (" + m.join("|") + ")");
  const free = await cells("f-330068");
  check(free.join("|") === "100|—|—|100|100", "330068 (unticked): nothing allocated or in transit, all available (" + free.join("|") + ")");
  // Kanban triggered on Available: 310004 5100 mm has 40 (above its trigger 39), 2 allocated -> 38 available
  {
    const cls = await p.getAttribute('tr[data-mi-row="f-310004-5100"]', "class");
    const st = await p.innerText('tr[data-mi-row="f-310004-5100"]');
    check(/kb-avail/.test(cls) && /In stock/.test(st) && /Kanban triggered/.test(st), "310004: orange row, still \"In stock\" + \"Kanban triggered\" (available 38 <= trigger 39)");
    check(!/kb-avail/.test(await p.getAttribute('tr[data-mi-row="f-330068"]', "class")), "330068 (no trigger): not orange");
  }
  // Extract (.xlsx) in Pau's layout
  {
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#miExtractBtn")]);
    const file = await dl.path();
    const X = require(path.join(nm, "xlsx-js-style"));
    const ws = X.readFile(file, { cellStyles: true }).Sheets["Master Inventory"];
    const rows = X.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const head = rows[3], row = rows.find((r) => r[0] === "620001");
    check(head.slice(5, 10).join("|") === "Physical Stock Qty|Allocated Materials Qty|Materials in Transit Qty|Available Stock Qty|Forecast Available Stock Qty"
      && /Oryx Doors & Windows — Master Inventory/.test(rows[0][0]) && /^Generated /.test(rows[1][0]), "Extract: title, date, the five quantity headings in order");
    check(row && row.slice(5, 10).join("|") === "20|20|300|0|300" && head[14] === "Status", "Extract 620001: 20|20|300|0|300 (" + (row && row.slice(5, 10).join("|")) + ")");
    const hr = rows.find((r) => r[0] === "310004" && r[3] === 5100);
    check(head[15] === "Note" && hr && hr[15] === "Kanban triggered" && hr[14] === "OK" && !rows.filter((r) => r[0] === "330068").some((r) => r[15]), "Extract: \"Kanban triggered\" note on 310004 only, status still OK");
    const styles = require("child_process").execFileSync("unzip", ["-p", file, "xl/styles.xml"]).toString();
    check(/FF4D4D/i.test(styles), "Extract: quantity headings in red (red font in the file's styles)");
  }
  const tip = await p.getAttribute('tr[data-mi-row="f-620001"] [data-mi-alloc]', "title");
  check(/Job OTHER-1 \(Someone\) · 20/.test(tip) && !new RegExp("Job " + job).test(tip), "hover: the job holding it");
  if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-master.png") });
  await p.click('tr[data-mi-row="f-620001"] [data-mi-alloc]'); await p.waitForTimeout(1000);
  check(await p.isVisible("#v-allocations") && (await p.inputValue("#alSearch")) === "620001", "click: Allocated Materials, searching 620001");
  check((await p.$$("#alTable tr[data-al-toggle]")).length === 1, "  ... only the job that holds it");

  // 3. The job: details + release
  await p.fill("#alSearch", ""); await p.waitForTimeout(200);
  const myId = db.allocs.find((a) => a.job_number === job).id;
  await p.click(`#alTable tr[data-al-toggle="${myId}"]`); await p.waitForTimeout(200);
  await p.click(`#alTable button[data-al-open="${myId}"]`); await p.waitForSelector("#alDlg[open]");
  const line = db.lines.find((l) => l.allocation_id === myId && l.freedom_item_id === "f-310004-5100") || db.lines.find((l) => l.allocation_id === myId && l.qty_open > 0);
  await p.fill(`[data-al-rel="${line.id}"]`, "1");
  await p.click("#alRelForm button[type=submit]"); await p.waitForTimeout(400);
  check(/Enter the reason/.test(await p.innerText("#alRelMsg")) && !db.calls.some((x) => x.name === "allocation_release"), "release: no reason = nothing sent");
  await p.fill("#alReason", "Job changed"); await p.click("#alRelForm button[type=submit]"); await p.waitForTimeout(1000);
  const r = db.calls.filter((x) => x.name === "allocation_release").pop();
  check(r && r.a.p.reason === "Job changed" && r.a.p.lines[0].line_id === line.id && r.a.p.lines[0].qty === 1, "release: 1 with the reason");
  await p.click("[data-al-close]");

  // 4. By hand
  await p.click("#alManual"); await p.waitForSelector("#alNewDlg[open]");
  await p.fill("#alJob", "HAND-7"); await p.fill("#alClient", "Walk-in");
  const optVal = await p.$eval("#alListfreedom option", (o) => o.value);
  await p.fill('[data-al-m="pick"][data-i="0"]', optVal); await p.press('[data-al-m="pick"][data-i="0"]', "Tab"); await p.waitForTimeout(200);
  await p.fill('[data-al-m="qty"][data-i="0"]', "5"); await p.press('[data-al-m="qty"][data-i="0"]', "Tab"); await p.waitForTimeout(200);
  await p.click("#alNewDlg [data-al-save]"); await p.waitForTimeout(1000);
  const h = db.calls.filter((x) => x.name === "allocation_create").pop();
  check(h && h.a.p.job_number === "HAND-7" && h.a.p.source === "manual" && h.a.p.lines.length === 1 && h.a.p.lines[0].qty === 5, "by hand: HAND-7, 1 line of 5 " + JSON.stringify(h && h.a.p.lines));
  // asking more than available is refused, nothing saved
  await p.click("#alManual"); await p.waitForSelector("#alNewDlg[open]");
  await p.fill("#alJob", "HAND-8");
  const mohairOpt = await p.$$eval("#alListfreedom option", (o) => o.map((x) => x.value).find((v) => v.startsWith("620001")));
  await p.fill('[data-al-m="pick"][data-i="0"]', mohairOpt); await p.press('[data-al-m="pick"][data-i="0"]', "Tab"); await p.waitForTimeout(200);
  await p.fill('[data-al-m="qty"][data-i="0"]', "2"); await p.press('[data-al-m="qty"][data-i="0"]', "Tab"); await p.waitForTimeout(200);
  await p.click("#alNewDlg [data-al-save]"); await p.waitForTimeout(800);
  check(/Not enough available for 620001/.test(await p.innerText("#alNMsg")) && !db.allocs.some((a) => a.job_number === "HAND-8"), "more than available: refused with a clear message");
  await p.click("[data-al-nclose]");

  // 5. A real Check-out of the job afterwards: the allocation note
  const before = sent.length;
  db.syncNext = { id: myId, job_number: job, lines: 1, qty: 1, status: "open" };
  await p.click('nav button[data-v="fp"]'); await p.waitForTimeout(300);
  await p.click("#fpNew"); await p.waitForTimeout(300);
  await readJobList(p);
  await p.click("#fpConfirm"); await p.waitForSelector("#fpDone .fp-done", { timeout: 30000 }); await p.waitForTimeout(800);
  check(sent.length === before + 1 && /Allocation: job .* 1 checked out from its reservation/.test(await p.innerText("#fpDone")), "Check-out saved as usual, then the allocation note");
  check(db.calls.filter((x) => x.name === "allocation_sync").some((x) => x.a.p_job === job), "  ... sync asked for that job");
  check(!errors.length, "no page errors " + errors.join(" | "));
  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
