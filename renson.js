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
 * reviewed before it is confirmed. Check-out from a Renson FP Pro job list
 * (readJobList / buildRensonCheckout below) or typed by hand; Check-in
 * (checkinPreview, same cost rule as Freedom), Adjust, Kanban levels,
 * Extract, Movements (2026-11-02: "the same workflow as Freedom").
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

  // ------------------------------------------------------------ Check-in
  // Same sums as renson_checkin() (the server works them out again; this is
  // the preview). Shipping (document currency) is split equally per line,
  // in cents, the remainder on the last line -- like Freedom's
  // ciShippingAllocation. Price paid (AED) = (unit price + line shipping /
  // qty) x rate. Average cost = Freedom's rule: (stock x cost + qty x price
  // paid) / (stock + qty) when stock > 0 and a cost is on file, else the
  // price paid (no price = the item's own cost).
  function splitShipping(total, n) {
    if (!(total > 0) || !n) return new Array(n).fill(null);
    const cents = Math.round(total * 100), base = Math.floor(cents / n), rest = cents - base * n;
    return Array.from({ length: n }, (_, i) => (base + (i === n - 1 ? rest : 0)) / 100);
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  // lines: [{item_code, qty, price (document currency) | null}], opts {rate, shipping}
  function checkinPreview(lines, opts, itemsByCode) {
    const rate = Number(opts.rate);
    const ship = splitShipping(Number(opts.shipping) || 0, lines.length);
    return lines.map((l, i) => {
      const code = String(l.item_code || "").trim().toUpperCase();
      const item = itemsByCode.get(code) || null;
      const qty = Number(l.qty);
      const price = l.price === "" || l.price == null ? null : Number(l.price);
      const before = item ? Number(item.current_qty) || 0 : 0;
      const oldCost = item && item.unit_cost != null ? Number(item.unit_cost) : null;
      const paid = price != null && qty > 0 && rate > 0 ? r6((price + (ship[i] || 0) / qty) * rate) : null;
      let avg;
      if (before > 0 && (oldCost || 0) > 0 && paid != null) avg = r6((before * oldCost + qty * paid) / (before + qty));
      else avg = paid != null ? paid : oldCost;
      const used = paid != null ? paid : oldCost;
      return { item_code: code, item, isNew: !item, qty, price, shipAlloc: ship[i], paid, before, after: r6(before + (qty || 0)),
        oldCost, avgAfter: avg, value: Math.round((qty || 0) * (used || 0) * 100) / 100 };
    });
  }

  // One status per item for the list: out of stock first, then the Kanban
  // rule (kanban.js, the same one Freedom uses), then "no cost".
  function rensonStatus(item, kanbanState) {
    const qty = Number(item.current_qty) || 0;
    const k = kanbanState ? kanbanState(item).state : "unset";
    return { out: qty <= 0, kanban: k, noCost: item.unit_cost == null };
  }

  window.ORYX_RENSON_CORE = { splitPartCode, parseRensonSheet, excelDate, readJobList, buildRensonCheckout, RENSON_BARS, METRES_TO_BARS,
    splitShipping, checkinPreview, rensonStatus };
})();

