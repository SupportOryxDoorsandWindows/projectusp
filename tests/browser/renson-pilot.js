// Renson inventory -- Admin-only pilot (renson.js, 2026-11-02), against a
// STAND-IN backend (never the live project):
//  - a regular user: renson.js is not even loaded, no dropdown, no Renson
//    request is ever sent;
//  - an Admin with the pilot flag ON: Master Inventory dropdown Freedom /
//    Renson (pilot), import of the real stock file with review, inventory + value, reload
//    keeps Renson, back to the Freedom list;
//  - an Admin with the flag OFF: nothing appears;
//  - during all of it, no write of any kind to a Freedom table or function.
//   node tests/browser/renson-pilot.js --xlsx "<RENSON STOCK OCT 27.xlsx>"
//        --node-modules <folder with @supabase/supabase-js@2.45.4, xlsx-js-style@1.2.0, pdfjs-dist@4.7.76>
//        [--job-pdf "<Renson job list, e.g. 24222-Paolo OPT LIST Rev. 02.pdf>"] [--shot <png>]
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const xlsx = opt("--xlsx"), nm = opt("--node-modules"), shot = opt("--shot"), jobPdf = opt("--job-pdf");
// --renson-docs <dir>: the Renson NV samples SUP_1 (quotation 20120358) and
// SUP_03 (order confirmation 167012), named *SUP_1_* / *SUP_03_* (not
// committed: supplier documents).
const docDir = opt("--renson-docs");
const pick = (re) => { if (!docDir) return null; const f = fs.readdirSync(docDir).find((n) => re.test(n)); return f ? path.join(docDir, f) : null; };
const rensonDocs = [
  { name: "SUP_1", file: pick(/SUP_1_/i), number: "20120358", lines: 57, ask: ["15130", "14506", "2128"],
    expect: { "22034": "1000", "2405": "500", "6557": "500", "17710": "4000", "15130": "" },
    check: (ci) => { const s = ci.lines.reduce((x, l) => x + (l.shipping_allocated || 0), 0); const nw = ci.lines.filter((l) => l.new_item); return Math.abs(s - 100) < 0.001 && nw.length === 1 && nw[0].item_code === "20315"; },
    checkText: "Pickup Fee (EUR 100) spread as shipping; 20315 added as a new item" },
  { name: "SUP_03", file: pick(/SUP_03_/i), number: "167012", lines: 48, ask: [],
    expect: { "27409": "50", "17504": "5000", "2399": "600", "6557": "550", "2405": "500", "22034": "3000", "25089": "60" },
    check: (ci) => { const l = ci.lines.find((x) => x.item_code === "22034"); return l && l.qty === 3000 && Math.abs(l.original_unit_cost - 148.5 / 3000) < 1e-6; },
    checkText: "22034: 3 cartons = 3000 pcs at EUR 148.50 / 3000 each (net after discount)" },
].filter((d) => d.file);
if (!xlsx || !nm) { console.error("usage: --xlsx <file> --node-modules <folder> [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};

// Stand-in for supabase/sql/renson_pilot.sql
const db = { items: [], imports: [], flag: true, calls: [], freedomCheckouts: [] };
function rpc(name, a, admin) {
  const ok = (b) => ({ status: 200, body: b });
  const err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  const access = admin && db.flag;
  if (name === "renson_access") return ok(access);
  if (name === "renson_import_stock") {
    if (!access) return { status: 403, body: { message: "renson_not_allowed", code: "42501" } };
    if (db.items.length) return err("renson_already_imported");
    db.imports.push({ id: 1, file_name: a.p.file_name, imported_by_name: "Admin Test", created_at: new Date().toISOString() });
    db.lastPayload = a.p;
    db.items = a.p.items.map((i, k) => ({ id: k + 1, item_code: i.item_code, alt_codes: i.alt_codes || null, description: i.description,
      product_size: i.product_size || null, colour: i.colour || null, unit: i.unit || null, current_qty: i.qty, unit_cost: i.unit_cost,
      current_value: Math.round(i.qty * (i.unit_cost || 0) * 100) / 100 }));
    const total = db.items.reduce((s, i) => s + i.current_value, 0);
    return ok({ import_id: 1, items: db.items.length, items_with_stock: db.items.filter((i) => i.current_qty > 0).length, total_value: Math.round(total * 100) / 100 });
  }
  if (name === "renson_checkout") {
    if (!access) return { status: 403, body: { message: "renson_not_allowed", code: "42501" } };
    if (a.p.document_hash && (db.moves || []).some((m) => m.document_hash === a.p.document_hash)) return err("renson_job_list_already_checked_out");
    db.lastCheckout = a.p; db.moves = db.moves || []; db.rensonCheckoutAt = Date.now() + Math.random();
    let total = 0, below = 0;
    for (const l of a.p.lines) {
      const it = db.items.find((i) => i.item_code === l.item_code);
      if (!it) return err("not_a_renson_item: " + l.item_code);
    }
    for (const l of a.p.lines) {
      const it = db.items.find((i) => i.item_code === l.item_code);
      const before = it.current_qty; it.current_qty = Math.round((before - l.qty) * 1000) / 1000;
      it.current_value = Math.round(it.current_qty * (it.unit_cost || 0) * 100) / 100;
      const value = Math.round(l.qty * (it.unit_cost || 0) * 100) / 100; total += value; if (it.current_qty < 0) below++;
      db.moves.unshift({ id: db.moves.length + 1, item_id: it.id, item_code: it.item_code, type: "check_out", quantity: l.qty, unit: l.unit, source: l.source,
        qty_before: before, qty_after: it.current_qty, value, job_number: a.p.job_number, document_hash: a.p.document_hash, performed_by_name: "Admin Test", created_at: new Date().toISOString() });
    }
    return ok({ lines: a.p.lines.length, total_value: Math.round(total * 100) / 100, below_zero: below });
  }
  // Stand-ins for renson_workflow.sql (its sums are tested on Postgres; here
  // only what the page sends and shows matters).
  const move = (it, extra) => { db.moves = db.moves || []; db.moves.unshift(Object.assign({ id: db.moves.length + 1000, item_id: it.id, item_code: it.item_code,
    performed_by_name: "Admin Test", created_at: new Date().toISOString() }, extra)); };
  if (name === "renson_checkin") {
    if (!access) return { status: 403, body: { message: "renson_not_allowed", code: "42501" } };
    db.lastCheckin = a.p;
    let total = 0, created = 0;
    for (const l of a.p.lines) {
      let it = db.items.find((i) => i.item_code === l.item_code);
      if (!it && l.new_item) { it = { id: db.items.length + 1, item_code: l.item_code, description: l.new_item.description, unit: l.new_item.unit, current_qty: 0, unit_cost: null, current_value: 0 }; db.items.push(it); created++; }
      if (!it) return err("not_a_renson_item: " + l.item_code);
      const paid = l.original_unit_cost == null ? null : (l.original_unit_cost + (l.shipping_allocated || 0) / l.qty) * a.p.exchange_rate;
      const before = it.current_qty, cost0 = it.unit_cost;
      it.unit_cost = before > 0 && (cost0 || 0) > 0 && paid != null ? (before * cost0 + l.qty * paid) / (before + l.qty) : (paid != null ? paid : cost0);
      it.current_qty = before + l.qty; it.current_value = Math.round(it.current_qty * (it.unit_cost || 0) * 100) / 100;
      const value = Math.round(l.qty * ((paid != null ? paid : cost0) || 0) * 100) / 100; total += value;
      move(it, { type: "check_in", quantity: l.qty, qty_before: before, qty_after: it.current_qty, value, supplier: a.p.supplier, invoice_number: a.p.invoice_number,
        original_currency: a.p.currency, original_unit_cost: l.original_unit_cost, unit_cost: paid, unit_cost_after: it.unit_cost, is_new_item: !!l.new_item, document_hash: a.p.document_hash, document_name: a.p.document_name });
    }
    return ok({ lines: a.p.lines.length, new_items: created, total_value: Math.round(total * 100) / 100 });
  }
  if (name === "renson_adjust") {
    if (!access) return { status: 403, body: { message: "renson_not_allowed", code: "42501" } };
    db.lastAdjust = a.p;
    const it = db.items.find((i) => i.item_code === a.p.item_code);
    const before = it.current_qty, d = a.p.mode === "set_to" ? a.p.qty - before : a.p.mode === "add" ? a.p.qty : -a.p.qty;
    if (d === 0) return err("no_change");
    it.current_qty = before + d; it.current_value = Math.round(it.current_qty * (it.unit_cost || 0) * 100) / 100;
    move(it, { type: "adjustment", quantity: d, qty_before: before, qty_after: it.current_qty, value: d * (it.unit_cost || 0), reference: "Stock count", reason: a.p.reason });
    return ok({ item_code: it.item_code, qty_before: before, qty_after: it.current_qty, change: d });
  }
  if (name === "renson_set_levels") {
    if (!access) return { status: 403, body: { message: "renson_not_allowed", code: "42501" } };
    db.lastLevels = a;
    const it = db.items.find((i) => i.item_code === a.p_item_code);
    it.buffer_level = a.p_trigger; it.critical_level = a.p_critical;
    return ok({ trigger: a.p_trigger, critical: a.p_critical });
  }
  if (name === "renson_reset_pilot") { const n = db.items.length; db.items = []; db.imports = []; return ok({ items_removed: n }); }
  return ok(null);
}

async function session(browser, role) {
  const admin = role === "admin";
  const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [], requests = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|websocket/i.test(m.text())) errors.push(m.text()); });
  p.on("dialog", (d) => d.type() === "confirm" ? d.accept() : d.dismiss());
  await p.routeWebSocket(/realtime/, () => {});
  await p.route("https://app.local/**", (route) => {
    let f = new URL(route.request().url()).pathname; if (f === "/") f = "/index.html";
    requests.push({ method: "GET", url: f });
    const full = path.join(repo, decodeURIComponent(f));
    if (!full.startsWith(repo) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".css": "text/css", ".json": "application/json" };
    route.fulfill({ status: 200, contentType: types[path.extname(full)] || "application/octet-stream", body: fs.readFileSync(full) });
  });
  await p.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = route.request().url();
    const fx = url.match(/currency-api@[^/]+\/v1\/currencies\/(\w+)\.json/);
    if (fx) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date: "2026-11-01", [fx[1]]: { aed: 4 } }) });
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
    requests.push({ method: req.method(), url: u.pathname + u.search, role });
    if (u.pathname.startsWith("/functions/v1/checkout")) {
      const type = req.headers()["content-type"] || "";
      const body = /multipart/.test(type) ? JSON.parse((await new Response(req.postDataBuffer(), { headers: { "content-type": type } }).formData()).get("payload")) : JSON.parse(req.postData() || "{}");
      db.freedomCheckouts.push(body); db.freedomCheckoutAt = Date.now() + Math.random();
      return send(200, { ok: true, lines: body.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })), document: { saved: true } });
    }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}"), admin); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: admin ? "Admin Test" : "Staff Test", role: admin ? "admin" : "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "renson_items") return send(200, admin && db.flag ? db.items : []);
    if (table === "inventory_items") return send(200, [{ id: "f-910010", item_code: "910010", description: "Patio Mesh 3.2m (30M)", current_qty: 1227.14, unit_cost: 12, current_value: 14725.68, status: "active", bar_length_mm: null }]);
    if (table === "renson_imports") return send(200, admin && db.flag ? db.imports : []);
    if (table === "renson_transactions") {
      const eq = (k) => (u.searchParams.get(k) || "").replace(/^eq\./, "");
      const itemId = eq("item_id"), type = eq("type"), hash = eq("document_hash"), notType = (u.searchParams.get("type") || "").startsWith("neq.") ? u.searchParams.get("type").slice(4) : "";
      const rows = (db.moves || []).filter((m) => (!itemId || String(m.item_id) === itemId) && (!type || notType || m.type === type) && (!notType || m.type !== notType) && (!hash || m.document_hash === hash));
      return send(200, admin && db.flag ? rows : []);
    }
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 });
  await p.waitForTimeout(1500);
  return { p, errors, requests };
}

