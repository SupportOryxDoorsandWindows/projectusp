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
if (!xlsx || !nm) { console.error("usage: --xlsx <file> --node-modules <folder> [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};

// Stand-in for supabase/sql/renson_pilot.sql
const db = { items: [], imports: [], flag: true, calls: [] };
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
    db.lastCheckout = a.p; db.moves = db.moves || [];
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
        original_currency: a.p.currency, original_unit_cost: l.original_unit_cost, unit_cost: paid, unit_cost_after: it.unit_cost, is_new_item: !!l.new_item });
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
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}"), admin); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: admin ? "Admin Test" : "Staff Test", role: admin ? "admin" : "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "renson_items") return send(200, admin && db.flag ? db.items : []);
    if (table === "renson_imports") return send(200, admin && db.flag ? db.imports : []);
    if (table === "renson_transactions") {
      const itemId = (u.searchParams.get("item_id") || "").replace(/^eq\./, "");
      const rows = (db.moves || []).filter((m) => !itemId || String(m.item_id) === itemId);
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
const freedomWrites = (reqs) => reqs.filter((r) => r.role && r.method !== "GET" && !/^\/rest\/v1\/rpc\/renson_/.test(r.url) && !/\/auth\//.test(r.url));

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
    check(!freedomWrites(requests).length, "regular user: no writes " + JSON.stringify(freedomWrites(requests)));
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
    check(/Import stock file/.test(await p.innerText("#rnBody")) && !!(await p.$("#rnFile")), "admin: empty pilot opens on the import step");
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
    // Check-in: EUR with the rate fetched, shipping, a new item
    await p.click('[data-rn-tab="checkin"]');
    await p.waitForTimeout(800);
    check((await p.inputValue("#rnInRate")) === "4", "check-in: EUR rate fetched (4)");
    await p.fill("#rnInInvoice", "RN-INV-1"); await p.fill("#rnInShip", "40");
    await p.fill('[data-rn-in="item_code"][data-i="0"]', "22874"); await p.press('[data-rn-in="item_code"][data-i="0"]', "Tab");
    await p.fill('[data-rn-in="qty"][data-i="0"]', "10"); await p.press('[data-rn-in="qty"][data-i="0"]', "Tab");
    await p.fill('[data-rn-in="price"][data-i="0"]', "40"); await p.press('[data-rn-in="price"][data-i="0"]', "Tab");
    await p.click('[data-rn-act="in-add"]');
    await p.fill('[data-rn-in="item_code"][data-i="1"]', "NEW-9"); await p.press('[data-rn-in="item_code"][data-i="1"]', "Tab");
    check(/New item/.test(await p.innerText("#rnBody")) && await p.isDisabled('[data-rn-act="in-confirm"]'), "check-in: unknown code = New item, Confirm waits for its details");
    await p.fill('[data-rn-in="desc"][data-i="1"]', "Test new part"); await p.fill('[data-rn-in="unit"][data-i="1"]', "pc");
    await p.fill('[data-rn-in="qty"][data-i="1"]', "3"); await p.fill('[data-rn-in="price"][data-i="1"]', "10"); await p.press('[data-rn-in="price"][data-i="1"]', "Tab");
    const cin = await p.innerText("#rnBody");
    // shipping 40 / 2 lines = 20 each: 22874 (40 + 20/10) x 4 = 168; average (12 x 153 + 10 x 168) / 22 = 159.82
    check(/AED 168\.00/.test(cin) && /AED 159\.82/.test(cin), "check-in preview: price paid AED 168, average AED 159.82 (Freedom's rule)");
    if (shot) { await p.evaluate(() => document.querySelectorAll(".rn-wrap").forEach((w) => { w.scrollLeft = 0; })); await p.screenshot({ path: shot.replace(/\.png$/, "-checkin.png"), fullPage: false }); }
    await p.click('[data-rn-act="in-confirm"]'); await p.waitForSelector('[data-rn-tab="moves"].on', { timeout: 30000 });
    const ci = db.lastCheckin;
    check(ci && ci.currency === "EUR" && ci.exchange_rate === 4 && ci.invoice_number === "RN-INV-1" && ci.lines.length === 2
      && ci.lines[0].shipping_allocated === 20 && ci.lines[1].new_item && ci.lines[1].new_item.description === "Test new part", "check-in: sent with currency, rate, shipping share and the new item");
    check(/Checked in 2 lines \(1 new item\)/.test(await p.innerText("#rnBody")), "check-in: done message");
    // Check-out typed by hand
    await p.click('[data-rn-tab="checkout"]'); await p.click('[data-rn-act="out-manual"]');
    await p.fill("#rnOutJob", "J-HAND");
    await p.fill('[data-rn-out="item_code"][data-i="0"]', "2390"); await p.fill('[data-rn-out="qty"][data-i="0"]', "2"); await p.press('[data-rn-out="qty"][data-i="0"]', "Tab");
    await p.click('[data-rn-act="out-confirm-manual"]'); await p.waitForSelector('[data-rn-tab="moves"].on', { timeout: 30000 });
    check(db.lastCheckout && db.lastCheckout.job_number === "J-HAND" && !db.lastCheckout.document_hash && db.lastCheckout.lines[0].item_code === "2390" && db.lastCheckout.lines[0].qty === 2, "manual check-out: sent without a document");
    if (shot) await p.screenshot({ path: shot, fullPage: false });
    await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(2000);
    check((await p.evaluate(() => document.querySelector(".view.on").id)) === "v-master-inventory" && (await p.inputValue("#rnInventory")) === "renson" && await p.isVisible("#rnSearch"), "reload keeps Master Inventory on Renson");
    await p.click('[data-rn-tab="import"]');
    check(await p.isDisabled("#rnFile"), "second import blocked while the opening stock exists");
    await p.selectOption("#rnInventory", "freedom"); await p.waitForTimeout(500);
    check(await p.isVisible("#miSearch") && await p.isVisible("#miExtractBtn") && !(await p.isVisible("#rnBody")), "back to Freedom: Freedom list again");
    check(/Freedom stock\./.test(await p.innerText("#v-master-inventory .page-head p")), "Freedom subtitle restored");
    if (jobPdf) {
      // Renson Check-out from the real job list (24222R)
      await p.selectOption("#rnInventory", "renson"); await p.waitForTimeout(800);
      await p.click('[data-rn-tab="checkout"]');
      await p.setInputFiles("#rnOutFile", jobPdf);
      await p.waitForSelector('[data-rn-act="out-confirm"]', { timeout: 60000 });
      const prev = await p.innerText("#rnBody");
      check((await p.inputValue("#rnOutJob")) === "24222R", "check-out: job number 24222R read from the job list");
      check(/Lines to take off\s*35/.test(prev) && /Left out\s*8/.test(prev), "check-out: 35 lines to take off, 8 left out");
      check(/AED 10,664\.86/.test(prev), "check-out: value AED 10,664.86");
      check(/910010[\s\S]*Not a Renson item/.test(prev) && /Box Section 40x60[\s\S]*Box Section: not a Renson item/.test(prev), "check-out: 910010 and Box Sections left out with the reason");
      check(/= 12 bars \(Pair\)/.test(prev) && /42\.9 m ÷ 6 m = 8 bars/.test(prev), "check-out: Pair = 2 bars, 2450 metres to bars shown");
      check(/Below zero, allowed/.test(prev), "check-out: below-zero lines marked");
      if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-checkout.png"), fullPage: false });
      await p.uncheck('[data-rn-take="714"]'); await p.waitForTimeout(200);
      check(/Lines to take off\s*34/.test(await p.innerText("#rnBody")), "check-out: unticking a line leaves it out");
      await p.click('[data-rn-act="out-confirm"]');
      await p.waitForSelector('[data-rn-tab="moves"].on', { timeout: 30000 });
      const sent = db.lastCheckout;
      check(sent && sent.job_number === "24222R" && sent.lines.length === 34 && !sent.lines.some((l) => l.item_code === "714" || l.item_code === "910010"), "check-out: 34 Renson lines sent, no 714 / 910010");
      check(/^[0-9a-f]{64}$/.test(sent.document_hash) && sent.lines.find((l) => l.item_code === "11583").qty === 12 && sent.lines.find((l) => l.item_code === "2450").qty === 8, "check-out: PDF fingerprint, 11583 = 12 bars, 2450 = 8 bars");
      const mv = await p.innerText("#rnBody");
      check(/Checked out job 24222R: 34 lines/.test(mv) && /24222R/.test(mv) && /11583/.test(mv), "movements: the Check-out is listed");
      await p.click('[data-rn-tab="inventory"]');
      check(db.items.find((i) => i.item_code === "11583").current_qty === -4, "renson stock: 11583 8 -> -4");
      // same job list again: warned, and the server refuses
      await p.click('[data-rn-tab="checkout"]');
      await p.setInputFiles("#rnOutFile", jobPdf);
      await p.waitForSelector('[data-rn-act="out-confirm"]', { timeout: 60000 });
      check(/already checked out/.test(await p.innerText("#rnBody")), "same job list again: warned");
      await p.click('[data-rn-act="out-confirm"]'); await p.waitForTimeout(800);
      check(/already checked out\. Nothing was saved/.test(await p.innerText("#rnBody")), "same job list again: refused, nothing saved");
      await p.selectOption("#rnInventory", "freedom"); await p.waitForTimeout(300);
    }
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