// ======================================================================
// The page (Admins only, while the pilot flag is on). Tests load the core
// above without a document.
//
// Same workflow as Freedom, kept apart (user, 2026-11-02): Master Inventory
// list (Show filter, Kanban colours, value, Extract .xlsx), item panel
// (history, Adjust, Kanban levels), Check-in (supplier document typed in,
// currency + rate, shipping, new items, weighted average cost), Check-out
// (FP Pro job list PDF, or lines typed by hand), Movements, opening Import.
// Every write goes through a renson_* database function; nothing here
// touches a Freedom table. Sidebar: "Freedom" / "Renson (pilot)" under
// Master Inventory (Admins only, while the pilot is on).
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
  const money = (x) => Number(x || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const qtyFmt = (x) => Number(x || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const today = () => new Date().toISOString().slice(0, 10);
  const KANBAN = window.ORYX_KANBAN || null;
  const kState = KANBAN ? (i) => KANBAN.kanbanState(i) : null;
  const CURRENCIES = ["AED", "EUR", "USD", "AUD", "GBP"];
  const TYPE_LABEL = { check_out: "Check-out", check_in: "Check-in", adjustment: "Adjustment", opening_import: "Opening stock" };

  const newOut = () => ({ file: null, hash: "", job: "", result: null, skip: new Set(), busy: false, reading: false, manual: false, lines: [{ item_code: "", qty: "" }] });
  const newIn = () => ({ supplier: "Renson", invoice: "", po: "", date: today(), currency: "EUR", rate: "", rateNote: "", shipping: "",
    lines: [{ item_code: "", qty: "", price: "", desc: "", unit: "" }], busy: false });
  const ui = { mode: "freedom", tab: "inventory", items: [], lastImport: null, moves: [], loading: false, loadError: "", q: "", show: "all",
    file: null, hash: "", parsed: null, msg: null, busy: false, out: newOut(), cin: newIn() };
  const byCode = () => new Map(ui.items.map((i) => [String(i.item_code).toUpperCase(), i]));

  // Ask the database first: Admin AND pilot flag on. Anything else = nothing appears.
  sb.rpc("renson_access").then(({ data, error }) => {
    if (error || data !== true) return;
    mount();
  });

  let view, sub, freedomSub = "";
  function mount() {
    const style = document.createElement("style");
    style.textContent = `
.rn-pick{display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; color:var(--brand)}
.rn-pick select{border:1px solid #C5D0D4; border-radius:10px; padding:8px 10px; font:inherit; font-weight:600; background:var(--white); color:var(--brand)}
#v-master-inventory.rn-on .page-body > :not(#rnBody), #v-master-inventory.rn-on #miExtractBtn{display:none !important}
#v-master-inventory:not(.rn-on) #rnBody{display:none}
nav.side-nav .rn-sub{display:flex; flex-direction:column; gap:2px; margin:0 0 4px 30px}
nav.side-nav .rn-sub button{font-size:13.5px; padding:7px 12px; min-height:0}
nav.side-nav .rn-sub button.rn-sub-on{background:rgba(255,255,255,0.1); color:var(--white); font-weight:600}
.side-collapsed nav.side-nav .rn-sub{display:none}
@media (max-width:900px){nav.side-nav .rn-sub{display:none}}
.rn-pill{display:inline-block; margin-left:8px; padding:2px 10px; border-radius:999px; background:#FEF3C7; color:#92400E; font-size:12px; font-weight:600; vertical-align:middle}
.rn-badge{display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap}
.rn-badge.out{background:#FEE2E2; color:#991B1B}.rn-badge.critical{background:#FEE2E2; color:#991B1B}.rn-badge.low{background:#FEF3C7; color:#92400E}
.rn-badge.nocost{background:#F0F3F5; color:#334155}.rn-badge.ok{background:#DCFCE7; color:#166534}
.rn-tabs{display:flex; gap:8px; margin:0 0 18px; flex-wrap:wrap}
.rn-tabs button{border:1px solid #C5D0D4; background:var(--white); color:var(--brand); border-radius:10px; padding:8px 14px; font:inherit; cursor:pointer}
.rn-tabs button.on{background:var(--brand); color:#fff; border-color:var(--brand)}
.rn-kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr)); gap:12px; margin-bottom:16px}
.rn-kpis .kpi{background:var(--white); border:1px solid #DCE3E6}
.rn-tools{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px}
.rn-tools input[type=search]{flex:1 1 240px; border:1px solid #C5D0D4; border-radius:10px; padding:9px 12px; font:inherit}
.rn-in{border:1px solid #C5D0D4; border-radius:10px; padding:8px 10px; font:inherit; background:var(--white); min-width:0}
.rn-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:12px; margin-bottom:14px}
.rn-grid label{display:flex; flex-direction:column; gap:4px; font-size:13px; font-weight:600; color:var(--brand)}
.rn-wrap{overflow:auto; border:1px solid #DCE3E6; border-radius:12px; background:var(--white)}
.rn-table{width:100%; border-collapse:collapse; font-size:14px}
.rn-table th,.rn-table td{padding:9px 12px; border-bottom:1px solid #EEF2F4; text-align:left; vertical-align:top}
.rn-table th{font-size:12.5px; color:var(--text-muted); font-weight:600; background:#F7F9FA; position:sticky; top:0}
.rn-table td.r,.rn-table th.r{text-align:right; white-space:nowrap}
.rn-table tfoot td{font-weight:700; background:#F7F9FA}
.rn-table .rn-alt{display:block; font-size:12px; color:var(--text-muted)}
.rn-table tr.rn-zero td{color:var(--text-muted)}
.rn-table tr[data-rn-item]{cursor:pointer}
.rn-table tr[data-rn-item]:hover td{background:#F7F9FA}
.rn-table tr.kb-low td{background:#FEF3C7; color:#92400E}.rn-table tr.kb-critical td{background:#FEE2E2; color:#991B1B}
.rn-table td .rn-in{width:100%; min-width:70px; box-sizing:border-box}
.rn-table td .rn-in.mono{min-width:120px}
.rn-table td .rn-num{width:90px; text-align:right}
.rn-msg{border-radius:12px; padding:12px 14px; margin:0 0 14px}
.rn-msg.ok{background:#DCFCE7; color:#166534}.rn-msg.bad{background:#FEE2E2; color:#991B1B}.rn-msg.info{background:#E0F2FE; color:#075985}
.rn-issues{list-style:none; padding:0; margin:0 0 14px; display:grid; gap:6px}
.rn-issues li{border-radius:10px; padding:8px 12px; font-size:14px}
.rn-issues li.error{background:#FEE2E2; color:#991B1B}.rn-issues li.warning{background:#FEF3C7; color:#92400E}.rn-issues li.note{background:#F0F3F5; color:#334155}
.rn-file{display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:14px}
.rn-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:14px}
.rn-link{background:none; border:none; color:var(--brand); text-decoration:underline; cursor:pointer; font:inherit; padding:0}
.rn-danger{background:none; border:none; color:var(--danger); text-decoration:underline; cursor:pointer; font:inherit; padding:0}
#rnItemDlg{border:none; border-radius:16px; padding:0; width:min(760px,96vw); max-height:92vh}
#rnItemDlg::backdrop{background:rgba(11,42,54,.45)}
#rnItemDlg .rn-dlg{padding:22px 24px; overflow:auto; max-height:92vh}
#rnItemDlg h2{margin:0 0 2px; font-size:20px; color:var(--brand)}
#rnItemDlg h3{margin:18px 0 8px; font-size:15px; color:var(--brand)}
#rnItemDlg .rn-close{float:right}
`;
    document.head.appendChild(style);

    view = $("#v-master-inventory");
    const head = view && $(".page-head", view), pageBody = view && $(".page-body", view);
    if (!head || !pageBody) return;
    // In-page dropdown (kept) ...
    const pick = document.createElement("label");
    pick.className = "rn-pick";
    pick.innerHTML = `Inventory <select id="rnInventory" aria-label="Inventory"><option value="freedom">Freedom</option><option value="renson">Renson (pilot)</option></select>`;
    const actions = $(".page-actions", head);
    if (actions) actions.insertBefore(pick, actions.firstChild); else head.appendChild(pick);
    // ... and the sidebar submenu under Master Inventory (user, 2026-11-02:
    // "displayed under the Renson submenu"). Not nav button[data-v], so
    // app.js / the reload logic never treat them as pages of their own.
    const miBtn = $('nav button[data-v="master-inventory"]');
    if (miBtn) {
      const subNav = document.createElement("div");
      subNav.className = "rn-sub";
      subNav.innerHTML = `<button type="button" data-rn-mode="freedom" title="Freedom inventory">Freedom</button>
        <button type="button" data-rn-mode="renson" title="Renson inventory (pilot, Admins only)">Renson (pilot)</button>`;
      miBtn.after(subNav);
      subNav.addEventListener("click", (e) => {
        const b = e.target.closest("[data-rn-mode]");
        if (!b) return;
        if (!view.classList.contains("on")) miBtn.click();   // opens Master Inventory the usual way
        setMode(b.dataset.rnMode);
      });
      document.querySelectorAll("nav button[data-v]").forEach((b) => b.addEventListener("click", () => setTimeout(markSub, 0)));
    }
    const box = document.createElement("div");
    box.id = "rnBody";
    pageBody.insertBefore(box, pageBody.firstChild);
    sub = $(".page-head p", view);
    freedomSub = sub ? sub.textContent : "";

    const dlg = document.createElement("dialog");
    dlg.id = "rnItemDlg";
    dlg.innerHTML = `<div class="rn-dlg" id="rnItemBody"></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("click", onDlgClick);
    dlg.addEventListener("change", onDlgChange);
    dlg.addEventListener("input", onDlgInput);

    $("#rnInventory").addEventListener("change", (e) => setMode(e.target.value));
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onChange);

    let last = null;
    try { last = sessionStorage.getItem("oryx_mi_inventory"); } catch (e) { last = null; }
    if (last === "renson") setMode("renson");
    markSub();
  }

  function setMode(which) {
    const ren = which === "renson";
    ui.mode = ren ? "renson" : "freedom";
    $("#rnInventory").value = ui.mode;
    view.classList.toggle("rn-on", ren);
    if (sub) sub.innerHTML = ren ? `Renson stock <span class="rn-pill">Pilot · Admins only</span> Kept apart from Freedom; nothing here changes Freedom stock.` : esc(freedomSub);
    try { sessionStorage.setItem("oryx_mi_inventory", ui.mode); } catch (e) { /* private mode */ }
    markSub();
    if (ren) load();
  }
  function markSub() {
    const open = view && view.classList.contains("on");
    document.querySelectorAll("nav .rn-sub [data-rn-mode]").forEach((b) => b.classList.toggle("rn-sub-on", !!open && b.dataset.rnMode === ui.mode));
  }

  async function load() {
    ui.loading = true; ui.loadError = ""; render();
    const [items, imports, moves] = await Promise.all([
      sb.from("renson_items").select("*").order("item_code").order("id"),
      sb.from("renson_imports").select("*").order("created_at", { ascending: false }).limit(1),
      sb.from("renson_transactions").select("*").neq("type", "opening_import").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(500),
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
  const TABS = [["inventory", "Inventory"], ["checkin", "Check-in"], ["checkout", "Check-out"], ["moves", "Movements"], ["import", "Import stock file"]];

  function render() {
    const body = $("#rnBody");
    if (!body) return;
    const tabs = `<div class="rn-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" data-rn-tab="${k}" class="${ui.tab === k ? "on" : ""}">${t}</button>`).join("")}</div>`;
    const msg = ui.msg ? `<div class="rn-msg ${ui.msg[0]}">${esc(ui.msg[1])}</div>` : "";
    if (ui.loading) { body.innerHTML = tabs + `<div class="card">Loading Renson inventory…</div>`; return; }
    if (ui.loadError) { body.innerHTML = tabs + `<div class="rn-msg bad">Could not read the Renson inventory: ${esc(ui.loadError)}</div>`; return; }
    const draw = { inventory: inventoryHtml, checkin: checkinHtml, checkout: checkoutHtml, moves: movesHtml }[ui.tab] || importHtml;
    body.innerHTML = tabs + msg + draw() + codeList();
    if (ui.tab === "checkin") updateCheckin();
    if (ui.tab === "checkout") updateManualOut();
  }
  const codeList = () => `<datalist id="rnCodes">${ui.items.map((i) => `<option value="${esc(i.item_code)}">${esc(i.description)}</option>`).join("")}</datalist>`;

  // ------------------------------------------------------------ inventory
  function statusOf(i) { return R.rensonStatus(i, kState); }
  function badges(i) {
    const s = statusOf(i), b = [];
    if (s.out) b.push(`<span class="rn-badge out">Out of stock</span>`);
    else if (s.kanban === "critical") b.push(`<span class="rn-badge critical">Critical stock</span>`);
    else if (s.kanban === "low") b.push(`<span class="rn-badge low">Low stock</span>`);
    if (s.noCost) b.push(`<span class="rn-badge nocost">No cost</span>`);
    return b.join(" ");
  }
  const SHOW = [["all", "All items", () => true], ["normal", "Normal", (s) => s.kanban === "normal"], ["low", "Low stock", (s) => s.kanban === "low"],
    ["critical", "Critical stock", (s) => s.kanban === "critical"], ["out", "Out of stock", (s) => s.out], ["nocost", "No cost", (s) => s.noCost]];
  function shownItems() {
    const q = ui.q.toLowerCase();
    const f = (SHOW.find((x) => x[0] === ui.show) || SHOW[0])[2];
    return ui.items.filter((i) => f(statusOf(i)) && (!q || [i.item_code, i.alt_codes, i.description, i.product_size, i.colour].join(" ").toLowerCase().includes(q)));
  }

  function inventoryHtml() {
    const all = ui.items;
    if (!all.length) {
      return `<div class="card"><p>No Renson items yet.</p><p class="muted">Import the Renson stock file to start the pilot.</p>
        <div class="rn-actions"><button type="button" class="btn-yellow" data-rn-tab="import">Import stock file</button></div></div>`;
    }
    const value = all.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const st = all.map(statusOf);
    const withStock = all.filter((i) => Number(i.current_qty) > 0);
    const noCost = withStock.filter((i) => i.unit_cost == null).length;
    const rows = shownItems();
    const shownValue = rows.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const imp = ui.lastImport;
    const opts = SHOW.map(([k, t, f]) => { const n = st.filter(f).length; return (k === "all" || n || ui.show === k) ? `<option value="${k}" ${ui.show === k ? "selected" : ""}>${t} (${n})</option>` : ""; }).join("");
    return `<div class="rn-kpis">
        ${tile("Stock value", aed(value), "stock × unit cost")}
        ${tile("Items", String(all.length), withStock.length + " with stock")}
        ${tile("Out of stock", String(st.filter((s) => s.out).length))}
        ${tile("Low / critical", String(st.filter((s) => !s.out && (s.kanban === "low" || s.kanban === "critical")).length), "Kanban levels")}
        ${tile("Stock without a cost", String(noCost), noCost ? "value counted as 0" : "")}
      </div>
      ${imp ? `<p class="muted">Opening stock from <b>${esc(imp.file_name)}</b>, imported ${esc(when(imp.created_at))} by ${esc(imp.imported_by_name || "—")}.</p>` : ""}
      <div class="rn-tools"><label class="rn-pick">Show <select id="rnShow" class="rn-in" aria-label="Show">${opts}</select></label>
        <input type="search" id="rnSearch" placeholder="Search code, description, size, colour" value="${esc(ui.q)}" aria-label="Search Renson items">
        <span class="muted">${rows.length} of ${all.length} items</span>
        <button type="button" class="btn-outline" data-rn-act="extract">Extract (.xlsx)</button></div>
      <div class="rn-wrap"><table class="rn-table"><thead><tr>
        <th>Code</th><th>Description</th><th>Size</th><th>Colour</th><th>Unit</th><th class="r">Stock</th><th class="r">Unit cost</th><th class="r">Value</th><th>Status</th></tr></thead>
        <tbody>${rows.map((i) => { const s = statusOf(i); const cls = !s.out && (s.kanban === "low" || s.kanban === "critical") ? "kb-" + s.kanban : (Number(i.current_qty) > 0 ? "" : "rn-zero");
          return `<tr class="${cls}" data-rn-item="${i.id}" title="Open ${esc(i.item_code)}">
          <td class="mono">${esc(i.item_code)}</td>
          <td>${esc(i.description)}${i.alt_codes ? `<span class="rn-alt">Also ${esc(i.alt_codes)}</span>` : ""}</td>
          <td>${esc(i.product_size || "")}</td><td>${esc(i.colour || "")}</td><td>${esc(i.unit || "")}</td>
          <td class="r">${qtyFmt(i.current_qty)}</td>
          <td class="r">${i.unit_cost == null ? `<span class="muted">No cost</span>` : aed(i.unit_cost)}</td>
          <td class="r">${aed(i.current_value)}</td><td>${badges(i)}</td></tr>`; }).join("")}</tbody>
        <tfoot><tr><td colspan="7">${rows.length < all.length ? "Total of the items shown" : "Total stock value"}</td><td class="r">${aed(shownValue)}</td><td></td></tr></tfoot>
      </table></div>`;
  }

  async function extract() {
    try { await loadXlsx(); } catch (e) { ui.msg = ["bad", "Could not load the Excel library."]; return render(); }
    const X = window.XLSX;
    const rows = shownItems().map((i) => { const s = statusOf(i); return {
      Code: i.item_code, "Other code": i.alt_codes || "", Description: i.description, Size: i.product_size || "", Colour: i.colour || "", Unit: i.unit || "",
      Stock: Number(i.current_qty), "Unit cost (AED)": i.unit_cost == null ? "" : Number(i.unit_cost), "Value (AED)": Number(i.current_value),
      "Kanban trigger": i.buffer_level == null ? "" : Number(i.buffer_level), "Critical level": i.critical_level == null ? "" : Number(i.critical_level),
      Status: s.out ? "Out of stock" : s.kanban === "critical" ? "Critical stock" : s.kanban === "low" ? "Low stock" : s.noCost ? "No cost" : "" }; });
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows), "Renson inventory");
    X.writeFile(wb, `Renson inventory ${today()}.xlsx`);
  }

  // ------------------------------------------------------------ item panel
  const panel = { item: null, history: [], busy: false, msg: null, adj: { mode: "set_to", qty: "", cost: "", reason: "" }, lv: null };
  async function openItem(id) {
    const item = ui.items.find((i) => String(i.id) === String(id));
    if (!item) return;
    panel.item = item; panel.history = null; panel.msg = null; panel.adj = { mode: "set_to", qty: "", cost: "", reason: "" };
    panel.lv = { t: item.buffer_level == null ? "" : String(Number(item.buffer_level)), c: item.critical_level == null ? "" : String(Number(item.critical_level)) };
    drawItem();
    const dlg = $("#rnItemDlg");
    if (!dlg.open) dlg.showModal();
    const { data, error } = await sb.from("renson_transactions").select("*").eq("item_id", item.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(200);
    panel.history = error ? [] : data || [];
    if (error) panel.msg = ["bad", "Could not read the history: " + error.message];
    drawItem();
  }
  function adjPreview() {
    const a = panel.adj, it = panel.item, q = Number(a.qty);
    if (a.qty === "" || !isFinite(q)) return "";
    const before = Number(it.current_qty) || 0;
    const after = a.mode === "set_to" ? q : a.mode === "add" ? before + q : before - q;
    return `Stock ${qtyFmt(before)} → ${qtyFmt(after)} (${after - before >= 0 ? "+" : ""}${qtyFmt(after - before)})`;
  }
  function drawItem() {
    const it = panel.item, b = $("#rnItemBody");
    if (!it || !b) return;
    const averaged = (panel.history || []).some((m) => m.unit_cost_after != null);
    const lastIn = (panel.history || []).find((m) => m.type === "check_in" && m.unit_cost != null);
    const a = panel.adj;
    b.innerHTML = `<button type="button" class="btn-outline rn-close" data-rn-dlg="close">Close</button>
      <h2>${esc(it.item_code)}</h2><p class="muted" style="margin:0 0 12px">${esc(it.description)}${it.alt_codes ? ` · also ${esc(it.alt_codes)}` : ""}</p>
      ${panel.msg ? `<div class="rn-msg ${panel.msg[0]}">${esc(panel.msg[1])}</div>` : ""}
      <div class="rn-kpis">${tile("Stock", qtyFmt(it.current_qty) + (it.unit ? " " + it.unit : ""))}
        ${tile(averaged ? "Average cost" : "Unit cost", it.unit_cost == null ? "No cost" : aed(it.unit_cost), lastIn ? `Last bought ${aed(lastIn.unit_cost)} · ${when(lastIn.created_at).slice(0, 11)}` : "")}
        ${tile("Value", aed(it.current_value))}<div class="kpi"><span>Status</span><b style="font-size:15px">${badges(it) || "Normal"}</b></div></div>
      <h3>Adjust stock</h3>
      <div class="rn-grid">
        <label>What<select class="rn-in" id="rnAdjMode"><option value="set_to" ${a.mode === "set_to" ? "selected" : ""}>Stock count (set the stock to)</option>
          <option value="add" ${a.mode === "add" ? "selected" : ""}>Add</option><option value="take_out" ${a.mode === "take_out" ? "selected" : ""}>Take out</option></select></label>
        <label>${a.mode === "set_to" ? "Counted quantity (new stock)" : a.mode === "add" ? "Quantity to add" : "Quantity to take out"}<input class="rn-in" id="rnAdjQty" inputmode="decimal" value="${esc(a.qty)}"></label>
        ${a.mode === "add" ? `<label>Unit cost (AED, optional)<input class="rn-in" id="rnAdjCost" inputmode="decimal" value="${esc(a.cost)}" placeholder="${it.unit_cost == null ? "" : Number(it.unit_cost)}"></label>` : ""}
        <label>Reason<input class="rn-in" id="rnAdjReason" maxlength="300" value="${esc(a.reason)}" placeholder="e.g. Stock count 2 Nov"></label>
      </div>
      <p class="muted" id="rnAdjPreview">${esc(adjPreview())}</p>
      <div class="rn-actions" style="margin-top:0"><button type="button" class="btn-yellow" data-rn-dlg="adjust" ${panel.busy ? "disabled" : ""}>Save adjustment</button></div>
      <h3>Kanban levels</h3>
      <div class="rn-grid"><label>Kanban trigger level<input class="rn-in" id="rnLvT" inputmode="decimal" value="${esc(panel.lv.t)}" placeholder="none"></label>
        <label>Critical level (optional)<input class="rn-in" id="rnLvC" inputmode="decimal" value="${esc(panel.lv.c)}" placeholder="none"></label></div>
      <div class="rn-actions" style="margin-top:0"><button type="button" class="btn-outline" data-rn-dlg="levels" ${panel.busy ? "disabled" : ""}>Save levels</button>
        <button type="button" class="rn-link" data-rn-dlg="levels-clear">Remove both</button></div>
      <h3>History</h3>
      ${panel.history == null ? `<p class="muted">Loading…</p>` : !panel.history.length ? `<p class="muted">No movements yet.</p>` :
        `<div class="rn-wrap"><table class="rn-table"><thead><tr><th>When</th><th>What</th><th class="r">Change</th><th class="r">Stock after</th><th class="r">Value</th><th>By</th></tr></thead><tbody>
        ${panel.history.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(TYPE_LABEL[m.type] || m.type)}<span class="rn-alt">${esc(moveRef(m))}</span></td>
          <td class="r">${signed(m)}</td><td class="r">${qtyFmt(m.qty_after)}</td><td class="r">${aed(Math.abs(Number(m.value) || 0))}</td><td>${esc(m.performed_by_name || "")}</td></tr>`).join("")}
        </tbody></table></div>`}`;
  }
  const signed = (m) => { const d = Number(m.qty_after) - Number(m.qty_before); return (d > 0 ? "+" : d < 0 ? "−" : "") + qtyFmt(Math.abs(d)) + (m.unit ? " " + m.unit : ""); };
  function moveRef(m) {
    if (m.type === "check_out") return `Job ${m.job_number || ""}${m.source ? " · " + m.source : ""}`;
    if (m.type === "check_in") return `${m.supplier || ""}${m.invoice_number ? " · " + m.invoice_number : ""}${m.original_unit_cost != null ? ` · ${m.original_currency} ${money(m.original_unit_cost)} each` : ""}${m.is_new_item ? " · new item" : ""}`;
    if (m.type === "adjustment") return `${m.reference || ""}${m.reason ? ": " + m.reason : ""}`;
    return m.reference || "";
  }
  function onDlgInput(e) {
    const id = e.target.id, a = panel.adj;
    if (id === "rnAdjQty") a.qty = e.target.value.trim();
    else if (id === "rnAdjCost") a.cost = e.target.value.trim();
    else if (id === "rnAdjReason") a.reason = e.target.value;
    else if (id === "rnLvT") panel.lv.t = e.target.value;
    else if (id === "rnLvC") panel.lv.c = e.target.value;
    const p = $("#rnAdjPreview"); if (p) p.textContent = adjPreview();
  }
  function onDlgChange(e) {
    if (e.target.id === "rnAdjMode") { panel.adj.mode = e.target.value; panel.adj.cost = ""; drawItem(); }
  }
  async function onDlgClick(e) {
    if (e.target === $("#rnItemDlg")) return $("#rnItemDlg").close();
    const t = e.target.closest("[data-rn-dlg]");
    if (!t || panel.busy) return;
    const act = t.dataset.rnDlg, it = panel.item;
    if (act === "close") return $("#rnItemDlg").close();
    if (act === "adjust") {
      const a = panel.adj, q = Number(a.qty);
      if (a.qty === "" || !isFinite(q) || (a.mode === "set_to" ? q < 0 : q <= 0)) { panel.msg = ["bad", "Type a quantity" + (a.mode === "set_to" ? " (0 or more)." : " above 0.")]; return drawItem(); }
      if (!a.reason.trim()) { panel.msg = ["bad", "Type the reason."]; return drawItem(); }
      const c = a.mode === "add" && a.cost !== "" ? Number(a.cost) : null;
      if (c != null && (!isFinite(c) || c < 0)) { panel.msg = ["bad", "The unit cost must be a number, 0 or more."]; return drawItem(); }
      panel.busy = true; drawItem();
      const { data, error } = await sb.rpc("renson_adjust", { p: { item_code: it.item_code, mode: a.mode, qty: q, unit_cost: c, reason: a.reason.trim() } });
      panel.busy = false;
      if (error) { panel.msg = ["bad", (/no_change/.test(error.message) ? "That is already the stock." : "Not saved: " + error.message)]; return drawItem(); }
      panel.msg = ["ok", `Saved: stock ${qtyFmt(data.qty_before)} → ${qtyFmt(data.qty_after)}.`];
      return refreshAfterPanel();
    }
    if (act === "levels" || act === "levels-clear") {
      let parsed = { ok: true, trigger: null, critical: null };
      if (act === "levels") parsed = KANBAN ? KANBAN.parseLevels(panel.lv.t, panel.lv.c) : { ok: false, error: "Kanban rule not loaded." };
      if (!parsed.ok) { panel.msg = ["bad", parsed.error]; return drawItem(); }
      panel.busy = true; drawItem();
      const { error } = await sb.rpc("renson_set_levels", { p_item_code: it.item_code, p_trigger: parsed.trigger, p_critical: parsed.critical });
      panel.busy = false;
      panel.msg = error ? ["bad", "Not saved: " + error.message] : ["ok", parsed.trigger == null ? "Kanban levels removed." : "Kanban levels saved."];
      if (error) return drawItem();
      return refreshAfterPanel();
    }
  }
  async function refreshAfterPanel() {
    const id = panel.item.id, msg = panel.msg;
    await load();
    await openItem(id);
    panel.msg = msg; drawItem();
  }

  // ------------------------------------------------------------ Check-in
  // The supplier's document typed in (no Renson invoice layout to read yet):
  // supplier, invoice, date, currency + rate, shipping, one line per item.
  // A code that is not a Renson item becomes a NEW item (description + unit).
  function cinPreview() {
    const c = ui.cin;
    const lines = c.lines.filter((l) => l.item_code.trim() || l.qty !== "");
    const rate = c.currency === "AED" ? 1 : Number(c.rate);
    return { lines, rows: R.checkinPreview(lines.map((l) => ({ item_code: l.item_code, qty: l.qty, price: l.price })), { rate, shipping: c.shipping }, byCode()), rate };
  }
  function cinProblems(pv) {
    const c = ui.cin, out = [];
    if (!c.supplier.trim()) out.push("Type the supplier.");
    if (c.currency !== "AED" && !(Number(c.rate) > 0)) out.push(`Type the exchange rate (AED for 1 ${c.currency}).`);
    if (c.shipping !== "" && !(Number(c.shipping) >= 0)) out.push("Shipping must be a number.");
    if (!pv.rows.length) out.push("Add at least one line.");
    const seen = new Set();
    pv.rows.forEach((r, i) => {
      const n = i + 1;
      if (!r.item_code) out.push(`Line ${n}: type the item code.`);
      else if (seen.has(r.item_code)) out.push(`Line ${n}: ${r.item_code} is on two lines. Put it on one line.`);
      seen.add(r.item_code);
      if (!(r.qty > 0)) out.push(`Line ${n}: type a quantity above 0.`);
      if (r.price != null && !(r.price >= 0)) out.push(`Line ${n}: the unit price must be a number.`);
      if (r.isNew && r.item_code && !pv.lines[i].desc.trim()) out.push(`Line ${n}: ${r.item_code} is not a Renson item yet. Type its description to add it as a new item.`);
    });
    return out;
  }
  // Inputs are drawn once; typing only updates the worked-out cells in place
  // (updateCheckin), so a box is never replaced while someone is typing in
  // the next one.
  function cinCells(r) {
    const has = r && r.item_code;
    return {
      item: r && r.item ? esc(r.item.description) : has ? `<span class="rn-badge low">New item</span>` : `<span class="muted">Type or pick a code</span>`,
      ship: r && r.shipAlloc ? money(r.shipAlloc) : "",
      paid: has ? (r.paid == null ? `<span class="muted">${r.oldCost == null ? "No price" : "Own cost"}</span>` : aed(r.paid)) : "",
      after: has && r.qty > 0 ? qtyFmt(r.before) + " → " + qtyFmt(r.after) : "",
      avg: has && r.qty > 0 ? (r.avgAfter == null ? `<span class="muted">No cost</span>` : aed(r.avgAfter)) : "",
      value: has ? aed(r.value) : "",
    };
  }
  function rowPreview(pv, i) { const k = pv.lines.indexOf(ui.cin.lines[i]); return k < 0 ? null : pv.rows[k]; }
  function checkinHtml() {
    const c = ui.cin, pv = cinPreview();
    const cur = c.currency;
    return `<div class="card">
      <div class="rn-grid">
        <label>Supplier<input class="rn-in" id="rnInSupplier" value="${esc(c.supplier)}" maxlength="120"></label>
        <label>Invoice no.<input class="rn-in" id="rnInInvoice" value="${esc(c.invoice)}" maxlength="60"></label>
        <label>PO / LPO no.<input class="rn-in" id="rnInPo" value="${esc(c.po)}" maxlength="60"></label>
        <label>Invoice date<input class="rn-in" type="date" id="rnInDate" value="${esc(c.date)}"></label>
        <label>Currency<select class="rn-in" id="rnInCur">${CURRENCIES.map((x) => `<option ${x === cur ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        ${cur === "AED" ? "" : `<label>Rate (AED for 1 ${cur})<input class="rn-in" id="rnInRate" inputmode="decimal" value="${esc(c.rate)}"><span class="muted" style="font-weight:400"><span id="rnInRateNote">${esc(c.rateNote)}</span> <button type="button" class="rn-link" data-rn-act="in-rate">Get rate</button></span></label>`}
        <label>Shipping / freight (${cur}, whole invoice)<input class="rn-in" id="rnInShip" inputmode="decimal" value="${esc(c.shipping)}" placeholder="0"></label>
      </div>
      <div class="rn-wrap"><table class="rn-table"><thead><tr><th style="min-width:150px">Item code</th><th>Item</th><th class="r" style="width:90px">Qty</th>
        <th class="r" style="width:120px">Unit price (${cur})</th><th class="r">Shipping share</th><th class="r">Price paid (AED)</th><th class="r">Stock after</th><th class="r">Average cost after</th><th class="r">Value</th><th></th></tr></thead><tbody>
        ${c.lines.map((l, i) => { const r = rowPreview(pv, i), cl = cinCells(r); return `<tr>
          <td><input class="rn-in mono" list="rnCodes" data-rn-in="item_code" data-i="${i}" value="${esc(l.item_code)}" aria-label="Item code line ${i + 1}"></td>
          <td><span data-rn-cell="item" data-i="${i}">${cl.item}</span>
              <span data-rn-new="${i}" style="display:${r && r.isNew ? "block" : "none"}">
              <input class="rn-in" data-rn-in="desc" data-i="${i}" value="${esc(l.desc)}" placeholder="Description of the new item" style="margin-top:4px;min-width:200px">
              <input class="rn-in" data-rn-in="unit" data-i="${i}" value="${esc(l.unit)}" placeholder="Unit (pc, bar, m)" style="margin-top:4px;width:140px"></span></td>
          <td><input class="rn-in rn-num" inputmode="decimal" data-rn-in="qty" data-i="${i}" value="${esc(l.qty)}" aria-label="Quantity line ${i + 1}"></td>
          <td><input class="rn-in rn-num" inputmode="decimal" data-rn-in="price" data-i="${i}" value="${esc(l.price)}" placeholder="none" aria-label="Unit price line ${i + 1}"></td>
          <td class="r" data-rn-cell="ship" data-i="${i}">${cl.ship}</td><td class="r" data-rn-cell="paid" data-i="${i}">${cl.paid}</td>
          <td class="r" data-rn-cell="after" data-i="${i}">${cl.after}</td><td class="r" data-rn-cell="avg" data-i="${i}">${cl.avg}</td>
          <td class="r" data-rn-cell="value" data-i="${i}">${cl.value}</td>
          <td><button type="button" class="rn-danger" data-rn-act="in-del" data-i="${i}" aria-label="Remove line ${i + 1}">Remove</button></td></tr>`; }).join("")}
        </tbody><tfoot><tr><td colspan="8">Value checked in (AED)</td><td class="r" id="rnInTotal"></td><td></td></tr></tfoot></table></div>
      <div class="rn-actions"><button type="button" class="btn-outline" data-rn-act="in-add">+ Add line</button></div>
      <ul class="rn-issues" id="rnInProbs" style="margin-top:14px"></ul>
      <p class="muted">Average cost: the same rule as Freedom. (stock × cost on file + received × price paid) ÷ (stock + received); no stock or no cost on file = the price paid; no price = the item keeps its cost.</p>
      <div class="rn-actions"><button type="button" class="btn-yellow" id="rnInConfirm" data-rn-act="in-confirm"></button>
        <button type="button" class="btn-outline" data-rn-act="in-clear" ${c.busy ? "disabled" : ""}>Clear</button></div></div>`;
  }
  function updateCheckin() {
    const box = $("#rnBody");
    if (!box || ui.tab !== "checkin" || !$("#rnInConfirm")) return;
    const c = ui.cin, pv = cinPreview(), probs = cinProblems(pv);
    c.lines.forEach((l, i) => {
      const r = rowPreview(pv, i), cl = cinCells(r);
      for (const k of Object.keys(cl)) { const el = box.querySelector(`[data-rn-cell="${k}"][data-i="${i}"]`); if (el && el.innerHTML !== cl[k]) el.innerHTML = cl[k]; }
      const nw = box.querySelector(`[data-rn-new="${i}"]`); if (nw) nw.style.display = r && r.isNew ? "block" : "none";
    });
    $("#rnInTotal").textContent = aed(pv.rows.reduce((s, r) => s + r.value, 0));
    const pl = $("#rnInProbs");
    pl.innerHTML = probs.map((p) => `<li class="warning">${esc(p)}</li>`).join("");
    pl.style.display = probs.length ? "" : "none";
    const btn = $("#rnInConfirm");
    btn.disabled = !!(probs.length || c.busy);
    btn.textContent = c.busy ? "Saving…" : `Confirm Check-in (${pv.rows.length} lines)`;
  }
  async function getRate() {
    const c = ui.cin, FP = window.ORYX_FP;
    if (c.currency === "AED") return;
    if (!FP || !FP.fetchCheckinExchangeRate) { c.rateNote = "Rate service not ready; type the rate."; const el = $("#rnInRateNote"); if (el) el.textContent = c.rateNote; return; }
    const note = (t) => { c.rateNote = t; const el = $("#rnInRateNote"); if (el) el.textContent = t; };
    note("Getting the rate…");
    const r = await FP.fetchCheckinExchangeRate(c.currency, c.date || null).catch(() => null);
    if (r && r.rate > 0) {
      c.rate = String(Math.round(r.rate * 1e6) / 1e6); note(`Rate of ${r.rateDate || "today"} (currency-api).`);
      const el = $("#rnInRate"); if (el && !el.matches(":focus")) el.value = c.rate;
    } else note("No rate found; type it.");
    updateCheckin();
  }
  async function confirmCheckin() {
    const c = ui.cin, pv = cinPreview();
    if (cinProblems(pv).length || c.busy) return;
    const newOnes = pv.rows.filter((r) => r.isNew).length;
    if (!window.confirm(`Check in ${pv.rows.length} lines to the RENSON stock${newOnes ? ` (${newOnes} new item${newOnes > 1 ? "s" : ""})` : ""}?\n\nFreedom stock is not changed.`)) return;
    c.busy = true; render();
    const lines = pv.rows.map((r, i) => {
      const l = pv.lines[i];
      return { item_code: r.item_code, qty: r.qty, original_unit_cost: r.price, shipping_allocated: r.shipAlloc,
        new_item: r.isNew ? { description: l.desc.trim(), unit: l.unit.trim() } : undefined };
    });
    const { data, error } = await sb.rpc("renson_checkin", { p: { supplier: c.supplier.trim(), invoice_number: c.invoice.trim(), po_number: c.po.trim(),
      document_date: c.date || null, currency: c.currency, exchange_rate: pv.rate, lines } });
    c.busy = false;
    if (error) {
      const m = /renson_not_allowed/.test(error.message) ? "Not allowed: the Renson pilot is for Admins only (or is switched off)." : "The Check-in was refused: " + error.message;
      ui.msg = ["bad", m + " Nothing was saved."];
      return render();
    }
    ui.msg = ["ok", `Checked in ${data.lines} lines${data.new_items ? ` (${data.new_items} new item${data.new_items > 1 ? "s" : ""})` : ""}, value ${aed(data.total_value)}.`];
    ui.cin = newIn(); ui.tab = "moves";
    await load();
  }

  // ------------------------------------------------------------ Check-out
  // Renson job list (FP Pro PDF) -> preview -> Confirm, or lines typed by
  // hand (like Freedom's manual entry). Only Renson items are taken off.
  function checkoutHtml() {
    const o = ui.out;
    if (!ui.items.length) return `<div class="card"><p>Import the Renson stock file first.</p></div>`;
    let h = `<div class="card"><div class="rn-file">
        <input type="file" id="rnOutFile" accept="application/pdf,.pdf" aria-label="Renson job list (PDF)" ${o.busy ? "disabled" : ""}>
        <span class="muted">${o.file ? esc(o.file.name) : "Choose the Renson job list (PDF from FP Pro)"}</span>
        <span class="muted">or</span><button type="button" class="rn-link" data-rn-act="out-manual">${o.manual ? "Hide the lines typed by hand" : "Type the lines by hand"}</button></div>`;
    if (o.reading) h += `<p class="muted">Reading the job list…</p>`;
    const jobBox = `<div class="rn-tools"><label class="field-label" for="rnOutJob" style="margin:0">Job number</label>
          <input id="rnOutJob" class="rn-in" value="${esc(o.job)}" maxlength="60" style="width:180px"></div>`;
    if (o.manual && !o.result) {
      h += jobBox + `<div class="rn-wrap"><table class="rn-table"><thead><tr><th style="min-width:150px">Item code</th><th>Renson item</th><th class="r" style="width:110px">Qty</th><th class="r">Stock now</th><th class="r">Stock after</th><th class="r">Value</th><th></th></tr></thead><tbody>
        ${o.lines.map((l, i) => `<tr><td><input class="rn-in mono" list="rnCodes" data-rn-out="item_code" data-i="${i}" value="${esc(l.item_code)}" aria-label="Item code line ${i + 1}"></td>
          <td data-rn-ocell="item" data-i="${i}"></td>
          <td><input class="rn-in rn-num" inputmode="decimal" data-rn-out="qty" data-i="${i}" value="${esc(l.qty)}" aria-label="Quantity line ${i + 1}"></td>
          <td class="r" data-rn-ocell="now" data-i="${i}"></td><td class="r" data-rn-ocell="after" data-i="${i}"></td><td class="r" data-rn-ocell="value" data-i="${i}"></td>
          <td><button type="button" class="rn-danger" data-rn-act="out-del" data-i="${i}">Remove</button></td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="5">Value taken off</td><td class="r" id="rnOutTotal"></td><td></td></tr></tfoot></table></div>
        <div class="rn-actions"><button type="button" class="btn-outline" data-rn-act="out-add">+ Add line</button></div>
        <ul class="rn-issues" id="rnOutProbs" style="margin-top:14px"></ul>
        <div class="rn-actions"><button type="button" class="btn-yellow" id="rnOutConfirm" data-rn-act="out-confirm-manual"></button>
          <button type="button" class="btn-outline" data-rn-act="out-cancel" ${o.busy ? "disabled" : ""}>Cancel</button></div>`;
      return h + `</div>`;
    }
    const r = o.result;
    if (r) {
      const take = r.lines.filter((l) => !o.skip.has(l.item_code));
      const value = take.reduce((s, l) => s + l.value, 0);
      const below = take.filter((l) => l.after < 0).length;
      h += jobBox + `<div class="rn-kpis">
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
            <td class="r">${on ? qtyFmt(l.after) + (l.after < 0 ? ` <span class="rn-badge out">Below zero, allowed</span>` : "") : qtyFmt(l.before)}</td>
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
  function updateManualOut() {
    const box = $("#rnBody"), btn = $("#rnOutConfirm");
    if (!box || !btn) return;
    const o = ui.out, items = byCode();
    let val = 0;
    o.lines.forEach((l, i) => {
      const it = items.get(l.item_code.trim().toUpperCase()), q = Number(l.qty), after = it ? Number(it.current_qty) - q : 0;
      const v = it && q > 0 ? Math.round(q * (Number(it.unit_cost) || 0) * 100) / 100 : 0; val += v;
      const cells = {
        item: it ? esc(it.description) : l.item_code.trim() ? `<span class="rn-badge out">Not a Renson item</span>` : "",
        now: it ? qtyFmt(it.current_qty) : "",
        after: it && q > 0 ? qtyFmt(after) + (after < 0 ? ` <span class="rn-badge out">Below zero, allowed</span>` : "") : "",
        value: it && q > 0 ? (it.unit_cost == null ? `<span class="muted">No cost</span>` : aed(v)) : "",
      };
      for (const k of Object.keys(cells)) { const el = box.querySelector(`[data-rn-ocell="${k}"][data-i="${i}"]`); if (el && el.innerHTML !== cells[k]) el.innerHTML = cells[k]; }
    });
    $("#rnOutTotal").textContent = aed(val);
    const probs = manualProblems(), pl = $("#rnOutProbs");
    pl.innerHTML = probs.map((p) => `<li class="warning">${esc(p)}</li>`).join("");
    pl.style.display = probs.length ? "" : "none";
    btn.disabled = !!(probs.length || o.busy);
    btn.textContent = o.busy ? "Saving…" : `Confirm Check-out (${o.lines.filter((l) => l.item_code.trim()).length} lines)`;
  }
  function manualProblems() {
    const o = ui.out, items = byCode(), out = [], seen = new Set();
    if (!o.job.trim()) out.push("Type the job number.");
    const used = o.lines.filter((l) => l.item_code.trim() || l.qty !== "");
    if (!used.length) out.push("Add at least one line.");
    used.forEach((l, i) => {
      const code = l.item_code.trim().toUpperCase();
      if (!code) out.push(`Line ${i + 1}: type the item code.`);
      else if (!items.has(code)) out.push(`Line ${i + 1}: ${code} is not a Renson item.`);
      else if (seen.has(code)) out.push(`Line ${i + 1}: ${code} is on two lines. Put it on one line.`);
      seen.add(code);
      if (!(Number(l.qty) > 0)) out.push(`Line ${i + 1}: type a quantity above 0.`);
    });
    return out;
  }

  function movesHtml() {
    if (!ui.moves.length) return `<div class="card"><p>No Renson movements yet.</p><p class="muted">The opening stock import is not listed here.</p></div>`;
    return `<div class="rn-wrap"><table class="rn-table"><thead><tr><th>When</th><th>Type</th><th>Code</th><th>Item</th>
      <th class="r">Change</th><th class="r">Stock before → after</th><th class="r">Value</th><th>By</th></tr></thead><tbody>
      ${ui.moves.map((m) => { const it = ui.items.find((i) => i.id === m.item_id); return `<tr data-rn-item="${m.item_id}"><td>${esc(when(m.created_at))}</td>
        <td>${esc(TYPE_LABEL[m.type] || m.type)}</td><td class="mono">${esc(m.item_code)}</td>
        <td>${esc(it ? it.description : "")}<span class="rn-alt">${esc(moveRef(m))}</span></td>
        <td class="r">${signed(m)}</td>
        <td class="r">${qtyFmt(m.qty_before)} → ${qtyFmt(m.qty_after)}</td><td class="r">${aed(Math.abs(Number(m.value) || 0))}</td><td>${esc(m.performed_by_name || "")}</td></tr>`; }).join("")}
      </tbody></table></div>`;
  }

  async function readJobFile(f) {
    const o = ui.out;
    ui.msg = null; o.result = null; o.skip = new Set(); o.file = f; o.hash = ""; o.manual = false;
    if (!/\.pdf$/i.test(f.name)) { ui.msg = ["bad", "Choose the job list PDF."]; o.file = null; return render(); }
    const FP = window.ORYX_FP;
    if (!FP || !FP.extractPdfText) { ui.msg = ["bad", "The PDF reader is not ready yet. Try again in a moment."]; o.file = null; return render(); }
    o.reading = true; render();
    try {
      const [text, hash] = await Promise.all([FP.extractPdfText(f), FP.pdfFingerprint(f)]);
      o.result = R.buildRensonCheckout(text, byCode());
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

  async function sendCheckout(job, lines, doc) {
    const o = ui.out;
    if (!window.confirm(`Take ${lines.length} lines off the RENSON stock for job ${job}?\n\nFreedom stock is not changed.`)) return;
    o.busy = true; render();
    const { data, error } = await sb.rpc("renson_checkout", { p: Object.assign({ job_number: job, lines }, doc || {}) });
    o.busy = false;
    if (error) {
      const m = /already_checked_out/.test(error.message) ? "This job list was already checked out."
        : /renson_not_allowed/.test(error.message) ? "Not allowed: the Renson pilot is for Admins only (or is switched off)."
        : "The Check-out was refused: " + error.message;
      ui.msg = ["bad", m + " Nothing was saved."];
      return render();
    }
    ui.msg = ["ok", `Checked out job ${job}: ${data.lines} lines, value ${aed(data.total_value)}${data.below_zero ? `, ${data.below_zero} item(s) now below zero` : ""}.`];
    ui.out = newOut();
    ui.tab = "moves";
    await load();
  }
  function confirmCheckout() {
    const o = ui.out, r = o.result;
    if (!r || o.busy) return;
    const job = (o.job || "").trim();
    if (!job) { ui.msg = ["bad", "Type the job number first."]; return render(); }
    const take = r.lines.filter((l) => !o.skip.has(l.item_code));
    if (!take.length) return;
    return sendCheckout(job, take.map((l) => ({ item_code: l.item_code, qty: l.qty, unit: l.unit, source: l.source })),
      { document_name: o.file.name, document_hash: o.hash });
  }
  function confirmManualCheckout() {
    const o = ui.out;
    if (manualProblems().length || o.busy) return;
    const items = byCode();
    const lines = o.lines.filter((l) => l.item_code.trim()).map((l) => { const it = items.get(l.item_code.trim().toUpperCase());
      return { item_code: it.item_code, qty: Number(l.qty), unit: it.unit || "", source: "Typed by hand" }; });
    return sendCheckout(o.job.trim(), lines, null);
  }

  // ------------------------------------------------------------ events
  function onClick(e) {
    const t = e.target.closest("[data-rn-tab],[data-rn-act]");
    if (!t) {
      const row = e.target.closest("tr[data-rn-item]");
      if (row) openItem(row.dataset.rnItem);
      return;
    }
    if (t.dataset.rnTab) {
      ui.tab = t.dataset.rnTab; ui.msg = null; render();
      if (ui.tab === "checkin" && ui.cin.currency !== "AED" && !ui.cin.rate) getRate();
      return;
    }
    const act = t.dataset.rnAct, i = Number(t.dataset.i);
    if (act === "cancel") { ui.file = null; ui.parsed = null; ui.hash = ""; ui.msg = null; return render(); }
    if (act === "confirm") return confirmImport();
    if (act === "reset") return resetPilot();
    if (act === "extract") return extract();
    if (act === "out-confirm") return confirmCheckout();
    if (act === "out-confirm-manual") return confirmManualCheckout();
    if (act === "out-cancel") { ui.out = newOut(); ui.msg = null; return render(); }
    if (act === "out-manual") { const m = !ui.out.manual; ui.out = newOut(); ui.out.manual = m; ui.msg = null; return render(); }
    if (act === "out-add") { ui.out.lines.push({ item_code: "", qty: "" }); return render(); }
    if (act === "out-del") { ui.out.lines.splice(i, 1); if (!ui.out.lines.length) ui.out.lines.push({ item_code: "", qty: "" }); return render(); }
    if (act === "in-add") { ui.cin.lines.push({ item_code: "", qty: "", price: "", desc: "", unit: "" }); return render(); }
    if (act === "in-del") { ui.cin.lines.splice(i, 1); if (!ui.cin.lines.length) ui.cin.lines.push({ item_code: "", qty: "", price: "", desc: "", unit: "" }); return render(); }
    if (act === "in-clear") { ui.cin = newIn(); ui.msg = null; return render(); }
    if (act === "in-rate") return getRate();
    if (act === "in-confirm") return confirmCheckin();
  }
  const IN_FIELDS = { rnInSupplier: "supplier", rnInInvoice: "invoice", rnInPo: "po", rnInDate: "date", rnInRate: "rate", rnInShip: "shipping" };
  function onInput(e) {
    const el = e.target;
    if (el.id === "rnOutJob") { ui.out.job = el.value; return updateManualOut(); }
    if (IN_FIELDS[el.id]) { ui.cin[IN_FIELDS[el.id]] = el.value; return updateCheckin(); }
    if (el.dataset.rnIn) { ui.cin.lines[Number(el.dataset.i)][el.dataset.rnIn] = el.value; return updateCheckin(); }
    if (el.dataset.rnOut) { ui.out.lines[Number(el.dataset.i)][el.dataset.rnOut] = el.value; return updateManualOut(); }
    if (el.id === "rnSearch") {
      ui.q = el.value;
      const pos = el.selectionStart;
      render();
      const s = $("#rnSearch"); if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    }
  }
  function onChange(e) {
    const el = e.target;
    if (el.id === "rnFile" && el.files && el.files[0]) return readFile(el.files[0]);
    if (el.id === "rnOutFile" && el.files && el.files[0]) return readJobFile(el.files[0]);
    if (el.id === "rnShow") { ui.show = el.value; return render(); }
    if (el.id === "rnInCur") { ui.cin.currency = el.value; ui.cin.rate = ""; ui.cin.rateNote = ""; render(); return getRate(); }
    if (el.id === "rnInDate") { ui.cin.date = el.value; updateCheckin(); return ui.cin.currency !== "AED" ? getRate() : undefined; }
    // Typed fields are kept and the sums updated on input (no redraw).
    if (IN_FIELDS[el.id] || el.dataset.rnIn || el.dataset.rnOut || el.id === "rnOutJob") return;
    if (el.dataset && el.dataset.rnTake) {
      const c = el.dataset.rnTake;
      if (el.checked) ui.out.skip.delete(c); else ui.out.skip.add(c);
      render();
    }
  }

  // ------------------------------------------------------------ import
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
