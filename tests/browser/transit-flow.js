// Materials in Transit (transit.js, 2026-11-05) against a STAND-IN backend
// (never the live project). A regular staff user:
//  - menu order; empty page; + New PO typed by hand (a code with two bar
//    lengths must be chosen, a code not in Master is kept as text), USD rate
//    fetched for the PO date; cards + supplier breakdown + filters;
//  - Excel import with two POs (one already there -> left out, the other
//    saved after the preview);
//  - Receive from Transit: more than pending refused, then 4,000 of 10,000
//    -> Check-in page with a banner -> Check-in typed by hand + Confirm ->
//    the PO is updated with THAT Check-in's own stock lines (status
//    Partially received), banner gone;
//  - a Check-in whose PO number is an open PO offers "Update the PO";
//  - PO detail: delivery history, edit expected date / payment; no Admin box;
//  - the Freedom Check-in call itself carries nothing from transit, and the
//    only stock write is that Check-in call.
//   node tests/browser/transit-flow.js --node-modules <dir with @supabase/supabase-js@2.45.4,
//        xlsx-js-style@1.2.0, pdfjs-dist@4.7.76> [--docs <dir with the 4 PO / quote PDFs>] [--shot <png>]
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const nm = opt("--node-modules"), shot = opt("--shot"), docs = opt("--docs");
if (!nm) { console.error("usage: --node-modules <dir> [--docs <dir>] [--shot <png>]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};
const ITEMS = [
  { id: "f-310028-2500", item_code: "310028", description: "ZLS1 Track 01 MILL", bar_length_mm: 2500, current_qty: 10, unit_cost: 30, current_value: 300, status: "active", unit_of_measure: "pcs" },
  { id: "f-310028-5100", item_code: "310028", description: "ZLS1 Track 01 MILL", bar_length_mm: 5100, current_qty: 20, unit_cost: 150, current_value: 3000, status: "active", unit_of_measure: "pcs" },
  { id: "f-134002", item_code: "134002", description: "Brake Rod 1.5m", bar_length_mm: null, current_qty: 5, unit_cost: 9, current_value: 45, status: "active", unit_of_measure: "pcs" },
];

// Stand-in for supabase/sql/materials_in_transit.sql (its rules are tested
// on Postgres; here only what the page sends and shows matters).
const db = { orders: [], lines: [], receipts: [], rlines: [], docs: [], log: [], tx: [], checkins: [], calls: [] };
const now = () => new Date().toISOString();
function rpc(name, a, user, admin) {
  const ok = (b) => ({ status: 200, body: b }), err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  db.calls.push({ name, a });
  if (name === "renson_access") return ok(true);
  if (name === "transit_create_order") {
    const p = a.p;
    if (db.orders.some((o) => o.po_number.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === p.po_number.replace(/[^A-Za-z0-9]/g, "").toUpperCase())) return err("duplicate_po");
    const id = db.orders.length + 1;
    db.orders.push({ id, po_number: p.po_number, supplier: p.supplier, supplier_group: p.supplier_group, inventory: p.inventory, po_date: p.po_date, quote_ref: p.quote_ref || null,
      currency: p.currency, rate_to_aed: p.rate_to_aed, expected_delivery: p.expected_delivery, payment_status: p.payment_status, delivery_status: p.delivery_status, notes: p.notes || null,
      source: p.source, created_by_name: "Staff Test", created_at: now(), updated_at: now() });
    p.lines.forEach((l, i) => db.lines.push({ id: id * 100 + i + 1, order_id: id, line_no: i + 1, item_code: l.item_code ? l.item_code.toUpperCase() : null, description: l.description,
      freedom_item_id: l.freedom_item_id, renson_item_id: null, unit: l.unit || null, qty_ordered: l.qty_ordered, qty_received: 0, qty_cancelled: 0, qty_pending: l.qty_ordered, unit_price: l.unit_price, updated_at: now() }));
    return ok({ id, lines: p.lines.length });
  }
  if (name === "transit_update_order") {
    const o = db.orders.find((x) => x.id === a.p.id), ch = {};
    for (const k of ["expected_delivery", "payment_status", "delivery_status", "notes", "quote_ref"]) if (k in a.p && (a.p[k] || null) !== (o[k] || null)) { ch[k] = [o[k], a.p[k]]; o[k] = a.p[k] || null; }
    if (Object.keys(ch).length) db.log.push({ id: db.log.length + 1, order_id: o.id, action: "updated", detail: ch, by_name: "Staff Test", created_at: now() });
    return ok({ changed: !!Object.keys(ch).length });
  }
  if (name === "transit_receive") {
    const p = a.p;
    if (db.receipts.some((r) => r.receive_key === p.receive_key)) return ok({ already: true, status: db.orders.find((o) => o.id === p.order_id).delivery_status });
    if (!p.checkin_tx_ids.length || !p.checkin_tx_ids.every((id) => db.tx.some((t) => t.id === id && t.type === "check_in" && t.performed_by === user.id))) return err("checkin_not_found");
    const o = db.orders.find((x) => x.id === p.order_id);
    for (const x of p.lines) { const l = db.lines.find((y) => y.id === x.line_id); if (x.qty > l.qty_pending) return err("more_than_pending: " + l.item_code); }
    const rid = db.receipts.length + 1;
    db.receipts.push({ id: rid, order_id: o.id, receive_key: p.receive_key, delivery_note_no: p.delivery_note_no, delivery_date: p.delivery_date, checkin_kind: p.checkin_kind,
      checkin_tx_ids: p.checkin_tx_ids, checkin_reference: p.checkin_reference, document_name: p.document_name, received_by_name: "Staff Test", created_at: now() });
    for (const x of p.lines) { const l = db.lines.find((y) => y.id === x.line_id); l.qty_received += x.qty; l.qty_pending -= x.qty; db.rlines.push({ receipt_id: rid, line_id: l.id, qty: x.qty }); }
    const ls = db.lines.filter((l) => l.order_id === o.id);
    o.delivery_status = ls.every((l) => l.qty_pending <= 0) ? "completed" : "partially_received"; o.updated_at = now();
    db.log.push({ id: db.log.length + 1, order_id: o.id, action: "received", detail: { lines: p.lines.length, delivery_note_no: p.delivery_note_no }, by_name: "Staff Test", created_at: now() });
    return ok({ already: false, receipt_id: rid, lines: p.lines.length, status: o.delivery_status });
  }
  if (name === "transit_add_document") { db.docs.push({ id: db.docs.length + 1, order_id: a.p_order, kind: a.p_kind, name: a.p_name, path: a.p_path, uploaded_by_name: "Staff Test", created_at: now() }); return ok({ id: db.docs.length, already: false }); }
  if (admin && name === "transit_admin_change") {
    if (!String(a.p.reason || "").trim()) return err("reason_missing");
    for (const c of a.p.changes) if (c.action === "edit") { const l = db.lines.find((y) => y.id === c.line_id); if ("qty_ordered" in c) { l.qty_pending += c.qty_ordered - l.qty_ordered; l.qty_ordered = c.qty_ordered; } }
    return ok({ ok: true, changes: a.p.changes.length });
  }
  if (admin && name === "transit_cancel") {
    for (const l of db.lines.filter((y) => y.order_id === a.p.order_id && (!a.p.line_id || y.id === a.p.line_id))) { const q = "qty" in a.p ? a.p.qty : l.qty_pending; l.qty_cancelled += q; l.qty_pending -= q; }
    return ok({ ok: true, lines: 1, status: "partially_received" });
  }
  if (/^transit_/.test(name)) return { status: 403, body: { message: "admins_only", code: "P0001" } };
  return ok(null);
}
const eqv = (u, k) => { const v = u.searchParams.get(k); return v && v.startsWith("eq.") ? v.slice(3) : null; };

async function session(browser, role = "staff") {
  const admin = role === "admin";
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
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
    const fx = url.match(/currency-api@([^/]+)\/v1\/currencies\/(\w+)\.json/);
    if (fx) { db.rateAsked = fx[1]; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date: fx[1] === "latest" ? "2026-11-05" : fx[1], [fx[2]]: { aed: 3.6725 } }) }); }
    if (!cdn[url]) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(nm, cdn[url])) });
  });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const user = { id: "00000000-0000-0000-0000-00000000000" + (admin ? "1" : "2"), aud: "authenticated", role: "authenticated", email: role + "@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: "staff", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "staff", user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    requests.push({ method: req.method(), url: u.pathname + u.search });
    if (u.pathname.startsWith("/storage/v1/object/transit-documents/")) { db.uploads = (db.uploads || 0) + 1; return send(200, { Key: u.pathname }); }
    if (u.pathname.startsWith("/functions/v1/checkin")) {
      const type = req.headers()["content-type"] || "";
      const body = /multipart/.test(type) ? JSON.parse((await new Response(req.postDataBuffer(), { headers: { "content-type": type } }).formData()).get("payload")) : JSON.parse(req.postData() || "{}");
      db.checkins.push(body);
      const at = new Date(Date.now() + db.checkins.length).toISOString();
      body.lines.forEach((l, i) => db.tx.push({ id: `tx-${db.checkins.length}-${i}`, type: "check_in", item_id: l.item_id, quantity: l.quantity, performed_by: user.id, created_at: at, source_document_hash: body.pdf_hash || null }));
      return send(200, { ok: true, lines: body.lines.map((l) => ({ item_id: l.item_id, added: l.quantity })), document: { saved: true } });
    }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}"), user, admin); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: admin ? "Admin Test" : "Staff Test", role: admin ? "admin" : "user", can_delete: false, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "inventory_items") return send(200, ITEMS);
    if (table === "inventory_transactions") {
      let rows = db.tx.filter((t) => (!eqv(u, "type") || t.type === eqv(u, "type")) && (!eqv(u, "performed_by") || t.performed_by === eqv(u, "performed_by"))
        && (!eqv(u, "source_document_hash") || t.source_document_hash === eqv(u, "source_document_hash")));
      if (/created_at\.desc/.test(u.search)) rows = rows.slice().sort((x, y) => y.created_at.localeCompare(x.created_at));
      return send(200, rows);
    }
    const tables = { transit_orders: db.orders, transit_lines: db.lines, transit_receipts: db.receipts, transit_receipt_lines: db.rlines, transit_documents: db.docs };
    if (tables[table]) return send(200, tables[table]);
    if (table === "transit_log") return send(200, db.log.filter((x) => String(x.order_id) === eqv(u, "order_id")));
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

