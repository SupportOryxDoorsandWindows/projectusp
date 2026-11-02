/* Renson inventory -- ADMIN-ONLY PILOT (2026-11-02, user's request
 * "Admin-Only Testing Before System-Wide Release").
 *
 * Completely apart from the Freedom inventory: its own tables
 * (renson_items / renson_imports / renson_transactions, SQL
 * supabase/sql/renson_pilot.sql). Nothing here reads or writes a Freedom
 * table, and no Freedom page is changed.
 *
 * Who sees it: boot.js only loads this file for an Admin, and the page only
 * appears when the database says renson_access() (= Admin AND the feature
 * flag 'renson_pilot' is on). The database refuses everyone else on its own
 * (read policies + the functions), so hiding is not the protection.
 *
 * What it does (pilot): in Master Inventory, an "Inventory: Freedom / Renson
 * (pilot)" dropdown; Renson stock list with quantities and value; opening import from
 * the Renson stock Excel ("RENSON STOCK OCT 27.xlsx": sheet STOCK, header
 * row with "Part Code", stock in the dated column, "OPENING COST PER
 * PROFILE", "Total opening cost", sheet total beside "INVENTORY VALUE"),
 * reviewed before it is confirmed. Check-out (2026-11-02) from a Renson FP Pro
 * job list (readJobList / buildRensonCheckout below), Movements list.
 * Renson Check-in is NOT built yet (user: wait for Renson sample files).
 *
 * Pure parts: window.ORYX_RENSON_CORE (tests/renson.test.js).
 */