const fail = [];
const check = (ok, t) => { console.log((ok ? "ok  " : "FAIL") + " · " + t); if (!ok) fail.push(t); };
const isRenson = (r) => /renson|feature_flag/i.test(r.url);
// Anything that is not a plain read, outside the Renson pilot = a Freedom write.
// The Freedom Check-out call (and the Delivery Notes it prepares afterwards,
// as for every Freedom Check-out) are checked on their own.
const freedomWrites = (reqs) => reqs.filter((r) => r.role && r.method !== "GET" && !/^\/rest\/v1\/rpc\/renson_/.test(r.url) && !/\/auth\//.test(r.url)
  && !/^\/functions\/v1\/checkout/.test(r.url) && !/^\/rest\/v1\/rpc\/prepare_delivery_notes/.test(r.url));

(async () => {
  const browser = await chromium.launch();

  // 1. Regular user
  {
    const { p, errors, requests } = await session(browser, "user");
    check(!requests.some((r) => /renson\.js/.test(r.url)), "regular user: renson.js not loaded");
    check(!(await p.$("#rnInventory")) && !(await p.$("#rnBody")) && !(await p.$("nav .rn-sub")), "regular user: no dropdown, no Renson box, no sidebar submenu");
    check(!requests.some(isRenson), "regular user: no Renson request at all");
    await p.evaluate(() => { sessionStorage.setItem("oryx_view", "master-inventory"); sessionStorage.setItem("oryx_mi_inventory", "renson"); });
    await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(1500);
    check(await p.isVisible("#miSearch") && !(await p.$("#rnBody")), "regular user with a stored 'renson' choice: Freedom list only");
    if (jobPdf) {
      await p.click('nav button[data-v="fp"]'); await p.waitForTimeout(300);
      await p.setInputFiles("#fpPdf", jobPdf); await p.click("#fpExtract");
      await p.waitForFunction(() => /Renson job list/.test(document.querySelector("#fpStatus").textContent), null, { timeout: 60000 });
      check(!(await p.$("#fpOut table")) && await p.isHidden("#fpConfirmBar") && !db.freedomCheckouts.length, "regular user: Renson job list refused on the shared Check-out, nothing taken off");
    }
    if (rensonDocs.length) {
      await p.click('nav button[data-v="checkin"]'); await p.waitForTimeout(300);
      await p.setInputFiles("#ciPdf", rensonDocs[0].file); await p.click("#ciExtract");
      await p.waitForFunction(() => /Renson document/.test(document.querySelector("#ciStatus").textContent), null, { timeout: 60000 });
      check(!(await p.$("#ciOut table")) && !(await p.$("#ciRenson .card")) && await p.isHidden("#ciConfirmBar"), "regular user: Renson document refused on the shared Check-in, nothing changed");
    }
    await p.click("#navActivity"); await p.waitForTimeout(800);
    check(!/Renson/i.test(await p.innerText("#v-activity")) && !requests.some(isRenson), "regular user: Activity has no Renson entries and asks for none");
    check(!freedomWrites(requests).length && !requests.some((r) => /functions\/v1\/check(out|in)/.test(r.url)), "regular user: no writes " + JSON.stringify(freedomWrites(requests)));
    check(!errors.length, "regular user: no page errors " + errors.join(" | "));
    await p.close();
  }

  // 2. Admin, pilot flag ON
  {
    const { p, errors, requests } = await session(browser, "admin");
    check((await p.evaluate(() => document.querySelector(".view.on").id)) === "v-dashboard", "admin: first page still the Freedom Dashboard");
    await p.click('nav button[data-v="master-inventory"]'); await p.waitForTimeout(800);
    check(await p.isVisible("#rnInventory"), "admin: Inventory dropdown shown in Master Inventory");
    check((await p.inputValue("#rnInventory")) === "freedom" && await p.isVisible("#miSearch") && await p.isVisible("#miExtractBtn"), "admin: starts on Freedom, Freedom list as usual");
    await p.selectOption("#rnInventory", "renson"); await p.waitForTimeout(800);
    check(await p.isVisible("#rnBody") && !(await p.isVisible("#miSearch")) && !(await p.isVisible("#miExtractBtn")), "admin: Renson shown in Master Inventory, Freedom list hidden");
    check(/Choose the Renson stock Excel/.test(await p.innerText("#rnBody")) && !!(await p.$("#rnFile")), "admin: empty pilot opens on the import step");
    await p.setInputFiles("#rnFile", xlsx);
    await p.waitForSelector('[data-rn-act="confirm"]', { timeout: 30000 });
    const review = await p.innerText("#rnBody");
    check(/Items found\s*100/.test(review) && /41 with stock/.test(review), "review: 100 items, 41 with stock");
    check(/AED 161,171\.60/.test(review) && /✓ matches/.test(review), "review: AED 161,171.60 and matches the file's INVENTORY VALUE");
    check(/17710: Has stock but no unit cost/.test(review), "review: warns about the Blue tape (stock, no cost)");
    check(/stock counted 2026-10-27/.test(review), "review: stock date 2026-10-27");
    if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-review.png"), fullPage: false });
    await p.click('[data-rn-act="confirm"]');
    await p.waitForSelector("#rnSearch", { timeout: 30000 });
    check(db.lastPayload && db.lastPayload.items.length === 100 && /^[0-9a-f]{64}$/.test(db.lastPayload.file_hash), "import sent 100 items and the file's SHA-256");
    check(db.lastPayload.items.every((i) => !("value" in i)) && db.lastPayload.items.find((i) => i.item_code === "2405").alt_codes === "P6028425", "payload: no client-side value, alt codes kept");
    const inv = await p.innerText("#rnBody");
    check(/Imported 100 items \(41 with stock\), stock value AED 161,171\.60/.test(inv), "done message");
    check(/Total stock value\s*AED 161,171\.60/.test(inv), "inventory: total stock value AED 161,171.60");
    await p.fill("#rnSearch", "somfy"); await p.waitForTimeout(300);
    check(/4 of 100 items/.test(await p.innerText("#rnBody")), "search: 4 Somfy items");
    await p.fill("#rnSearch", ""); await p.waitForTimeout(200);
    // Show filter + Extract
    await p.selectOption("#rnShow", "out"); await p.waitForTimeout(200);
    check(/59 of 100 items/.test(await p.innerText("#rnBody")), "Show: Out of stock = 59 items");
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click('[data-rn-act="extract"]')]);
    const X = require(path.join(nm, "xlsx-js-style"));
    const xf = path.join(require("os").tmpdir(), "rn-extract.xlsx"); await dl.saveAs(xf);
    const xrows = X.utils.sheet_to_json(X.readFile(xf).Sheets["Renson inventory"]);
    check(/^Renson inventory \d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.suggestedFilename()) && xrows.length === 59 && xrows.every((r) => r.Status === "Out of stock" || r.Stock <= 0), "Extract: the 59 rows shown, with status");
    await p.selectOption("#rnShow", "all"); await p.waitForTimeout(200);
    // Sidebar submenu
    await p.click('nav button[data-v="dashboard"]'); await p.waitForTimeout(400);
    check(await p.isVisible('nav .rn-sub [data-rn-mode="renson"]') && await p.isVisible('nav .rn-sub [data-rn-mode="freedom"]'), "sidebar: Freedom / Renson submenu under Master Inventory");
    await p.click('nav .rn-sub [data-rn-mode="renson"]'); await p.waitForTimeout(600);
    check((await p.evaluate(() => document.querySelector(".view.on").id)) === "v-master-inventory" && await p.isVisible("#rnSearch")
      && (await p.getAttribute('nav .rn-sub [data-rn-mode="renson"]', "class")).includes("rn-sub-on"), "sidebar: Renson opens Master Inventory on Renson, highlighted");
    // Item panel: Adjust + Kanban levels
    await p.click('tr[data-rn-item] >> text="22874"'); await p.waitForSelector("#rnItemDlg[open]");
    check(/Bar Ø 18 mm/.test(await p.innerText("#rnItemBody")), "item panel opens for 22874");
    await p.fill("#rnAdjQty", "12"); await p.fill("#rnAdjReason", "Stock count 2 Nov");
    check(/Stock 14 → 12 \(-2\)/.test(await p.innerText("#rnAdjPreview")), "adjust preview: 14 -> 12");
    await p.click('[data-rn-dlg="adjust"]'); await p.waitForTimeout(800);
    check(db.lastAdjust && db.lastAdjust.item_code === "22874" && db.lastAdjust.mode === "set_to" && db.lastAdjust.qty === 12 && db.lastAdjust.reason === "Stock count 2 Nov", "adjust: stock count sent with the reason");
    check(/Saved: stock 14 → 12/.test(await p.innerText("#rnItemBody")) && /Adjustment/.test(await p.innerText("#rnItemBody")), "adjust: saved, shown in the item history");
    await p.fill("#rnLvT", "10"); await p.fill("#rnLvC", "10");
    await p.click('[data-rn-dlg="levels"]'); await p.waitForTimeout(300);
    check(/critical level must be below/.test(await p.innerText("#rnItemBody")) && !db.lastLevels, "levels: critical >= trigger refused before sending (Freedom's rule)");
    await p.fill("#rnLvT", "15"); await p.fill("#rnLvC", "5");
    await p.click('[data-rn-dlg="levels"]'); await p.waitForTimeout(800);
    check(db.lastLevels && db.lastLevels.p_trigger === 15 && db.lastLevels.p_critical === 5, "levels: 15 / 5 saved");
    await p.click('[data-rn-dlg="close"]'); await p.waitForTimeout(300);
    check(/Low stock/.test(await p.innerText('tr[data-rn-item="2"]')) || /Low stock/.test(await p.innerText("#rnBody")), "list: 22874 (12 <= 15) shows Low stock");
    check(!(await p.$('[data-rn-tab="checkin"]')) && !(await p.$('[data-rn-tab="checkout"]')), "old Renson Check-in / Check-out tabs removed");
    if (shot) await p.screenshot({ path: shot, fullPage: false });
    await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(2000);
    check((await p.evaluate(() => document.querySelector(".view.on").id)) === "v-master-inventory" && (await p.inputValue("#rnInventory")) === "renson" && await p.isVisible("#rnSearch"), "reload keeps Master Inventory on Renson");
    check(!(await p.$(".rn-tabs")) && !(await p.$("[data-rn-tab]")) && !(await p.$("#rnFile")) && !/Movements/.test(await p.innerText("#rnBody")),
      "no Inventory / Movements / Import tabs once the opening stock exists");
    await p.selectOption("#rnInventory", "freedom"); await p.waitForTimeout(500);
    check(await p.isVisible("#miSearch") && await p.isVisible("#miExtractBtn") && !(await p.isVisible("#rnBody")), "back to Freedom: Freedom list again");
    check(/Freedom stock\./.test(await p.innerText("#v-master-inventory .page-head p")), "Freedom subtitle restored");
    if (jobPdf) {
      // ONE Check-out page for every stock category: the real Renson job
      // list 24222R. Renson lines -> Renson stock; 910010 Patio Mesh (a
      // Freedom item) -> Freedom stock; Box Sections stay Freedom rows to
      // Acknowledge, as Freedom handles them.
      await p.click('nav button[data-v="fp"]'); await p.waitForTimeout(400);
      await p.setInputFiles("#fpPdf", jobPdf);
      await p.click("#fpExtract");
      await p.waitForSelector("#fpRenson table", { timeout: 60000 });
      const fr = await p.innerText("#fpOut"), rn = await p.innerText("#fpRenson");
      check(/910010/.test(fr) && !/\b11583\b|\b1118\b|\b2405\b/.test(fr), "one check-out: Freedom part has 910010, no Renson codes");
      check(/Renson value taken off \(35 of 35 lines\)\s*AED 10,664\.86/.test(rn) && /= 12 bars \(Pair\)/.test(rn) && /42\.9 m ÷ 6 m = 8 bars/.test(rn), "one check-out: Renson box has the 35 lines, AED 10,664.86, Pair and metre rules");
      check(!/Fixed profile head box Square - 100/.test(fr) && /Box Section 40x60/.test(fr), "one check-out: Renson bars moved out of the Freedom rows; Box Sections stay Freedom");
      check(!/already checked out/.test(rn), "one check-out: first upload shows no 'already checked out' warning");
      if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-checkout.png"), fullPage: true });
      await p.uncheck('#fpRenson [data-rn-take="714"]'); await p.waitForTimeout(300);
      check(/34 of 35 lines/.test(await p.innerText("#fpRenson")), "one check-out: unticking a Renson line leaves it out");
      for (let k = 0; k < 40; k++) { const b2 = p.locator('#fpOut button[data-act="skip"]:not(.on):text-is("Acknowledge")').first(); if (!(await b2.count())) break; await b2.click(); await p.waitForTimeout(40); }
      if (!(await p.inputValue("#fpClient"))) await p.fill("#fpClient", "Paolo Rusolen");
      check(/\+ 34 Renson items/.test(await p.innerText("#fpConfirmSummary")), "confirm bar counts the Renson items");
      await p.click("#fpConfirm");
      await p.waitForSelector("#fpDone .fp-done", { timeout: 30000 });
      const fc = db.freedomCheckouts[db.freedomCheckouts.length - 1], sent = db.lastCheckout;
      check(fc && fc.lines.length === 1 && fc.lines[0].item_id === "f-910010" && fc.job_number === "24222R", "Freedom part: only 910010 sent to the Freedom Check-out");
      check(sent && sent.job_number === "24222R" && sent.lines.length === 34 && !sent.lines.some((l) => l.item_code === "714" || l.item_code === "910010")
        && sent.lines.find((l) => l.item_code === "11583").qty === 12 && sent.lines.find((l) => l.item_code === "2450").qty === 8 && /^[0-9a-f]{64}$/.test(sent.document_hash), "Renson part: 34 lines to Renson stock, 11583 = 12, 2450 = 8, with the PDF fingerprint");
      check(db.freedomCheckoutAt < db.rensonCheckoutAt, "Freedom part saved first, then Renson");
      const done = await p.innerText("#fpDone");
      check(/Check-out confirmed — 1 item deducted/.test(done) && /Renson: 34 Renson items taken off the Renson stock/.test(done), "done message: both parts");
      check(db.items.find((i) => i.item_code === "11583").current_qty === -4, "renson stock: 11583 8 -> -4");
      // Same job list again: Renson box warns
      await p.click("#fpNew");
      await p.setInputFiles("#fpPdf", jobPdf); await p.click("#fpExtract");
      await p.waitForSelector("#fpRenson table", { timeout: 60000 });
      check(/already checked out/.test(await p.innerText("#fpRenson")), "same job list again: Renson box warns");
      await p.click("#fpNew").catch(() => {});
      check(!(await p.$('[data-rn-tab="checkout"]')), "old Renson Check-out tab removed");
    }
    if (rensonDocs.length) {
      // ONE Check-in page: Renson NV documents go to the Renson stock.
      // SUP_1 (16 pages, 58 lines, Pickup Fee, a new item 20315, rolls without
      // a stated length) and SUP_03 (48 lines, cartons and rolls).
      for (const doc of rensonDocs) {
        await p.click('nav button[data-v="checkin"]'); await p.waitForTimeout(300);
        await p.setInputFiles("#ciPdf", doc.file); await p.click("#ciExtract");
        await p.waitForSelector("#ciRenson .card", { timeout: 60000 });
        await p.waitForTimeout(600);
        const box = await p.innerText("#ciRenson"), st = await p.innerText("#ciStatus");
        check(!(await p.$("#ciOut table")) && await p.isHidden("#ciConfirmBar"), doc.name + ": Freedom preview not used");
        check(/✓ The lines add up to the document's total before VAT/.test(box), doc.name + ": lines add up to the document total");
        check(new RegExp("Renson document read — " + doc.lines + " lines").test(st), doc.name + ": " + doc.lines + " lines read (" + st.slice(0, 90) + ")");
        check((await p.inputValue("#rciRate")) === "4", doc.name + ": EUR rate fetched for the document date");
        for (const [code, want] of Object.entries(doc.expect)) {
          const i = await p.evaluate((c) => { const td = [...document.querySelectorAll("#ciRenson td.mono")].find((x) => x.textContent === c); return td ? td.parentElement.querySelector("[data-rci=qty]").value : null; }, code);
          check(i === want, `${doc.name}: ${code} quantity for stock = ${want} (${i})`);
        }
        // fill what the document doesn't say
        for (const code of doc.ask) {
          await p.evaluate((c) => { const td = [...document.querySelectorAll("#ciRenson td.mono")].find((x) => x.textContent === c); const inp = td.parentElement.querySelector("[data-rci=qty]"); inp.value = "100"; inp.dispatchEvent(new Event("input", { bubbles: true })); }, code);
        }
        if (shot) await p.screenshot({ path: shot.replace(/\.png$/, `-checkin-${doc.name}.png`), fullPage: false });
        await p.waitForTimeout(200);
        check(await p.isEnabled("#rciConfirm"), doc.name + ": Confirm ready once the asked quantities are typed");
        await p.click("#rciConfirm");
        await p.waitForSelector("#ciRenson .fp-done", { timeout: 30000 });
        const ci = db.lastCheckin;
        check(ci && ci.currency === "EUR" && ci.exchange_rate === 4 && ci.supplier === "Renson NV" && ci.invoice_number === doc.number && /^[0-9a-f]{64}$/.test(ci.document_hash) && ci.lines.length === doc.lines,
          doc.name + ": sent to renson_checkin (EUR, rate, document number, fingerprint, all lines)");
        check(doc.check(ci), doc.name + ": " + doc.checkText);
        check(/Renson Check-in confirmed/.test(await p.innerText("#ciRenson")), doc.name + ": done message");
      }
      await p.click('nav .rn-sub [data-rn-mode="renson"]'); await p.waitForTimeout(800);
    }
    // Renson movements are on the Activity page (Movements tab removed).
    await p.click("#navActivity"); await p.waitForTimeout(1200);
    const act = await p.innerText("#actList");
    if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-activity.png"), fullPage: false });
    check(/Renson adjustment/i.test(act) && /stock count · 22874/.test(act), "Activity: Renson adjustment listed");
    if (jobPdf) check(/Renson check-out[\s\S]*checked out 34 items/i.test(act), "Activity: Renson check-out listed (34 ticked items)");
    if (rensonDocs.length) check((act.match(/Renson check-in/gi) || []).length === rensonDocs.length, "Activity: one Renson check-in per document");
    check(!/Opening stock|opening_import/.test(act), "Activity: opening import not listed");
    await p.click('#actTypes [data-type="adj"]'); await p.waitForTimeout(300);
    check(/Renson adjustment/i.test(await p.innerText("#actList")), "Activity: Adjustments filter includes Renson");
    await p.click('#actTypes [data-type=""]');
    check(!freedomWrites(requests).length, "admin: no write to any Freedom table or function " + JSON.stringify(freedomWrites(requests)));
    check(!errors.length, "admin: no page errors " + errors.join(" | "));
    await p.close();
  }

  // 3. Admin, pilot flag OFF
  {
    db.flag = false;
    const { p, errors } = await session(browser, "admin");
    check(!(await p.$("#rnInventory")) && !(await p.$("#rnBody")), "flag off: Admin sees no dropdown, no Renson box");
    check(!(await p.$("#navAdmin[hidden]")) && (await p.isVisible('nav button[data-v="master-inventory"]')), "flag off: Freedom menu as usual");
    check(!errors.length, "flag off: no page errors " + errors.join(" | "));
    await p.close();
  }

  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
  process.exit(fail.length ? 1 : 0);
})();
