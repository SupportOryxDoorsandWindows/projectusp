// Delivery notes, end to end in a browser against a stand-in backend
// (nothing real is read or saved; the sign-in is a local stand-in):
//   Check-out of a job list -> notes prepared -> Delivery Notes page ->
//   fill in -> Confirm (DN number) -> correct -> print window.
// Also prints the Check-out payload (the stock lines sent), so the same run
// on the code before the change can show it is identical.
//
//   node tests/browser/delivery-notes-flow.js --pdf <job list> --libs <folder> --items <inventory.json> [--repo <checkout>] [--shot <png>] [--preview-shot <png>]
//
// --libs   as in checkin-sweep.js (pdfjs-dist@4.7.76 as "pdfjs",
//          supabase-js@2.45.4, xlsx-js-style@1.2.0), npm pack + tar -x.
// --items  a JSON array of inventory_items rows for the stand-in Master
//          Inventory (e.g. an export of the live table; not committed).
// --repo   the site to serve (default: this repository).
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const pdf = opt("--pdf"), libDir = opt("--libs"), itemsFile = opt("--items"), shot = opt("--shot"), previewShot = opt("--preview-shot");
const repo = path.resolve(opt("--repo") || path.join(__dirname, "../.."));
if (!pdf || !libDir || !itemsFile) { console.error("usage: --pdf <file> --libs <folder> --items <json> [--repo <dir>] [--shot <png>]"); process.exit(2); }
const items = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "supabase-supabase-js-2.45.4/package/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style-1.2.0/package/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs/package/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs/package/build/pdf.worker.min.mjs",
};

// ---- the stand-in backend: the delivery-note functions, as in delivery_notes.sql ----
const db = { notes: [], history: [], checkedOut: new Set(), seq: 0, canCorrect: false, checkoutPayloads: [] };
const now = () => new Date().toISOString();
const missing = (n) => [n.kind === "powder_coating" && !String(n.ral_code || "").trim() && "ral_code", !String(n.delivery_address || "").trim() && "delivery_address",
  !String(n.delivered_by || "").trim() && "delivered_by", !n.delivery_date && "delivery_date", !(n.lines || []).length && "lines"].filter(Boolean);
const apply = (n, f) => { for (const k of ["delivery_address", "contact_no", "secondary_contact_no", "delivered_by", "customer_ref", "ral_code", "lines"]) if (k in f) n[k] = f[k]; if ("delivery_date" in f) n.delivery_date = f.delivery_date || null; };
function rpc(name, a) {
  const err = (m) => ({ status: 400, body: { message: m, code: "P0001" } });
  const ok = (b) => ({ status: 200, body: b });
  const find = (id) => db.notes.find((n) => n.id === id);
  if (name === "can_correct_delivery_notes") return ok(db.canCorrect);
  if (name === "prepare_delivery_notes") {
    if (!db.checkedOut.has(a.p_hash)) return err("no_checkout");
    let created = 0, existing = 0;
    for (const e of a.p_notes) {
      if (db.notes.some((n) => n.source_document_hash === a.p_hash && n.kind === e.kind)) { existing++; continue; }
      const n = { id: "note-" + (db.notes.length + 1), kind: e.kind, source_document_hash: a.p_hash, source_document_name: a.p_doc_name, job_number: a.p_job, client: a.p_client,
        customer_ref: a.p_client, dn_number: null, delivered_by: null, delivery_date: null, corrected_count: 0, flags: e.flags || [], created_by_name: "Flow Test", created_at: now(), lines: [] };
      apply(n, e); db.notes.unshift(n); created++;
      db.history.push({ note_id: n.id, action: "prepared", by_name: "Flow Test", created_at: now() });
    }
    return ok({ created, existing });
  }
  const n = find(a.p_id);
  if (!n) return err("not_found");
  if (name === "save_delivery_note") { if (n.dn_number) return err("already_confirmed"); apply(n, a.p_fields); return ok(n); }
  if (name === "confirm_delivery_note") {
    if (n.dn_number) return err("already_confirmed");
    const t = { ...n }; apply(t, a.p_fields); const m = missing(t); if (m.length) return err("missing:" + m.join(","));
    Object.assign(n, t, { dn_number: "DN-SF-" + String(++db.seq).padStart(4, "0"), confirmed_by_name: "Flow Test" });
    db.history.push({ note_id: n.id, action: "confirmed", by_name: "Flow Test", created_at: now() }); return ok(n);
  }
  if (name === "correct_delivery_note") {
    if (!db.canCorrect) return err("not_allowed");
    if (!String(a.p_reason || "").trim()) return err("reason_required");
    const t = { ...n }; apply(t, a.p_fields); const m = missing(t); if (m.length) return err("missing:" + m.join(","));
    Object.assign(n, t, { corrected_count: n.corrected_count + 1 });
    db.history.push({ note_id: n.id, action: "corrected", reason: a.p_reason, by_name: "Flow Test", created_at: now() }); return ok(n);
  }
  return err("unknown rpc " + name);
}