(function () {
  "use strict";
  const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const EXCEL_ERR = /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|NULL!)$/i;

  // "2405 (P6028425)-Spline Ø 6 mm"       -> 2405, alt P6028425, "Spline Ø 6 mm"
  // "1465-G6020837-End piece ... white"   -> 1465, alt G6020837, "End piece ... white"
  // "D6110097-Sergé SC0140 ..."           -> D6110097
  // "910005R-Pet Mesh 3000mm Roll ..."    -> 910005R
  function splitPartCode(text) {
    const t = norm(text);
    const m = /^([A-Za-z]{0,2}\d{2,}[A-Za-z]?)\s*(?:\(\s*([A-Za-z0-9]+)\s*\))?\s*-\s*(.*)$/.exec(t);
    if (!m) return null;
    let alt = m[2] || "";
    let desc = norm(m[3]);
    const second = /^([A-Za-z]\d{5,})\s*-\s*(.+)$/.exec(desc);
    if (!alt && second) { alt = second[1]; desc = norm(second[2]); }
    return { code: m[1].toUpperCase(), alt: alt.toUpperCase(), description: desc || m[1] };
  }

  function excelDate(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (isNum(v) && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
    return "";
  }

  // rows = the sheet as an array of rows (XLSX sheet_to_json header:1, raw).
  // Returns {ok, error?, header, stockDate, sheetTotal, items[], issues[],
  // totals}. issues: {kind: "error"|"warning"|"note", row, code, text};
  // any error blocks the import.
  function parseRensonSheet(rows) {
    const out = { ok: false, items: [], issues: [], stockDate: "", sheetTotal: null, totals: { items: 0, withStock: 0, value: 0, noCount: 0 } };
    const low = (v) => norm(v).toLowerCase();
    const h = rows.findIndex((r) => Array.isArray(r) && r.some((c) => low(c) === "part code"));
    if (h < 0) { out.error = 'No header row with "Part Code" was found. Is this the Renson STOCK sheet?'; return out; }
    const hdr = rows[h];
    const col = (name) => hdr.findIndex((c) => low(c) === name);
    const C = {
      product: col("product"), colour: col("blk/wht"), part: col("part code"),
      composite: hdr.findIndex((c) => /^composite/.test(low(c))), unit: col("length"),
      cost: col("opening cost per profile"), value: col("total opening cost"),
    };
    if (C.cost < 0 || C.value < 0) { out.error = 'The columns "OPENING COST PER PROFILE" and "Total opening cost" were not found.'; return out; }
    C.qty = C.cost - 1;                       // the stock column (headed with the count date)
    C.type = C.product >= 0 ? C.product + 1 : -1;
    out.stockDate = excelDate(hdr[C.qty]);
    if (!out.stockDate && !/stock|qty|count/i.test(norm(hdr[C.qty]))) {
      out.error = 'The stock column (just before "OPENING COST PER PROFILE") has no date or "stock" heading.';
      return out;
    }
    out.header = { row: h + 1, columns: C };
    for (let i = 0; i < h; i++) {
      const r = rows[i] || [];
      const k = r.findIndex((c) => low(c) === "inventory value");
      if (k >= 0) { const v = r.slice(k + 1).find(isNum); if (v != null) out.sheetTotal = v; }
    }

    const seen = new Map();
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const text = norm(r[C.part]);
      if (!text || EXCEL_ERR.test(text)) continue;
      const rowNo = i + 1;
      const p = splitPartCode(text);
      if (!p) { out.issues.push({ kind: "error", row: rowNo, code: "", text: `No item code at the start of "${text}".` }); continue; }
      const issue = (kind, t) => out.issues.push({ kind, row: rowNo, code: p.code, text: t });
      const qv = r[C.qty], cv = r[C.cost], vv = r[C.value];
      let qty = 0;
      if (isNum(qv)) qty = qv;
      else if (qv == null || norm(qv) === "") { qty = 0; out.totals.noCount++; }
      else { issue("error", `Stock "${norm(qv)}" is not a number.`); continue; }
      if (qty < 0) { issue("error", `Stock is negative (${qty}).`); continue; }
      let cost = null;
      if (isNum(cv)) cost = cv;
      else if (cv != null && norm(cv) !== "") { issue("error", `Unit cost "${norm(cv)}" is not a number.`); continue; }
      if (cost != null && cost < 0) { issue("error", `Unit cost is negative (${cost}).`); continue; }
      if (seen.has(p.code)) { issue("error", `Item code ${p.code} is also on row ${seen.get(p.code)}.`); continue; }
      seen.set(p.code, rowNo);
      const value = round2(qty * (cost || 0));
      if (qty > 0 && cost == null) issue("warning", "Has stock but no unit cost: its value counts as 0.");
      if (qty === 0 && cost != null && cost > 0) issue("note", "Has a unit cost but no stock.");
      if (isNum(vv) && Math.abs(vv - value) > 0.01) issue("warning", `The file's total (${vv}) is not stock × unit cost (${value}).`);
      const product = norm(r[C.product]), type = C.type >= 0 ? norm(r[C.type]) : "";
      out.items.push({
        item_code: p.code, alt_codes: p.alt, description: p.description, source_text: text,
        product_size: EXCEL_ERR.test(product) ? "" : product, part_type: EXCEL_ERR.test(type) ? "" : type,
        colour: EXCEL_ERR.test(norm(r[C.colour])) ? "" : norm(r[C.colour]),
        qty_per_set: isNum(r[C.composite]) ? r[C.composite] : null,
        unit: EXCEL_ERR.test(norm(r[C.unit])) ? "" : norm(r[C.unit]),
        qty, unit_cost: cost, value, source_row: rowNo,
      });
      out.totals.value = round2(out.totals.value + value);
      if (qty > 0) out.totals.withStock++;
    }
    out.totals.items = out.items.length;
    if (!out.items.length) out.error = "No Renson items were found under the header row.";
    out.totalMatches = out.sheetTotal == null ? null : Math.abs(out.sheetTotal - out.totals.value) <= 0.01;
    out.ok = !out.error && !out.issues.some((x) => x.kind === "error");
    return out;
  }

  // ------------------------------------------------------------ Check-out
  // Renson job list = the same FP Pro layout as Freedom's ("24222-Paolo OPT
  // LIST Rev. 02.pdf"): Fittings List (pieces) + GASKETS (metres), and a Bars
  // Optimization Report whose Renson bars carry no item code. User's answers
  // (2026-11-02): bars map by their description below; a "Pair" bar = 2
  // stock bars; 2450 inner guiding rail metres / 6 rounded up = bars; lines
  // that are not Renson items (Freedom items such as 910010 Patio Mesh, Box
  // Sections) are left out and listed; stock may go below zero.
  const RENSON_BARS = [
    { desc: "fixed profile head box square - 100 (is)", code: "25089", perBar: 1 },
    { desc: "removable profile head box square - 100 (os)", code: "24295", perBar: 1 },
    { desc: "fabric tube ø 68 mm", code: "26562", perBar: 1 },
    { desc: "bottom bar profile square - drawbar", code: "14102", perBar: 1 },
    { desc: "side guiding channel fixed profile - pair", code: "11583", perBar: 2 },
    { desc: "side guiding channel removable - pair", code: "24282", perBar: 2 },
  ];
  const METRES_TO_BARS = { "2450": 6 };       // code -> stock bar length in metres
  const lowKey = (s) => norm(s).toLowerCase().replace(/⌀/g, "ø");
  const num = (x) => Math.round(x * 1000) / 1000;

  function jobSection(text, startRe, endRe) {
    const a = text.search(startRe);
    if (a < 0) return "";
    const rest = text.slice(a);
    const b = rest.search(endRe);
    return b < 0 ? rest : rest.slice(0, b);
  }

  // Raw entries from the job list text (pdf.js text, as fp-core.js
  // extractPdfText gives it). {kind: "fitting"|"bar", code, qty, unit,
  // description, source, why?}
  function readJobList(text) {
    const out = { job: (text.match(/Job\/Group:\s*(\S+)/) || [])[1] || "", entries: [] };
    const fit = jobSection(text, /Fittings List\s*\(1 of/, /Bars Optimization Report|OPTIMIZED CUTTING LIST/);
    for (const raw of fit.split(/\b(?:ORYX|RENSON)\b(?=\s+[0-9])/).slice(1)) {
      const chunk = norm(raw.split(/Class:|Printout date|Job\/Group:/)[0]);
      const cm = /^([0-9]+[A-Za-z]?)[-(\s]/.exec(chunk);
      if (!cm) continue;
      const code = cm[1].toUpperCase();
      const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp("\\s(\\d+(?:\\.\\d+)?)\\s*(m)?\\s+(" + esc + "\\b.*)$", "i").exec(chunk);
      if (!m) { out.entries.push({ kind: "fitting", code, qty: 0, unit: "", description: chunk, source: chunk, why: "The quantity could not be read." }); continue; }
      const qty = parseFloat(m[1]);
      const unit = m[2] ? "m" : "pc";
      out.entries.push({ kind: "fitting", code, qty, unit, description: norm(m[3]), source: `${qty}${unit === "m" ? " m" : " pcs"} on the job list` });
    }
    const bars = jobSection(text, /Bars Optimization Report\s*\(1 of/, /OPTIMIZED CUTTING LIST/);
    const re = /Bars:\s*(\d+)\s*x\s*(\d+)[\s\S]*?Description:\s*([^\n]+?)\s*Total length:\s*([\d.]+)\s*m/g;
    let m;
    while ((m = re.exec(bars)) !== null) {
      const n = parseInt(m[1], 10), len = parseInt(m[2], 10), desc = norm(m[3]);
      const map = RENSON_BARS.find((b) => b.desc === lowKey(desc));
      const src = `${n} × ${len} mm "${desc}"`;
      if (map) {
        out.entries.push({ kind: "bar", code: map.code, qty: n * map.perBar, unit: "bar", description: desc,
          source: src + (map.perBar === 2 ? ` = ${n * 2} bars (Pair)` : "") });
      } else if (/^box section\b/i.test(desc)) {
        out.entries.push({ kind: "bar", code: "", qty: n, unit: "bar", description: desc, source: src, why: "Box Section: not a Renson item, not taken off." });
      } else {
        out.entries.push({ kind: "bar", code: "", qty: n, unit: "bar", description: desc, source: src, why: "No Renson item is set for this bar: not taken off." });
      }
    }
    return out;
  }

  // itemsByCode: Map(UPPER code -> renson_items row). Returns {job, lines
  // (to take off, one per Renson item), left (not taken off, with why)}.
  function buildRensonCheckout(text, itemsByCode) {
    const read = readJobList(text);
    const byCode = new Map(), left = [];
    for (const e of read.entries) {
      if (e.why) { left.push(e); continue; }
      const item = itemsByCode.get(e.code);
      if (!item) { left.push({ ...e, why: "Not a Renson item (e.g. a Freedom item): not taken off." }); continue; }
      const cur = byCode.get(e.code);
      if (cur) { cur.jobQty = num(cur.jobQty + e.qty); cur.sources.push(e.source); }
      else byCode.set(e.code, { item_code: item.item_code, item, jobQty: e.qty, unit: e.unit, description: e.description, sources: [e.source] });
    }
    const lines = [...byCode.values()].map((l) => {
      const barM = METRES_TO_BARS[l.item_code.toUpperCase()];
      let qty = l.jobQty, unit = l.unit, note = l.sources.join(" + ");
      if (barM && l.unit === "m") {
        qty = Math.ceil(l.jobQty / barM - 1e-9);
        unit = "bar";
        note += ` → ${l.jobQty} m ÷ ${barM} m = ${qty} bars (rounded up)`;
      }
      const before = Number(l.item.current_qty) || 0;
      const cost = l.item.unit_cost == null ? null : Number(l.item.unit_cost);
      return { item_code: l.item_code, description: l.item.description, jobDescription: l.description, qty, unit, source: note,
        before, after: num(before - qty), unit_cost: cost, value: Math.round(qty * (cost || 0) * 100) / 100 };
    });
    lines.sort((a, b) => a.item_code.localeCompare(b.item_code, "en", { numeric: true }));
    return { job: read.job, lines, left };
  }

  window.ORYX_RENSON_CORE = { splitPartCode, parseRensonSheet, excelDate, readJobList, buildRensonCheckout, RENSON_BARS, METRES_TO_BARS };
})();

// ======================================================================
// The page (Admins only, while the pilot flag is on). Tests load the core
// above without a document.
// ======================================================================
(function () {
  "use strict";
  if (typeof document === "undefined" || !window.ORYX_AUTH) return;
  const AUTH = window.ORYX_AUTH;
  if (!AUTH.isAdmin()) return;                 // boot.js already skips non-Admins
  const R = window.ORYX_RENSON_CORE;
  const sb = AUTH.sb;
  const $ = (s, root) => (root || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
  const MAX_FILE = 15 * 1024 * 1024;
  const aed = (x) => "AED " + Number(x || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (x) => Number(x || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

  const ui = { tab: "inventory", items: [], lastImport: null, moves: [], loading: false, loadError: "", q: "", file: null, hash: "", parsed: null, msg: null, busy: false,
    out: { file: null, hash: "", job: "", result: null, skip: new Set(), busy: false, reading: false } };

  // Ask the database first: Admin AND pilot flag on. Anything else = nothing appears.
  sb.rpc("renson_access").then(({ data, error }) => {
    if (error || data !== true) return;
    mount();
  });

  function mount() {
    const style = document.createElement("style");
    style.textContent = `
.rn-pick{display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; color:var(--brand)}
.rn-pick select{border:1px solid #C5D0D4; border-radius:10px; padding:8px 10px; font:inherit; font-weight:600; background:var(--white); color:var(--brand)}
#v-master-inventory.rn-on .page-body > :not(#rnBody), #v-master-inventory.rn-on #miExtractBtn{display:none !important}
#v-master-inventory:not(.rn-on) #rnBody{display:none}
.rn-pill{display:inline-block; margin-left:8px; padding:2px 10px; border-radius:999px; background:#FEF3C7; color:#92400E; font-size:12px; font-weight:600; vertical-align:middle}
.rn-tabs{display:flex; gap:8px; margin:0 0 18px; flex-wrap:wrap}
.rn-tabs button{border:1px solid #C5D0D4; background:var(--white); color:var(--brand); border-radius:10px; padding:8px 14px; font:inherit; cursor:pointer}
.rn-tabs button.on{background:var(--brand); color:#fff; border-color:var(--brand)}
.rn-kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr)); gap:12px; margin-bottom:16px}
.rn-kpis .kpi{background:var(--white); border:1px solid #DCE3E6}
.rn-tools{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px}
.rn-tools input[type=search]{flex:1 1 240px; border:1px solid #C5D0D4; border-radius:10px; padding:9px 12px; font:inherit}
.rn-wrap{overflow:auto; border:1px solid #DCE3E6; border-radius:12px; background:var(--white)}
.rn-table{width:100%; border-collapse:collapse; font-size:14px}
.rn-table th,.rn-table td{padding:9px 12px; border-bottom:1px solid #EEF2F4; text-align:left; vertical-align:top}
.rn-table th{font-size:12.5px; color:var(--text-muted); font-weight:600; background:#F7F9FA; position:sticky; top:0}
.rn-table td.r,.rn-table th.r{text-align:right; white-space:nowrap}
.rn-table tfoot td{font-weight:700; background:#F7F9FA}
.rn-table .rn-alt{display:block; font-size:12px; color:var(--text-muted)}
.rn-table tr.rn-zero td{color:var(--text-muted)}
.rn-msg{border-radius:12px; padding:12px 14px; margin:0 0 14px}
.rn-msg.ok{background:#DCFCE7; color:#166534}.rn-msg.bad{background:#FEE2E2; color:#991B1B}.rn-msg.info{background:#E0F2FE; color:#075985}
.rn-issues{list-style:none; padding:0; margin:0 0 14px; display:grid; gap:6px}
.rn-issues li{border-radius:10px; padding:8px 12px; font-size:14px}
.rn-issues li.error{background:#FEE2E2; color:#991B1B}.rn-issues li.warning{background:#FEF3C7; color:#92400E}.rn-issues li.note{background:#F0F3F5; color:#334155}
.rn-file{display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:14px}
.rn-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:14px}
.rn-danger{background:none; border:none; color:var(--danger); text-decoration:underline; cursor:pointer; font:inherit; padding:0}
`;
    document.head.appendChild(style);

    // Master Inventory gets an "Inventory: Freedom / Renson (pilot)" dropdown
    // (user, 2026-11-02: "add it to the master inventory"). Renson is drawn in
    // its own box inside the page; the Freedom list underneath is only hidden
    // while Renson is chosen, never changed.
    const view = $("#v-master-inventory");
    const head = view && $(".page-head", view), pageBody = view && $(".page-body", view);
    if (!head || !pageBody) return;
    const pick = document.createElement("label");
    pick.className = "rn-pick";
    pick.innerHTML = `Inventory <select id="rnInventory" aria-label="Inventory"><option value="freedom">Freedom</option><option value="renson">Renson (pilot)</option></select>`;
    const actions = $(".page-actions", head);
    if (actions) actions.insertBefore(pick, actions.firstChild); else head.appendChild(pick);
    const box = document.createElement("div");
    box.id = "rnBody";
    pageBody.insertBefore(box, pageBody.firstChild);
    const sub = $(".page-head p", view);
    const freedomSub = sub ? sub.textContent : "";

    const select = $("#rnInventory");
    const show = (which) => {
      const ren = which === "renson";
      select.value = ren ? "renson" : "freedom";
      view.classList.toggle("rn-on", ren);
      if (sub) sub.innerHTML = ren ? `Renson stock <span class="rn-pill">Pilot · Admins only</span> Kept apart from Freedom; nothing here changes Freedom stock.` : esc(freedomSub);
      try { sessionStorage.setItem("oryx_mi_inventory", ren ? "renson" : "freedom"); } catch (e) { /* private mode */ }
      if (ren) load();
    };
    select.addEventListener("change", () => show(select.value));
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onChange);

    let last = null;
    try { last = sessionStorage.getItem("oryx_mi_inventory"); } catch (e) { last = null; }
    if (last === "renson") show("renson");
  }

  async function load() {
    ui.loading = true; ui.loadError = ""; render();
    const [items, imports, moves] = await Promise.all([
      sb.from("renson_items").select("*").order("item_code").order("id"),
      sb.from("renson_imports").select("*").order("created_at", { ascending: false }).limit(1),
      sb.from("renson_transactions").select("*").neq("type", "opening_import").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(300),
    ]);
    ui.loading = false;
    const bad = items.error || imports.error || moves.error;
    if (bad) { ui.loadError = bad.message; return render(); }
    ui.items = items.data || [];
    ui.lastImport = (imports.data || [])[0] || null;
    ui.moves = moves.data || [];
    if (!ui.items.length && ui.tab === "inventory" && !ui.parsed) ui.tab = "import";
    render();
  }

  // ------------------------------------------------------------ render
  const tile = (label, value, note) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<span class="kpi-note">${esc(note)}</span>` : ""}</div>`;

  function render() {
    const body = $("#rnBody");
    if (!body) return;
    const tabs = `<div class="rn-tabs" role="tablist">
      <button type="button" data-rn-tab="inventory" class="${ui.tab === "inventory" ? "on" : ""}">Inventory</button>
      <button type="button" data-rn-tab="checkout" class="${ui.tab === "checkout" ? "on" : ""}">Check-out</button>
      <button type="button" data-rn-tab="moves" class="${ui.tab === "moves" ? "on" : ""}">Movements</button>
      <button type="button" data-rn-tab="import" class="${ui.tab === "import" ? "on" : ""}">Import stock file</button></div>`;
    const msg = ui.msg ? `<div class="rn-msg ${ui.msg[0]}">${esc(ui.msg[1])}</div>` : "";
    if (ui.loading) { body.innerHTML = tabs + `<div class="card">Loading Renson inventory…</div>`; return; }
    if (ui.loadError) { body.innerHTML = tabs + `<div class="rn-msg bad">Could not read the Renson inventory: ${esc(ui.loadError)}</div>`; return; }
    body.innerHTML = tabs + msg + ({ inventory: inventoryHtml, checkout: checkoutHtml, moves: movesHtml }[ui.tab] || importHtml)();
  }

  function inventoryHtml() {
    const all = ui.items;
    if (!all.length) {
      return `<div class="card"><p>No Renson items yet.</p><p class="muted">Import the Renson stock file to start the pilot.</p>
        <div class="rn-actions"><button type="button" class="btn-yellow" data-rn-tab="import">Import stock file</button></div></div>`;
    }
    const value = all.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const withStock = all.filter((i) => Number(i.current_qty) > 0);
    const noCost = withStock.filter((i) => i.unit_cost == null).length;
    const q = ui.q.toLowerCase();
    const rows = q ? all.filter((i) => [i.item_code, i.alt_codes, i.description, i.product_size, i.colour].join(" ").toLowerCase().includes(q)) : all;
    const shownValue = rows.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const imp = ui.lastImport;
    return `<div class="rn-kpis">
        ${tile("Stock value", aed(value), "stock × unit cost")}
        ${tile("Items", String(all.length), withStock.length + " with stock")}
        ${tile("Out of stock", String(all.length - withStock.length))}
        ${tile("Stock without a cost", String(noCost), noCost ? "value counted as 0" : "")}
      </div>
      ${imp ? `<p class="muted">Opening stock from <b>${esc(imp.file_name)}</b>, imported ${esc(when(imp.created_at))} by ${esc(imp.imported_by_name || "—")}.</p>` : ""}
      <div class="rn-tools"><input type="search" id="rnSearch" placeholder="Search code, description, size, colour" value="${esc(ui.q)}" aria-label="Search Renson items">
        <span class="muted">${rows.length} of ${all.length} items</span></div>
      <div class="rn-wrap"><table class="rn-table"><thead><tr>
        <th>Code</th><th>Description</th><th>Size</th><th>Colour</th><th>Unit</th><th class="r">Stock</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
        <tbody>${rows.map((i) => `<tr class="${Number(i.current_qty) > 0 ? "" : "rn-zero"}">
          <td class="mono">${esc(i.item_code)}</td>
          <td>${esc(i.description)}${i.alt_codes ? `<span class="rn-alt">Also ${esc(i.alt_codes)}</span>` : ""}</td>
          <td>${esc(i.product_size || "")}</td><td>${esc(i.colour || "")}</td><td>${esc(i.unit || "")}</td>
          <td class="r">${qtyFmt(i.current_qty)}</td>
          <td class="r">${i.unit_cost == null ? `<span class="muted">No cost</span>` : aed(i.unit_cost)}</td>
          <td class="r">${aed(i.current_value)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="7">${q ? "Total of the items shown" : "Total stock value"}</td><td class="r">${aed(shownValue)}</td></tr></tfoot>
      </table></div>`;
  }

  function importHtml() {
    const has = ui.items.length > 0;
    let h = "";
    if (has) {
      h += `<div class="rn-msg info">The opening stock is already imported (${ui.items.length} items). To import again, first clear the Renson pilot data below. This clears Renson only.</div>`;
    }
    h += `<div class="card"><div class="rn-file">
        <input type="file" id="rnFile" accept=".xlsx,.xlsm,.xls" ${has ? "disabled" : ""} aria-label="Renson stock file">
        ${ui.file ? `<span class="muted">${esc(ui.file.name)}</span>` : `<span class="muted">Choose the Renson stock Excel (sheet STOCK).</span>`}
      </div>`;
    const p = ui.parsed;
    if (p) {
      if (p.error) h += `<div class="rn-msg bad">${esc(p.error)}</div>`;
      else {
        const errors = p.issues.filter((x) => x.kind === "error");
        const warns = p.issues.filter((x) => x.kind !== "error");
        h += `<div class="rn-kpis">
          ${tile("Items found", String(p.totals.items), p.totals.withStock + " with stock")}
          ${tile("No count in the file", String(p.totals.noCount), "imported with 0 stock")}
          ${tile("Stock value", aed(p.totals.value), "stock × unit cost")}
          ${tile("File's own INVENTORY VALUE", p.sheetTotal == null ? "Not found" : aed(p.sheetTotal), p.totalMatches == null ? "" : p.totalMatches ? "✓ matches" : "✗ does not match")}
        </div>
        <p class="muted">Sheet ${esc(p.sheet || "")}, header on row ${p.header.row}${p.stockDate ? ", stock counted " + esc(p.stockDate) : ""}.</p>`;
        if (errors.length) h += `<div class="rn-msg bad">${errors.length} problem(s) must be fixed in the file before it can be imported:</div>`;
        if (errors.length || warns.length) {
          h += `<ul class="rn-issues">${[...errors, ...warns].map((x) => `<li class="${x.kind}">Row ${x.row}${x.code ? " · " + esc(x.code) : ""}: ${esc(x.text)}</li>`).join("")}</ul>`;
        }
        h += `<div class="rn-wrap"><table class="rn-table"><thead><tr><th class="r">Row</th><th>Code</th><th>Description</th><th>Size</th><th>Colour</th><th>Unit</th>
          <th class="r">Stock</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead><tbody>
          ${p.items.map((i) => `<tr class="${i.qty > 0 ? "" : "rn-zero"}"><td class="r muted">${i.source_row}</td><td class="mono">${esc(i.item_code)}</td>
            <td>${esc(i.description)}${i.alt_codes ? `<span class="rn-alt">Also ${esc(i.alt_codes)}</span>` : ""}</td>
            <td>${esc(i.product_size)}</td><td>${esc(i.colour)}</td><td>${esc(i.unit)}</td>
            <td class="r">${qtyFmt(i.qty)}</td><td class="r">${i.unit_cost == null ? `<span class="muted">No cost</span>` : aed(i.unit_cost)}</td><td class="r">${aed(i.value)}</td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="8">Total stock value</td><td class="r">${aed(p.totals.value)}</td></tr></tfoot></table></div>
          <div class="rn-actions">
            <button type="button" class="btn-yellow" data-rn-act="confirm" ${p.ok && !has && !ui.busy ? "" : "disabled"}>${ui.busy ? "Importing…" : `Confirm import of ${p.totals.items} items`}</button>
            <button type="button" class="btn-outline" data-rn-act="cancel" ${ui.busy ? "disabled" : ""}>Cancel</button>
          </div>`;
      }
    }
    h += `</div>`;
    if (has) h += `<p style="margin-top:18px"><button type="button" class="rn-danger" data-rn-act="reset">Clear Renson pilot data…</button></p>`;
    return h;
  }

  // ------------------------------------------------------------ Check-out
  // Renson job list (FP Pro PDF) -> preview -> Confirm. Only Renson items
  // are taken off (renson_checkout); everything else is listed as left out.
  function checkoutHtml() {
    const o = ui.out;
    if (!ui.items.length) return `<div class="card"><p>Import the Renson stock file first.</p></div>`;
    let h = `<div class="card"><div class="rn-file">
        <input type="file" id="rnOutFile" accept="application/pdf,.pdf" aria-label="Renson job list (PDF)" ${o.busy ? "disabled" : ""}>
        <span class="muted">${o.file ? esc(o.file.name) : "Choose the Renson job list (PDF from FP Pro)."}</span></div>`;
    if (o.reading) h += `<p class="muted">Reading the job list…</p>`;
    const r = o.result;
    if (r) {
      const take = r.lines.filter((l) => !o.skip.has(l.item_code));
      const value = take.reduce((s, l) => s + l.value, 0);
      const below = take.filter((l) => l.after < 0).length;
      h += `<div class="rn-tools"><label class="field-label" for="rnOutJob" style="margin:0">Job number</label>
          <input id="rnOutJob" value="${esc(o.job)}" maxlength="60" style="border:1px solid #C5D0D4;border-radius:10px;padding:8px 12px;font:inherit;width:180px"></div>
        <div class="rn-kpis">
          ${tile("Lines to take off", String(take.length), r.lines.length - take.length ? `${r.lines.length - take.length} unticked` : "")}
          ${tile("Value taken off", aed(value), "stock × unit cost")}
          ${tile("Going below zero", String(below), below ? "allowed; fix with a later Check-in" : "")}
          ${tile("Left out", String(r.left.length), "not Renson items")}
        </div>
        <div class="rn-wrap"><table class="rn-table"><thead><tr><th>Take off</th><th>Code</th><th>Renson item</th><th>From the job list</th>
          <th class="r">Qty</th><th class="r">Stock now</th><th class="r">Stock after</th><th class="r">Value</th></tr></thead><tbody>
          ${r.lines.map((l) => { const on = !o.skip.has(l.item_code); return `<tr class="${on ? "" : "rn-zero"}">
            <td><input type="checkbox" data-rn-take="${esc(l.item_code)}" ${on ? "checked" : ""} aria-label="Take off ${esc(l.item_code)}"></td>
            <td class="mono">${esc(l.item_code)}</td><td>${esc(l.description)}</td><td class="muted">${esc(l.source)}</td>
            <td class="r">${qtyFmt(l.qty)} ${esc(l.unit)}</td><td class="r">${qtyFmt(l.before)}</td>
            <td class="r">${on ? qtyFmt(l.after) + (l.after < 0 ? ` <span class="rn-pill" style="background:#FEE2E2;color:#991B1B;margin-left:4px">Below zero, allowed</span>` : "") : qtyFmt(l.before)}</td>
            <td class="r">${l.unit_cost == null ? `<span class="muted">No cost</span>` : aed(l.value)}</td></tr>`; }).join("")}
          </tbody><tfoot><tr><td colspan="7">Value taken off</td><td class="r">${aed(value)}</td></tr></tfoot></table></div>`;
      if (r.left.length) {
        h += `<h3 class="card-title" style="margin-top:18px">Left out (not taken off)</h3>
          <div class="rn-wrap"><table class="rn-table"><thead><tr><th>Code</th><th>On the job list</th><th class="r">Qty</th><th>Why</th></tr></thead><tbody>
          ${r.left.map((l) => `<tr><td class="mono">${esc(l.code || "—")}</td><td>${esc(l.description)}</td><td class="r">${qtyFmt(l.qty)} ${esc(l.unit === "pc" ? "pcs" : l.unit)}</td><td class="muted">${esc(l.why)}</td></tr>`).join("")}
          </tbody></table></div>`;
      }
      h += `<div class="rn-actions">
          <button type="button" class="btn-yellow" data-rn-act="out-confirm" ${take.length && !o.busy ? "" : "disabled"}>${o.busy ? "Saving…" : `Confirm Check-out (${take.length} lines)`}</button>
          <button type="button" class="btn-outline" data-rn-act="out-cancel" ${o.busy ? "disabled" : ""}>Cancel</button></div>`;
    }
    return h + `</div>`;
  }

  function movesHtml() {
    if (!ui.moves.length) return `<div class="card"><p>No Renson Check-outs yet.</p><p class="muted">The opening stock import is not listed here.</p></div>`;
    return `<div class="rn-wrap"><table class="rn-table"><thead><tr><th>When</th><th>Type</th><th>Job</th><th>Code</th><th>Item</th>
      <th class="r">Qty</th><th class="r">Stock before → after</th><th class="r">Value</th><th>By</th></tr></thead><tbody>
      ${ui.moves.map((m) => { const it = ui.items.find((i) => i.id === m.item_id); return `<tr><td>${esc(when(m.created_at))}</td>
        <td>${m.type === "check_out" ? "Check-out" : esc(m.type)}</td><td>${esc(m.job_number || "")}</td><td class="mono">${esc(m.item_code)}</td>
        <td>${esc(it ? it.description : "")}${m.source ? `<span class="rn-alt">${esc(m.source)}</span>` : ""}</td>
        <td class="r">${m.type === "check_out" ? "−" : ""}${qtyFmt(m.quantity)} ${esc(m.unit || "")}</td>
        <td class="r">${qtyFmt(m.qty_before)} → ${qtyFmt(m.qty_after)}</td><td class="r">${aed(m.value)}</td><td>${esc(m.performed_by_name || "")}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  async function readJobFile(f) {
    const o = ui.out;
    ui.msg = null; o.result = null; o.skip = new Set(); o.file = f; o.hash = "";
    if (!/\.pdf$/i.test(f.name)) { ui.msg = ["bad", "Choose the job list PDF."]; o.file = null; return render(); }
    const FP = window.ORYX_FP;
    if (!FP || !FP.extractPdfText) { ui.msg = ["bad", "The PDF reader is not ready yet. Try again in a moment."]; o.file = null; return render(); }
    o.reading = true; render();
    try {
      const [text, hash] = await Promise.all([FP.extractPdfText(f), FP.pdfFingerprint(f)]);
      const byCode = new Map(ui.items.map((i) => [String(i.item_code).toUpperCase(), i]));
      o.result = R.buildRensonCheckout(text, byCode);
      o.hash = hash;
      o.job = o.result.job || "";
      if (!o.result.lines.length) ui.msg = ["bad", "No Renson items were found on this job list."];
      else if (ui.moves.some((m) => m.type === "check_out" && m.document_hash === hash)) ui.msg = ["bad", "This job list was already checked out. Confirm will be refused."];
    } catch (err) {
      ui.msg = ["bad", "Could not read the PDF: " + (err && err.message ? err.message : err)];
      o.file = null; o.result = null;
    }
    o.reading = false;
    render();
  }

  async function confirmCheckout() {
    const o = ui.out, r = o.result;
    if (!r || o.busy) return;
    const job = (o.job || "").trim();
    if (!job) { ui.msg = ["bad", "Type the job number first."]; return render(); }
    const take = r.lines.filter((l) => !o.skip.has(l.item_code));
    if (!take.length) return;
    if (!window.confirm(`Take ${take.length} lines off the RENSON stock for job ${job}?\n\nFreedom stock is not changed.`)) return;
    o.busy = true; render();
    const { data, error } = await sb.rpc("renson_checkout", { p: {
      job_number: job, document_name: o.file.name, document_hash: o.hash,
      lines: take.map((l) => ({ item_code: l.item_code, qty: l.qty, unit: l.unit, source: l.source })),
    } });
    o.busy = false;
    if (error) {
      const m = /already_checked_out/.test(error.message) ? "This job list was already checked out."
        : /renson_not_allowed/.test(error.message) ? "Not allowed: the Renson pilot is for Admins only (or is switched off)."
        : "The Check-out was refused: " + error.message;
      ui.msg = ["bad", m + " Nothing was saved."];
      return render();
    }
    ui.msg = ["ok", `Checked out job ${job}: ${data.lines} lines, value ${aed(data.total_value)}${data.below_zero ? `, ${data.below_zero} item(s) now below zero` : ""}.`];
    ui.out = { file: null, hash: "", job: "", result: null, skip: new Set(), busy: false, reading: false };
    ui.tab = "moves";
    await load();
  }

  // ------------------------------------------------------------ events
  function onClick(e) {
    const t = e.target.closest("[data-rn-tab],[data-rn-act]");
    if (!t) return;
    if (t.dataset.rnTab) { ui.tab = t.dataset.rnTab; ui.msg = null; return render(); }
    const act = t.dataset.rnAct;
    if (act === "cancel") { ui.file = null; ui.parsed = null; ui.hash = ""; ui.msg = null; return render(); }
    if (act === "confirm") return confirmImport();
    if (act === "reset") return resetPilot();
    if (act === "out-confirm") return confirmCheckout();
    if (act === "out-cancel") { ui.out = { file: null, hash: "", job: "", result: null, skip: new Set(), busy: false, reading: false }; ui.msg = null; return render(); }
  }
  function onInput(e) {
    if (e.target.id === "rnOutJob") { ui.out.job = e.target.value; return; }
    if (e.target.id === "rnSearch") {
      ui.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("#rnSearch"); if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    }
  }
  function onChange(e) {
    if (e.target.id === "rnFile" && e.target.files && e.target.files[0]) readFile(e.target.files[0]);
    if (e.target.id === "rnOutFile" && e.target.files && e.target.files[0]) readJobFile(e.target.files[0]);
    if (e.target.dataset && e.target.dataset.rnTake) {
      const c = e.target.dataset.rnTake;
      if (e.target.checked) ui.out.skip.delete(c); else ui.out.skip.add(c);
      render();
    }
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = XLSX_SRC; s.onload = res; s.onerror = () => rej(new Error("couldn't load the Excel library"));
      document.head.appendChild(s);
    });
  }

  async function readFile(f) {
    ui.msg = null; ui.parsed = null; ui.file = f;
    if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) { ui.msg = ["bad", "Choose an Excel file (.xlsx or .xls)."]; ui.file = null; return render(); }
    if (f.size > MAX_FILE) { ui.msg = ["bad", "The file is larger than 15 MB."]; ui.file = null; return render(); }
    render();
    try {
      await loadXlsx();
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      ui.hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const book = window.XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
      const name = book.SheetNames.find((n) => n.trim().toUpperCase() === "STOCK") || book.SheetNames[0];
      const rows = window.XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      ui.parsed = R.parseRensonSheet(rows);
      ui.parsed.sheet = name;
    } catch (err) {
      ui.msg = ["bad", "Could not read the file: " + (err && err.message ? err.message : err)];
      ui.file = null;
    }
    render();
  }

  async function confirmImport() {
    const p = ui.parsed;
    if (!p || !p.ok || ui.busy) return;
    if (!window.confirm(`Import ${p.totals.items} Renson items (stock value ${aed(p.totals.value)})?\n\nThis is the Renson pilot only. Freedom stock is not changed.`)) return;
    ui.busy = true; render();
    const payload = {
      file_name: ui.file.name, file_hash: ui.hash, sheet: p.sheet, sheet_total: p.sheetTotal,
      items: p.items.map(({ value, ...i }) => i),
    };
    const { data, error } = await sb.rpc("renson_import_stock", { p: payload });
    ui.busy = false;
    if (error) {
      const m = /renson_already_imported/.test(error.message) ? "The opening stock was already imported."
        : /renson_not_allowed/.test(error.message) ? "Not allowed: the Renson pilot is for Admins only (or is switched off)."
        : "The import was refused: " + error.message;
      ui.msg = ["bad", m + " Nothing was saved."];
      return render();
    }
    ui.msg = ["ok", `Imported ${data.items} items (${data.items_with_stock} with stock), stock value ${aed(data.total_value)}.`];
    ui.file = null; ui.parsed = null; ui.hash = ""; ui.tab = "inventory";
    await load();
  }

  async function resetPilot() {
    const typed = window.prompt('This deletes ALL Renson pilot data (items, import, lines). Freedom is not touched.\n\nType RESET RENSON to continue.');
    if (typed == null) return;
    if (typed.trim() !== "RESET RENSON") { ui.msg = ["bad", "Not cleared: the words did not match."]; return render(); }
    const { data, error } = await sb.rpc("renson_reset_pilot", { p_confirm: "RESET RENSON" });
    ui.msg = error ? ["bad", "Not cleared: " + error.message] : ["ok", `Renson pilot data cleared (${data.items_removed} items).`];
    ui.tab = "import";
    await load();
  }
})();