(async () => {
  const browser = await chromium.launch();
  const { p, errors, requests } = await session(browser);

  // Menu + empty page
  const menu = await p.$$eval('nav.side-nav button[data-v]', (b) => b.map((x) => x.textContent.trim()));
  const ix = (t) => menu.findIndex((m) => m.startsWith(t));
  check(ix("Dashboard") < ix("Master Inventory") && ix("Master Inventory") < ix("Materials in Transit") && ix("Materials in Transit") < ix("Check-in") && ix("Check-in") < ix("Check-out"),
    "menu: Dashboard, Master Inventory, Materials in Transit, Check-in, Check-out (" + menu.slice(0, 6).join(", ") + ")");
  await p.click('nav button[data-v="transit"]'); await p.waitForTimeout(600);
  check(/No purchase orders yet/.test(await p.innerText("#trTable")) && /AED\s*0/.test(await p.innerText("#trCards")), "empty page: no POs, AED 0 in transit");

  // + New PO typed by hand
  await p.click("#trNew"); await p.waitForSelector("#trNewDlg[open]");
  await p.fill("#trNPo", "PO26-2106"); await p.fill("#trNSup", "Freedom Screens Global Co., Ltd"); await p.press("#trNSup", "Tab");
  await p.fill("#trNDate", "2026-09-30"); await p.press("#trNDate", "Tab");
  await p.selectOption("#trNCur", "USD"); await p.waitForTimeout(500);
  check((await p.inputValue("#trNRate")) === "3.6725" && db.rateAsked === "2026-09-30", "USD: rate of the PO date fetched (3.6725)");
  check((await p.inputValue("#trNGroup")) === "Freedom", "supplier group from the name: Freedom");
  const fillLine = async (i, code, desc, unit, qty, price) => {
    await p.fill(`[data-nl="item_code"][data-i="${i}"]`, code); await p.press(`[data-nl="item_code"][data-i="${i}"]`, "Tab"); await p.waitForTimeout(150);
    await p.fill(`[data-nl="description"][data-i="${i}"]`, desc); await p.fill(`[data-nl="unit"][data-i="${i}"]`, unit);
    await p.fill(`[data-nl="qty_ordered"][data-i="${i}"]`, qty); await p.fill(`[data-nl="unit_price"][data-i="${i}"]`, price);
  };
  await fillLine(0, "310028", "Track (Mill, IZLX)", "Units", "10000", "31.50");
  await p.click("[data-tr-add]"); await fillLine(1, "134002", "Brake Rod (1.5m)", "Units", "600", "2.10");
  await p.click("[data-tr-add]"); await fillLine(2, "90001T", "Track Drilling Guide Jig", "Units", "4", "55.50");
  await p.waitForTimeout(200);
  const probs = await p.innerText("#trNProbs");
  check(/Line 1 \(310028\): choose which Master Inventory item \(bar length\)/.test(probs) && await p.isDisabled("[data-tr-save]"), "310028 has two bar lengths: must be chosen, Save locked");
  check(/not in Master/.test(await p.innerText(".tr-lines tbody tr:nth-child(3)")) && /Brake Rod 1\.5m/.test(await p.innerText(".tr-lines tbody tr:nth-child(2)")), "134002 linked (one match), 90001T kept as 'not in Master'");
  await p.selectOption('[data-nl="freedom_item_id"][data-i="0"]', "f-310028-5100"); await p.waitForTimeout(200);
  check(!(await p.innerText("#trNProbs")).trim() && await p.isEnabled("[data-tr-save]"), "bar length chosen: no problems, Save enabled");
  check(/USD 316,482(\.00)?/.test(await p.innerText("#trNSum")), "total USD 316,482.00");
  await p.fill("#trNExp", "2026-12-15");
  await p.click("[data-tr-save]"); await p.waitForTimeout(800);
  const c1 = db.calls.find((c) => c.name === "transit_create_order");
  check(c1 && c1.a.p.rate_to_aed === 3.6725 && c1.a.p.lines[0].freedom_item_id === "f-310028-5100" && c1.a.p.lines[1].freedom_item_id === "f-134002" && c1.a.p.lines[2].freedom_item_id === null
    && c1.a.p.lines[0].qty_ordered === 10000 && c1.a.p.inventory === "freedom", "saved: lines, links, rate, Freedom stock");
  check(/PO PO26-2106 saved \(3 lines\)/.test(await p.innerText("#trStatus")), "done message");
  const cards = await p.innerText("#trCards");
  check(/1,162,280/.test(cards) && /Open purchase orders\s*1/.test(cards), "cards: AED 1,162,280 in transit (316,482 x 3.6725), 1 open PO");

  // Excel import: PO26-2106 again (left out) + PO-FUS-1 (Fusion)
  const X = require(path.join(nm, "xlsx-js-style"));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["PO Number", "Supplier", "Material Code", "Description", "Qty", "Unit", "Unit Price", "Currency", "Expected delivery"],
    ["PO26-2106", "Freedom Screens Global", "134002", "Brake Rod", 1, "Units", 1, "USD", ""],
    ["PO-FUS-1", "Fusion Trading LLC", "FU-1", "Fusion handle", 50, "pcs", 12, "AED", "20/01/2027"],
    ["PO-FUS-1", "Fusion Trading LLC", "FU-2", "Fusion lock", 20, "pcs", 30, "AED", "20/01/2027"]]), "Incoming");
  const xf = path.join(os.tmpdir(), "transit-import.xlsx"); X.writeFile(wb, xf);
  await p.click("#trNew"); await p.waitForSelector("#trNewDlg[open]");
  await p.setInputFiles("#trXls", xf); await p.waitForTimeout(1200);
  const notes = await p.innerText("#trNewDlg");
  check((await p.inputValue("#trNPo")) === "PO-FUS-1" && /Already here, left out: PO26-2106/.test(notes) && (await p.inputValue("#trNGroup")) === "Fusion", "Excel: preview of PO-FUS-1, PO26-2106 left out (already here)");
  await p.click("[data-tr-save]"); await p.waitForTimeout(900);
  const c2 = db.calls.filter((c) => c.name === "transit_create_order")[1];
  check(c2 && c2.a.p.source === "excel" && c2.a.p.lines.length === 2 && c2.a.p.expected_delivery === "2027-01-20" && db.docs.some((d) => d.order_id === 2 && /transit-import/.test(d.name)), "Excel PO saved (2 lines, date read) and the file kept");

  // Supplier breakdown + filters
  await p.click('[data-tr-group="Fusion"]'); await p.waitForTimeout(200);
  check((await p.$$("#trTable tbody tr[data-tr-po]")).length === 2, "supplier card Fusion: only its 2 lines");
  await p.click('[data-tr-group="Fusion"]'); await p.fill("#trSearch", "brake"); await p.waitForTimeout(200);
  check((await p.$$("#trTable tbody tr[data-tr-po]")).length === 1, "search 'brake': 1 line");
  await p.fill("#trSearch", ""); await p.waitForTimeout(150);
  await p.click('[data-tr-sort="qty_pending"]'); await p.click('[data-tr-sort="qty_pending"]'); await p.waitForTimeout(150);
  check(/310028/.test(await p.innerText("#trTable tbody tr:first-child")), "sort by pending (descending): Track first");
  if (shot) await p.screenshot({ path: shot, fullPage: true });

  // Receive from Transit -> Check-in -> PO updated
  await p.click("#trReceive"); await p.waitForSelector("#trRcvDlg[open]");
  await p.selectOption("#trRPo", "1"); await p.waitForTimeout(150);
  const trackLine = db.lines.find((l) => l.order_id === 1 && l.item_code === "310028");
  await p.fill(`[data-rq="${trackLine.id}"]`, "10001"); await p.waitForTimeout(100);
  check(/more than the 10000 still pending/.test(await p.innerText("#trRProbs")) && await p.isDisabled("[data-tr-rgo]"), "receive: more than pending refused in the browser");
  await p.fill(`[data-rq="${trackLine.id}"]`, "4000"); await p.fill("#trRDn", "DN-778"); await p.fill("#trRDate", "2026-11-20"); await p.waitForTimeout(100);
  await p.click("[data-tr-rgo]"); await p.waitForTimeout(600);
  check((await p.evaluate(() => document.querySelector(".view.on").id)) === "v-checkin" && /Receiving PO PO26-2106/.test(await p.innerText("#trCiBanner")) && /310028 × 4,000/.test(await p.innerText("#trCiBanner")),
    "Continue: Check-in page opens with the Receiving banner");
  check(!db.calls.some((c) => c.name === "transit_receive"), "nothing recorded before the Check-in is confirmed");
  await p.click("#ciManualToggle"); await p.waitForSelector("#ciManCodeSearch0");
  await p.waitForFunction(() => !document.querySelector("#ciManualStatus").textContent.trim(), null, { timeout: 15000 }); await p.waitForTimeout(200);
  await p.fill("#ciManCodeSearch0", "310028"); await p.waitForTimeout(300);
  await p.waitForSelector('#ciManCodeResults0 .fp-dropdown-option[data-id="f-310028-5100"]', { timeout: 10000 });
  await p.click('#ciManCodeResults0 .fp-dropdown-option[data-id="f-310028-5100"]');
  await p.fill("#ciManQty0", "4000"); await p.fill("#ciManCost0", "136.69");
  await p.click("#ciManualUse"); await p.waitForTimeout(300);
  await p.fill("#ciSupplier", "Freedom Screens Global Co., Ltd"); await p.fill("#ciInvoiceNumber", "INV-4001"); await p.fill("#ciPoNumber", "PO26-2106"); await p.fill("#ciDocDate", "2026-11-20");
  await p.waitForTimeout(200);
  await p.click("#ciConfirm"); await p.waitForTimeout(1500);
  const ck = db.checkins[0];
  check(ck && ck.lines.length === 1 && ck.lines[0].quantity === 4000 && !JSON.stringify(ck).includes("transit") && !JSON.stringify(ck).includes("DN-778"), "Check-in sent as usual (nothing from transit in it)");
  const rc = db.calls.find((c) => c.name === "transit_receive");
  check(rc && rc.a.p.checkin_tx_ids.join() === "tx-1-0" && rc.a.p.lines[0].qty === 4000 && rc.a.p.delivery_note_no === "DN-778" && rc.a.p.checkin_reference === "INV-4001" && rc.a.p.checkin_kind === "freedom",
    "after Confirm: the PO is updated with that Check-in's own stock line, DN and invoice");
  const done = await p.innerText("#ciDone");
  check(/Check-in confirmed/.test(done) && /PO PO26-2106 updated/.test(done) && /Partially received/i.test(done), "done message: Check-in confirmed + PO updated, Partially received");
  check(!(await p.$("#trCiBanner")), "banner gone");

  // A Check-in whose PO number is an open PO, without Receive -> offer
  await p.click("#ciNew"); await p.waitForTimeout(300);
  await p.click("#ciManualToggle"); await p.waitForSelector("#ciManCodeSearch0");
  await p.waitForFunction(() => !document.querySelector("#ciManualStatus").textContent.trim(), null, { timeout: 15000 }); await p.waitForTimeout(200);
  await p.fill("#ciManCodeSearch0", "134002"); await p.waitForTimeout(300);
  await p.waitForSelector('#ciManCodeResults0 .fp-dropdown-option[data-id="f-134002"]', { timeout: 10000 });
  await p.click('#ciManCodeResults0 .fp-dropdown-option[data-id="f-134002"]');
  await p.fill("#ciManQty0", "600"); await p.click("#ciManualUse"); await p.waitForTimeout(300);
  await p.fill("#ciSupplier", "Freedom Screens Global Co., Ltd"); await p.fill("#ciInvoiceNumber", "INV-4002"); await p.fill("#ciPoNumber", "PO 26-2106");
  await p.click("#ciConfirm"); await p.waitForTimeout(1500);
  check(/is in Materials in Transit with materials outstanding/.test(await p.innerText("#ciDone")) && db.calls.filter((c) => c.name === "transit_receive").length === 1, "PO number matches an open PO: offered, not done by itself");
  await p.click("[data-tr-link]"); await p.waitForSelector("#trRcvDlg[open]");
  check(/Linking the Check-in just confirmed \(INV-4002, 1 stock line\)/.test(await p.innerText("#trRcvDlg")), "link dialog names the Check-in");
  await p.click("[data-tr-fill]"); await p.waitForTimeout(100);
  const brake = db.lines.find((l) => l.order_id === 1 && l.item_code === "134002");
  check((await p.inputValue(`[data-rq="${brake.id}"]`)) === "600", "Everything outstanding arrived: fills 600");
  await p.fill(`[data-rq="${trackLine.id}"]`, ""); await p.fill(`[data-rq="${db.lines.find((l) => l.order_id === 1 && l.item_code === "90001T").id}"]`, "");
  await p.click("[data-tr-rgo]"); await p.waitForTimeout(800);
  const rc2 = db.calls.filter((c) => c.name === "transit_receive")[1];
  check(rc2 && rc2.a.p.checkin_tx_ids.join() === "tx-2-0" && rc2.a.p.lines.length === 1 && rc2.a.p.lines[0].qty === 600, "linked afterwards: Brake Rods 600 with that Check-in's line");

  // PO detail
  await p.click('nav button[data-v="transit"]'); await p.waitForTimeout(600);
  await p.click('#trTable tr[data-tr-po="1"]'); await p.waitForSelector("#trDlg[open]");
  const det = await p.innerText("#trDlg");
  check(/DN-778/.test(det) && /INV-4001/.test(det) && /310028 × 4,000/.test(det) && /134002 × 600/.test(det), "PO detail: delivery history with DN, Check-in and quantities");
  check(/Partially received/i.test(det) && !(await p.$("#trAdm")), "status Partially received; no Admin box for staff");
  await p.fill("#trEExp", "2026-12-20"); await p.selectOption("#trEPay", "partially_paid");
  await p.click("#trEdit button[type=submit]"); await p.waitForTimeout(700);
  const up = db.calls.filter((c) => c.name === "transit_update_order").pop();
  check(up && up.a.p.expected_delivery === "2026-12-20" && up.a.p.payment_status === "partially_paid" && /Saved/.test(await p.innerText("#trEMsg")), "edit expected date + payment: saved");
  check(/expected delivery: 2026-12-15 → 2026-12-20/.test(await p.textContent("#trDlg .tr-log")), "history of changes shows the edit");
  await p.click("[data-tr-close]");

  // Optional: the real PO / quotation PDFs
  if (docs) {
    const f = (re) => path.join(docs, fs.readdirSync(docs).find((n) => re.test(n)));
    await p.click("#trNew"); await p.waitForSelector("#trNewDlg[open]");
    await p.setInputFiles("#trPdf", [f(/PO_26-2107/), f(/SQ-00000388/)]); await p.waitForTimeout(4000);
    const t = await p.innerText("#trNewDlg");
    check((await p.inputValue("#trNPo")) === "PO26-2107" && (await p.inputValue("#trNCur")) === "AUD" && /12 lines add up to AUD [\d,.]+ = the document total/.test(t), "real PDFs: PO26-2107 + SQ-00000388 read, 12 lines = the document total");
    await p.click("[data-tr-nclose]");
  }

  const staffCalls = db.calls.filter((c) => /^transit_(admin|cancel|delete)/.test(c.name)).length;
  check(staffCalls === 0, "staff never called an Admin function");
  const stockWrites = requests.filter((r) => r.method !== "GET" && !/\/rest\/v1\/rpc\/(transit_|renson_access)|\/storage\/v1\/object\/transit-documents\//.test(r.url));
  check(stockWrites.every((r) => /^\/functions\/v1\/checkin/.test(r.url)) && stockWrites.length === 2, "only stock writes = the 2 normal Check-ins " + JSON.stringify(stockWrites.map((r) => r.url)));
  check(!errors.length, "no page errors " + errors.join(" | "));
  await p.close();

  // Admin: raise an ordered quantity (reason required), cancel a pending quantity
  {
    const a = await session(browser, "admin");
    await a.p.click('nav button[data-v="transit"]'); await a.p.waitForTimeout(600);
    await a.p.click('#trTable tr[data-tr-po="1"]'); await a.p.waitForSelector("#trDlg[open]");
    check(!!(await a.p.$("#trAdm")), "admin: Admin box in the PO");
    await a.p.click(".tr-admin summary");
    const jig = db.lines.find((l) => l.order_id === 1 && l.item_code === "90001T");
    await a.p.selectOption("#trALine", String(jig.id)); await a.p.fill("#trAQty", "6");
    await a.p.click('[data-tr-adm="change"]'); await a.p.waitForTimeout(300);
    check(/Type the reason first/.test(await a.p.innerText("#trAMsg")) && !db.calls.some((c) => c.name === "transit_admin_change"), "admin: no reason = nothing sent");
    await a.p.fill("#trAReason", "Supplier adds 2 jigs"); await a.p.click('[data-tr-adm="change"]'); await a.p.waitForTimeout(800);
    const ch = db.calls.find((c) => c.name === "transit_admin_change");
    check(ch && ch.a.p.changes[0].qty_ordered === 6 && ch.a.p.changes[0].line_id === jig.id && ch.a.p.reason === "Supplier adds 2 jigs" && jig.qty_ordered === 6, "admin: ordered 4 -> 6 with the reason");
    await a.p.click(".tr-admin summary").catch(() => {});
    await a.p.selectOption("#trALine", String(jig.id)); await a.p.fill("#trACancel", "1"); await a.p.fill("#trAReason", "Short shipped");
    await a.p.click('[data-tr-adm="cancel"]'); await a.p.waitForTimeout(800);
    const cn = db.calls.find((c) => c.name === "transit_cancel");
    check(cn && cn.a.p.qty === 1 && cn.a.p.line_id === jig.id && jig.qty_cancelled === 1, "admin: cancel 1 jig");
    check(!a.errors.length, "admin: no page errors " + a.errors.join(" | "));
    await a.p.close();
  }
  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