(async () => {
  const browser = await chromium.launch();
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
  const user = { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "flow@example.test", app_metadata: {}, user_metadata: {} };
  await p.route(/\.supabase\.co\//, async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (u.pathname === "/auth/v1/token") return send(200, { access_token: "flow", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "flow", user });
    if (u.pathname === "/auth/v1/user") return send(200, user);
    if (u.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 204, body: "" });
    if (u.pathname.startsWith("/functions/v1/checkout")) {
      const type = req.headers()["content-type"] || "";
      const body = /multipart/.test(type) ? JSON.parse((await new Response(req.postDataBuffer(), { headers: { "content-type": type } }).formData()).get("payload")) : JSON.parse(req.postData() || "{}");
      db.checkoutPayloads.push(body);
      if (body.pdf_hash) db.checkedOut.add(body.pdf_hash);
      return send(200, { ok: true, lines: body.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })), document: { saved: true } });
    }
    if (u.pathname.startsWith("/functions/v1/")) return send(200, { ok: true });
    const rpcName = (u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    if (rpcName) { const r = rpc(rpcName, JSON.parse(req.postData() || "{}")); return send(r.status, r.body); }
    const table = (u.pathname.match(/^\/rest\/v1\/(\w+)/) || [])[1];
    if (table === "user_profiles") {
      const prof = { user_id: user.id, email: user.email, full_name: "Flow Test", role: "user", can_delete: true, active: true };
      return send(200, (req.headers()["accept"] || "").includes("vnd.pgrst.object") ? prof : [prof]);
    }
    if (table === "inventory_items") return send(200, items);
    if (table === "delivery_notes") return send(200, db.notes);
    if (table === "delivery_note_history") { const id = (u.searchParams.get("note_id") || "").replace(/^eq\./, ""); return send(200, db.history.filter((h) => h.note_id === id)); }
    // The site needs one product system to open (boot.js loadKB).
    if (table === "systems") return send(200, [{ id: "series-1", name: "Series 1", family: "Sliding", tracks: ["2"], any_config: false, sort_order: 0 }]);
    return send(200, req.method() === "GET" ? [] : {});
  });

  const step = (t) => console.log("·", t);
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.fill("#gateEmail", user.email); await p.fill("#gatePassword", "stand-in");
  await p.click("#gateForm button[type=submit]");
  try { await p.waitForSelector("#appShell:not([hidden])", { timeout: 30000 }); } catch (e) { console.log("SIGN-IN", (await p.innerText("body")).slice(0, 300)); throw e; }

  // ---- Check-out (unchanged screen) ----
  await p.click('nav button[data-v="fp"]');
  await p.setInputFiles("#fpPdf", pdf);
  await p.click("#fpExtract");
  await p.waitForSelector("#fpOut table tbody tr", { timeout: 60000 });
  console.log("UNMATCHED " + JSON.stringify(await p.$$eval("#fpOut table tbody tr", (trs) => trs.filter((t) => /Unmatched/i.test(t.innerText)).map((t) => t.innerText.replace(/\s+/g, " ").trim()))));
  if (previewShot) await p.locator("#fpOut").screenshot({ path: previewShot });
  for (let k = 0; k < 80; k++) { const b = p.locator('#fpOut button[data-act="skip"]:not(.on):text-is("Acknowledge")').first(); if (!(await b.count())) break; await b.click(); await p.waitForTimeout(50); }
  if (!(await p.inputValue("#fpClient"))) await p.fill("#fpClient", "Flow Test Client");
  await p.click("#fpConfirm");
  await p.waitForSelector("#fpDone .fp-done", { timeout: 20000 });
  const payload = db.checkoutPayloads[0];
  console.log("CHECKOUT_PAYLOAD " + JSON.stringify({ job_number: payload.job_number, client: payload.client, pdf_hash: payload.pdf_hash, lines: payload.lines }));
  step(`Check-out confirmed: ${payload.lines.length} stock lines sent`);
  const hasDn = await p.evaluate(() => !!window.ORYX_DN);
  if (!hasDn) { step("no delivery notes on this version (before the change)"); await browser.close(); console.log("ERRORS " + JSON.stringify(errors)); return; }
  await p.waitForSelector(".dn-after-ok, .dn-after-bad", { timeout: 30000 });
  step("after Check-out: " + (await p.innerText(".dn-after")).replace(/\s+/g, " "));

  // ---- Delivery Notes page ----
  await p.click("[data-dn-open]");
  await p.waitForSelector("#dnDetail .dn-detail", { timeout: 20000 });
  step("list: " + (await p.$$eval("#dnList tbody tr", (trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ").trim()).join(" || "))));
  const openNote = async (kind) => { await p.click(`#dnList tr[data-dn-id]:has-text("${kind}")`); await p.waitForSelector(`#dnDetail h2:has-text("${kind}")`); };
  await openNote("Powder coating");
  step("pc lines: " + (await p.$$eval("#dnDetail .dn-lines tbody tr", (trs) => trs.map((t) => t.querySelector("textarea").value + "=" + t.querySelector("input").value).join(", "))));
  step("confirm disabled before filling: " + (await p.isDisabled("#dnConfirm")));
  await p.fill("#dnRal", "REL7006M SD3000700634"); await p.dispatchEvent("#dnRal", "change");
  await p.fill("#dnDriver", "Ashok"); await p.dispatchEvent("#dnDriver", "change");
  await p.fill("#dnDate", "2026-10-28"); await p.dispatchEvent("#dnDate", "change");
  await p.click("#dnConfirm");
  await p.waitForSelector("#dnDetail .dn-msg.ok", { timeout: 10000 });
  step("confirmed: " + (await p.innerText("#dnDetail .dn-msg")) + " | status " + (await p.innerText("#dnDetail .dn-detail-st")).replace(/\s+/g, " "));
  step("locked (no inputs): " + ((await p.$$("#dnDetail .dn-lines textarea")).length === 0));
  step("printed sheet: " + (await p.innerText("#dnDetail .dn-sheet .hdr")).replace(/\s+/g, " ").slice(0, 160));
  // Print opens the browser's print window from a hidden frame.
  await p.evaluate(() => { window.__printed = 0; const orig = HTMLIFrameElement.prototype; });
  await p.click("#dnPrint");
  await p.waitForSelector("#dnPrintFrame", { state: "attached", timeout: 5000 });
  step("print frame: " + (await p.frameLocator("#dnPrintFrame").locator(".dn-sheet h3").innerText()));
  await openNote("Finished goods");
  step("fg lines: " + (await p.$$eval("#dnDetail .dn-lines tbody tr", (trs) => trs.map((t) => t.querySelector("textarea").value.replace(/\n/g, " / ") + " = " + t.querySelector("input").value).join(" || "))));

  // Correction (Renato / Admin)
  db.canCorrect = true;
  await p.click("#dnReload"); await p.waitForTimeout(500);
  await openNote("Powder coating");
  await p.click("#dnStartCorr");
  await p.locator("#dnDetail .dn-lines input").first().fill("4"); await p.locator("#dnDetail .dn-lines input").first().dispatchEvent("change");
  await p.fill("#dnReason", "Housing was 4 bars");
  await p.click("#dnSaveCorr");
  await p.waitForSelector("#dnDetail .dn-msg.ok", { timeout: 10000 });
  step("corrected: " + (await p.innerText("#dnDetail .dn-detail-st")).replace(/\s+/g, " ") + " | history: " + (await p.innerText("#dnDetail .dn-history")).replace(/\s+/g, " ").replace(/\d{2} \w{3} \d{4}, \d{2}:\d{2}/g, "<time>"));

  // Prepare again from the same job list: no duplicates
  await p.setInputFiles("#dnPrepFile", pdf);
  await p.waitForFunction(() => /already exist|Prepared/.test(document.querySelector("#dnPrepStatus").textContent), null, { timeout: 30000 });
  step("prepare again: " + (await p.innerText("#dnPrepStatus")) + " | notes now " + db.notes.length);
  if (shot) await p.screenshot({ path: shot, fullPage: true });

  // Other screens still open without errors
  for (const v of ["dashboard", "checkin", "master-inventory", "activity", "fp"]) { await p.click(`nav button[data-v="${v}"]`); await p.waitForTimeout(700); }
  step("other screens opened: dashboard, check-in, master inventory, activity, check-out");
  console.log("ERRORS " + JSON.stringify(errors));
  await browser.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
