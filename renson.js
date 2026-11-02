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

  // One Check-out (2026-11-02): Freedom's own rows for a Renson job list
  // still contain the Renson lines (as unmatched rows -- no code is in both
  // inventories). Take out those that the Renson reader turned into Renson
  // lines: rows with a Renson item code, and the code-less bar rows whose
  // description is a known Renson bar. Everything else (e.g. 910010 Patio
  // Mesh = Freedom, Box Sections, an unknown bar) stays with Freedom exactly
  // as Freedom handles it. No Renson lines = the same array, untouched.
  function splitRensonRows(rows, rensonLines) {
    if (!rensonLines || !rensonLines.length) return rows;
    const codes = new Set(rensonLines.map((l) => String(l.item_code).toUpperCase()));
    const bars = new Set(RENSON_BARS.map((b) => b.desc));
    return rows.filter((r) => {
      if (r.itemId) return true;
      if (r.code && codes.has(String(r.code).toUpperCase())) return false;
      if (r.kind === "bar" && !r.code && bars.has(lowKey(r.description))) return false;
      return true;
    });
  }

  // ------------------------------------------------------------ Renson documents
  // One Check-in for every stock category (2026-11-02). Renson NV's own
  // documents (order confirmation, quotation; samples SUP_1/3/03/04/05) share
  // one layout: header values BEFORE their labels ("179607 Order number"),
  // an "Overview" (pos, code, [description], qty, unit, total net) and a
  // "Detail" (pos, code, qty, unit, total gross, [total net], description,
  // "Product price|Net price  P  EUR  /  1  UNIT"). Numbers are 1.736,91.
  // The macOS-printed sample spaces out the footer letters, so detection
  // ignores spaces.
  function isRensonDocument(text) {
    const t = String(text || "").replace(/\s+/g, "").toLowerCase();
    return t.includes("rensonnv") || /renson\.(be|eu)/.test(t) || t.includes("rensonlogistics");
  }
  const euNum = (s) => { const n = Number(String(s).replace(/\./g, "").replace(",", ".")); return isFinite(n) ? n : null; };
  const FOOTER = /^(Renson NV|\+3256|VAT BE|R e n s|VA T|\d+\/\d+$|Order confirmation|Quotation|Invoice|Credit note|\d{6,} \d{2}\.\d{2}\.\d{4}$)/i;

  function readRensonDocument(text) {
    const raw = String(text || "").split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    // A line the PDF split in two ("001000 19489 ROLL SERGÉ ... (30 M)" then
    // "1,00 M 1.112,64") is joined back.
    const lines = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k], nx = raw[k + 1] || "";
      if (/^\d{6} \S+ /.test(l) && !/[\d.]+,\d+ [A-Z]{1,4}( [\d.]+,\d+){1,2}$/.test(l) && /^[\d.]+,\d+ [A-Z]{1,4}( [\d.]+,\d+){1,2}$/.test(nx)) { lines.push(l + " " + nx); k++; }
      else lines.push(l);
    }
    const val = (label) => { const re = new RegExp("^(.+?) " + label + "$", "i"); const l = lines.find((x) => re.test(x)); return l ? re.exec(l)[1].trim() : ""; };
    const head = {
      docType: (lines.find((l) => /^(Order confirmation|Quotation|Invoice|Delivery note|Credit note)$/i.test(l)) || "").trim(),
      number: val("(?:Order|Quotation|Invoice|Delivery|Document) number"),
      date: val("(?:Confirmation|Quotation|Invoice|Order|Delivery|Document) date"),
      currency: (val("Currency") || "").toUpperCase(),
      projectRef: val("Project reference"), orderRef: val("Order reference"),
    };
    const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(head.date);
    head.isoDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : "";
    const tb = lines.find((l) => / Total before VAT$/i.test(l));
    head.totalBeforeVat = tb ? euNum(tb.replace(/ Total before VAT$/i, "")) : null;

    // Overview: "001000 19504 21154/0202 WHITE 2100MM 1,00 M 1.736,91" or
    // "001000 27409 25,00 PC 572,50" + the description on the next line.
    const over = new Map();
    let inOver = false, last = null;
    for (const l of lines) {
      if (/^Overview$/i.test(l)) { inOver = true; continue; }
      if (/^Detail$/i.test(l) || / Total before VAT$/i.test(l)) { inOver = false; last = null; continue; }
      if (!inOver) continue;
      const m = /^(\d{6}) (\S+) (?:(.*?) )?([\d.]+,\d+) ([A-Z]{1,4}) ([\d.]+,\d+)$/.exec(l);
      if (m) { last = { pos: m[1], code: m[2].toUpperCase(), description: (m[3] || "").trim(), qty: euNum(m[4]), unit: m[5], net: euNum(m[6]) }; over.set(m[1], last); continue; }
      if (last && !last.description && !FOOTER.test(l) && !/^Material|^%$/.test(l)) last.description = l;
    }
    // Detail: gross total and what the price is per.
    let inDet = false, cur = null;
    const det = new Map();
    for (const l of lines) {
      if (/^Detail$/i.test(l)) { inDet = true; continue; }
      if (!inDet) continue;
      const m = /^(\d{6}) (\S+) ([\d.]+,\d+) ([A-Z]{1,4}) ([\d.]+,\d+)(?: ([\d.]+,\d+))?$/.exec(l);
      if (m) { cur = { pos: m[1], gross: euNum(m[5]), net: m[6] ? euNum(m[6]) : euNum(m[5]), description: "" }; det.set(m[1], cur); continue; }
      if (!cur) continue;
      const p = /^(Product|Net|Service) price ([\d.]+,\d+) [A-Z]{3} \/ ([\d.,]+) ([A-Z]{1,4})\b/i.exec(l) || /^Price (service) ([\d.]+,\d+) [A-Z]{3} \/ ([\d.,]+) ([A-Z]{1,4})\b/i.exec(l);
      if (p && cur.price == null) { cur.price = euNum(p[2]); cur.per = euNum(p[3]) || 1; cur.priceUnit = p[4]; cur.service = /service/i.test(p[1]); continue; }
      if (!cur.description && !FOOTER.test(l) && !/Old material nr|Commodity code|discount|^[\d.,\s-]+$/i.test(l)) cur.description = l;
    }
    const items = [...over.values()].map((o) => {
      const d = det.get(o.pos) || {};
      const description = o.description || d.description || "";
      return Object.assign({}, o, { description, gross: d.gross != null ? d.gross : null,
        price: d.price != null ? d.price : null, per: d.per || 1, priceUnit: d.priceUnit || null,
        // A charge, not stock (sample: 903000 1000017 "Pickup Fee", "Price
        // service"): goes to the shipping / extra costs, spread like Freedom's.
        charge: !!d.service || /\b(pick ?up|freight|transport|shipping|packing|handling)\b.*\b(fee|cost|charge)s?\b|^(pick ?up|freight|transport) fee/i.test(description) });
    });
    const sum = Math.round(items.reduce((s, i) => s + (i.net || 0), 0) * 100) / 100;
    head.charges = Math.round(items.filter((i) => i.charge).reduce((s, i) => s + (i.net || 0), 0) * 100) / 100;
    return { head, items, sum, totalMatches: head.totalBeforeVat == null ? null : Math.abs(sum - head.totalBeforeVat) < 0.011 };
  }

  // Stock quantity for one document line (user's answers 2026-11-02:
  // cartons / rolls are converted with the document's OWN figures; fabric
  // "M" lines are asked). Returns {qty, unit, how} or {ask, why}.
  function rensonStockQty(it) {
    const len = /-\s*(\d+(?:[.,]\d+)?)\s*M\b/i.exec(it.description || "");
    const metresPerRoll = len ? euNum(len[1]) : null;
    if (it.unit === "M") return { ask: "metres", why: "Fabric: the document says " + it.qty + " M for the whole line. Type the metres to add to stock." };
    if (it.unit === "PC") return { qty: it.qty, unit: "pc", how: `${it.qty} PC` };
    // ROL / CAR (or anything else): count the price units in the gross total.
    if (it.price && it.gross != null) {
      const n = Math.round((it.gross / it.price) * it.per * 1000) / 1000;
      const whole = Math.abs(n - Math.round(n)) < 0.01;
      if (whole && it.priceUnit === "PC") return { qty: Math.round(n), unit: "pc", how: `${it.qty} ${it.unit} = ${Math.round(n)} pcs (€${it.gross} gross ÷ €${it.price} per PC)` };
      if (whole && (it.priceUnit === "ROL" || it.priceUnit === "CAR") && metresPerRoll) return { qty: Math.round(n) * metresPerRoll, unit: "m", how: `${it.qty} ${it.unit} = ${Math.round(n)} rolls × ${metresPerRoll} m = ${Math.round(n) * metresPerRoll} m` };
      if (whole && it.priceUnit === "M") return { qty: n, unit: "m", how: `${it.qty} ${it.unit} = ${n} m` };
    }
    if (metresPerRoll && it.unit === "ROL") return { qty: it.qty * metresPerRoll, unit: "m", how: `${it.qty} ROL × ${metresPerRoll} m = ${it.qty * metresPerRoll} m` };
    return { ask: it.unit === "ROL" ? "metres" : "pieces", why: `${it.qty} ${it.unit}: the document doesn't say how much is in each ${it.unit === "ROL" ? "roll" : "carton"}. Type the ${it.unit === "ROL" ? "metres" : "pieces"} to add to stock.` };
  }

  window.ORYX_RENSON_CORE = { isRensonDocument, readRensonDocument, rensonStockQty, splitRensonRows, splitPartCode, parseRensonSheet, excelDate, readJobList, buildRensonCheckout, RENSON_BARS, METRES_TO_BARS,
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

  const ui = { mode: "freedom", tab: "inventory", items: [], lastImport: null, moves: [], loading: false, loadError: "", q: "", show: "all",
    file: null, hash: "", parsed: null, msg: null, busy: false };
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
    // Shared Check-out page: Renson lines of a Renson job list.
    window.ORYX_RENSON_CHECKOUT = RENSON_CHECKOUT;
    window.ORYX_RENSON_CHECKIN = RENSON_CHECKIN;
    document.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.rnTake || !el.closest("#fpRenson")) return;
      if (el.checked) co.skip.delete(el.dataset.rnTake); else co.skip.add(el.dataset.rnTake);
      coDraw();
      if (window.ORYX_FP && window.ORYX_FP.render && window.ORYX_FP.state && window.ORYX_FP.state.rows) window.ORYX_FP.render();
    });
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onChange);

    let last = null;
    try { last = sessionStorage.getItem("oryx_mi_inventory"); } catch (e) { last = null; }
    if (last === "renson") setMode("renson");
    markSub();
  }

  // ------------------------------------------------------------ shared Check-out
  // One Check-out page for every stock category (2026-11-02, user's request,
  // answers: each line to its own stock; Renson lines refused for regular
  // users; the old Renson Check-out tab removed). fp-checkout.js calls this
  // object (window.ORYX_RENSON_CHECKOUT, only set for Admins with the pilot
  // on): split() after a job list is read, count() for the Confirm button,
  // commit() AFTER the Freedom part was saved, doneHtml()/wireDone() for the
  // done message, reset(). Renson lines are drawn in #fpRenson under the
  // Freedom preview; Freedom's own rows and buttons are not touched.
  const co = { lines: [], skip: new Set(), hash: "", file: null, already: false, retry: null };
  function coBox() {
    let b = $("#fpRenson");
    const out = $("#fpOut");
    if (!b && out) { b = document.createElement("div"); b.id = "fpRenson"; out.after(b); }
    return b;
  }
  function coDraw() {
    const b = coBox();
    if (!b) return;
    if (!co.lines.length) { b.innerHTML = ""; return; }
    const take = co.lines.filter((l) => !co.skip.has(l.item_code));
    const value = take.reduce((x, l) => x + l.value, 0);
    b.innerHTML = `<div class="card" style="margin-top:16px">
      <div class="fp-section-h">Renson items <span class="rn-pill">Renson stock · Admin pilot</span></div>
      <p class="small muted">These lines are Renson items: they come off the <b>Renson</b> stock, not Freedom. The lines above stay with Freedom.</p>
      ${co.already ? `<div class="rn-msg bad">The Renson items of this job list were already checked out. Confirm will refuse them.</div>` : ""}
      <div class="rn-wrap"><table class="rn-table"><thead><tr><th>Take off</th><th>Code</th><th>Renson item</th><th>From the job list</th>
        <th class="r">Qty</th><th class="r">Stock now</th><th class="r">Stock after</th><th class="r">Value</th></tr></thead><tbody>
        ${co.lines.map((l) => { const on = !co.skip.has(l.item_code); return `<tr class="${on ? "" : "rn-zero"}">
          <td><input type="checkbox" data-rn-take="${esc(l.item_code)}" ${on ? "checked" : ""} aria-label="Take off ${esc(l.item_code)}"></td>
          <td class="mono">${esc(l.item_code)}</td><td>${esc(l.description)}</td><td class="muted">${esc(l.source)}</td>
          <td class="r">${qtyFmt(l.qty)} ${esc(l.unit)}</td><td class="r">${qtyFmt(l.before)}</td>
          <td class="r">${on ? qtyFmt(l.after) + (l.after < 0 ? ` <span class="rn-badge out">Below zero, allowed</span>` : "") : qtyFmt(l.before)}</td>
          <td class="r">${l.unit_cost == null ? `<span class="muted">No cost</span>` : aed(l.value)}</td></tr>`; }).join("")}
        </tbody><tfoot><tr><td colspan="7">Renson value taken off (${take.length} of ${co.lines.length} lines)</td><td class="r">${aed(value)}</td></tr></tfoot></table></div></div>`;
  }
  async function coSend(job) {
    const take = co.lines.filter((l) => !co.skip.has(l.item_code));
    const { data, error } = await sb.rpc("renson_checkout", { p: {
      job_number: job, document_name: co.file ? co.file.name : null, document_hash: co.hash || null,
      lines: take.map((l) => ({ item_code: l.item_code, qty: l.qty, unit: l.unit, source: l.source })) } });
    if (error) {
      const m = /already_checked_out/.test(error.message) ? "The Renson items of this job list were already checked out."
        : /renson_not_allowed/.test(error.message) ? "Renson is for Admins only (or switched off)." : error.message;
      return { ok: false, message: "Renson items NOT taken off: " + m };
    }
    return { ok: true, data };
  }
  const RENSON_CHECKOUT = {
    async split(text, rows, hash) {
      co.lines = []; co.skip = new Set(); co.hash = hash || ""; co.file = (window.ORYX_FP && window.ORYX_FP.state && window.ORYX_FP.state.pdfFile) || null;
      co.already = false; co.retry = null;
      const { data, error } = await sb.from("renson_items").select("*").order("item_code").order("id");
      if (error) throw new Error("Could not read the Renson inventory: " + error.message);
      const items = new Map((data || []).map((i) => [String(i.item_code).toUpperCase(), i]));
      const res = R.buildRensonCheckout(text, items);
      co.lines = res.lines;
      if (co.lines.length && hash) {
        const prev = await sb.from("renson_transactions").select("id").eq("type", "check_out").eq("document_hash", hash).limit(1);
        co.already = !!(prev.data && prev.data.length);
      }
      coDraw();
      return R.splitRensonRows(rows, co.lines);
    },
    count() { return co.lines.filter((l) => !co.skip.has(l.item_code)).length; },
    async commit({ job }) {
      const r = await coSend(job);
      if (!r.ok) co.retry = job;
      return r;
    },
    doneHtml(r) {
      if (r.ok) return `<p class="small"><b>Renson:</b> ${r.data.lines} Renson item${r.data.lines === 1 ? "" : "s"} taken off the Renson stock, value ${aed(r.data.total_value)}${r.data.below_zero ? `, ${r.data.below_zero} now below zero` : ""}.</p>`;
      return `<div class="rn-msg bad" id="rnCoFail">${esc(r.message)} The Freedom part above is saved. <button type="button" class="btn-outline" id="rnCoRetry">Try again</button></div>`;
    },
    wireDone(container) {
      $("#fpRenson") && ($("#fpRenson").innerHTML = "");
      const btn = container.querySelector("#rnCoRetry");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const r = await coSend(co.retry);
        const box = container.querySelector("#rnCoFail");
        box.outerHTML = RENSON_CHECKOUT.doneHtml(r);
        if (!r.ok) RENSON_CHECKOUT.wireDone(container);
      });
    },
    reset() { co.lines = []; co.skip = new Set(); co.hash = ""; co.file = null; co.already = false; co.retry = null; coDraw(); },
  };

  // ------------------------------------------------------------ shared Check-in
  // One Check-in page for every stock category (2026-11-02). A Renson NV
  // document (order confirmation / quotation) uploaded on the Check-in page
  // is handed here by fp-checkin-screen.js (window.ORYX_RENSON_CHECKIN, only
  // set for Admins with the pilot on); Freedom's own reading is skipped for
  // it. Lines are matched to Renson items by code; cartons / rolls become
  // pieces / metres from the document's own figures (rensonStockQty); fabric
  // "M" lines and anything the document doesn't say are typed in (user's
  // answers); a code that is not a Renson item yet is offered as a NEW item.
  // Charges such as the Pickup Fee go to shipping, spread like Freedom's.
  // Saved by renson_checkin (Freedom's average-cost rule, once per document).
  const ci = { doc: null, file: null, hash: "", lines: [], rate: "", rateNote: "", extraShip: "", busy: false, done: null, already: false };
  function ciBox() {
    let b = $("#ciRenson");
    const out = $("#ciOut");
    if (!b && out) { b = document.createElement("div"); b.id = "ciRenson"; out.after(b); b.addEventListener("input", ciOnInput); b.addEventListener("change", ciOnChange); b.addEventListener("click", ciOnClick); }
    return b;
  }
  const ciTaken = () => ci.lines.filter((l) => l.take);
  function ciPreview() {
    const take = ciTaken();
    const ship = (ci.doc ? ci.doc.head.charges || 0 : 0) + (Number(ci.extraShip) || 0);
    const rows = R.checkinPreview(take.map((l) => ({ item_code: l.code, qty: Number(l.qty), price: Number(l.qty) > 0 ? Math.round((l.net / Number(l.qty)) * 1e6) / 1e6 : null })),
      { rate: Number(ci.rate), shipping: ship }, byCode());
    return { take, rows, ship };
  }
  function ciProblems(pv) {
    const out = [];
    if (!(Number(ci.rate) > 0)) out.push(`Type the exchange rate (AED for 1 ${ci.doc.head.currency || "EUR"}).`);
    if (ci.extraShip !== "" && !(Number(ci.extraShip) >= 0)) out.push("Extra shipping must be a number.");
    if (!pv.take.length) out.push("Tick at least one line.");
    pv.take.forEach((l) => {
      if (!(Number(l.qty) > 0)) out.push(`${l.code}: ${l.ask ? l.why : "type the quantity for stock."}`);
      if (!l.item && !l.desc.trim()) out.push(`${l.code} is not a Renson item yet: type its description to add it as a new item.`);
    });
    if (ci.already) out.push("This document was already checked in. Confirm will be refused.");
    return out;
  }
  function ciDraw() {
    const b = ciBox();
    if (!b) return;
    if (!ci.doc) { b.innerHTML = ""; return; }
    if (ci.done) { b.innerHTML = ci.done; return; }
    const h = ci.doc.head, cur = h.currency || "EUR";
    b.innerHTML = `<div class="card" style="margin-top:16px">
      <div class="fp-section-h">Renson document <span class="rn-pill">Renson stock · Admin pilot</span></div>
      <p class="small muted">${esc(h.docType || "Document")} <b>${esc(h.number)}</b> of ${esc(h.date)} from Renson NV${h.orderRef ? ` · order reference ${esc(h.orderRef)}` : ""}. Everything here goes to the <b>Renson</b> stock, never Freedom.</p>
      <p class="small">${ci.doc.totalMatches ? `✓ The lines add up to the document's total before VAT (${esc(cur)} ${money(h.totalBeforeVat)}).` : `<span style="color:var(--danger)">✗ The lines (${esc(cur)} ${money(ci.doc.sum)}) do not add up to the document's total before VAT (${esc(cur)} ${money(h.totalBeforeVat)}). Check the document.</span>`}</p>
      <div class="rn-grid">
        <label>Rate (AED for 1 ${esc(cur)})<input class="rn-in" id="rciRate" inputmode="decimal" value="${esc(ci.rate)}"><span class="muted" style="font-weight:400"><span id="rciRateNote">${esc(ci.rateNote)}</span> <button type="button" class="rn-link" data-rci-act="rate">Get rate</button></span></label>
        <label>Charges on the document (${esc(cur)})<input class="rn-in" value="${money(h.charges || 0)}" disabled><span class="muted" style="font-weight:400">e.g. Pickup Fee; spread over the lines like Freedom's shipping</span></label>
        <label>Extra shipping / freight (${esc(cur)})<input class="rn-in" id="rciShip" inputmode="decimal" value="${esc(ci.extraShip)}" placeholder="0"></label>
      </div>
      <div class="rn-wrap"><table class="rn-table"><thead><tr><th>Take</th><th>Code</th><th>Renson item</th><th>On the document</th><th class="r">Qty for stock</th>
        <th class="r">Price paid (AED)</th><th class="r">Stock after</th><th class="r">Average cost after</th><th class="r">Value</th></tr></thead><tbody>
        ${ci.lines.map((l, i) => `<tr class="${l.take ? "" : "rn-zero"}">
          <td><input type="checkbox" data-rci="take" data-i="${i}" ${l.take ? "checked" : ""} aria-label="Take ${esc(l.code)}"></td>
          <td class="mono">${esc(l.code)}</td>
          <td>${l.item ? esc(l.item.description) + (l.item.unit ? `<span class="rn-alt">Stock unit: ${esc(l.item.unit)}</span>` : "") : `<span class="rn-badge low">New item</span>
            <input class="rn-in" data-rci="desc" data-i="${i}" value="${esc(l.desc)}" style="margin-top:4px;min-width:200px" aria-label="Description of new item ${esc(l.code)}">
            <input class="rn-in" data-rci="unit" data-i="${i}" value="${esc(l.unit)}" placeholder="pc / m / bar" style="margin-top:4px;width:120px" aria-label="Unit of new item ${esc(l.code)}">`}</td>
          <td class="muted">${esc(l.docDesc)}<span class="rn-alt">${esc(l.docQty)} · ${esc(cur)} ${money(l.net)}${l.how ? " · " + esc(l.how) : ""}</span>${l.ask ? `<span class="rn-alt" style="color:#92400E">${esc(l.why)}</span>` : ""}</td>
          <td class="r"><input class="rn-in rn-num" inputmode="decimal" data-rci="qty" data-i="${i}" value="${esc(l.qty)}" placeholder="${l.ask ? l.ask : ""}" aria-label="Quantity for stock ${esc(l.code)}"> <span class="muted">${esc(l.stockUnit || "")}</span></td>
          <td class="r" data-rci-cell="paid" data-i="${i}"></td><td class="r" data-rci-cell="after" data-i="${i}"></td>
          <td class="r" data-rci-cell="avg" data-i="${i}"></td><td class="r" data-rci-cell="value" data-i="${i}"></td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="8">Value checked in (AED)</td><td class="r" id="rciTotal"></td></tr></tfoot></table></div>
      <ul class="rn-issues" id="rciProbs" style="margin-top:14px"></ul>
      <p class="muted small">Average cost: the same rule as Freedom. Price paid = (document line total ÷ quantity for stock + share of charges) × rate.</p>
      <div class="rn-actions"><button type="button" class="btn-yellow" id="rciConfirm" data-rci-act="confirm"></button></div></div>`;
    ciUpdate();
  }
  function ciUpdate() {
    const b = $("#ciRenson"), btn = $("#rciConfirm");
    if (!b || !btn) return;
    const pv = ciPreview(), probs = ciProblems(pv);
    ci.lines.forEach((l, i) => {
      const k = pv.take.indexOf(l), r = k >= 0 ? pv.rows[k] : null;
      const cells = {
        paid: r && r.qty > 0 ? (r.paid == null ? "" : aed(r.paid)) : "",
        after: r && r.qty > 0 ? qtyFmt(r.before) + " → " + qtyFmt(r.after) : "",
        avg: r && r.qty > 0 ? (r.avgAfter == null ? `<span class="muted">No cost</span>` : aed(r.avgAfter)) : "",
        value: r && r.qty > 0 ? aed(r.value) : "",
      };
      for (const c of Object.keys(cells)) { const el = b.querySelector(`[data-rci-cell="${c}"][data-i="${i}"]`); if (el && el.innerHTML !== cells[c]) el.innerHTML = cells[c]; }
    });
    $("#rciTotal").textContent = aed(pv.rows.reduce((x, r) => x + (r.qty > 0 ? r.value : 0), 0));
    const pl = $("#rciProbs");
    pl.innerHTML = probs.map((p) => `<li class="warning">${esc(p)}</li>`).join("");
    pl.style.display = probs.length ? "" : "none";
    btn.disabled = !!(probs.length || ci.busy);
    btn.textContent = ci.busy ? "Saving…" : `Confirm Renson Check-in (${pv.take.length} lines)`;
  }
  async function ciGetRate() {
    const FP = window.ORYX_FP, cur = (ci.doc && ci.doc.head.currency) || "EUR";
    const note = (t) => { ci.rateNote = t; const el = $("#rciRateNote"); if (el) el.textContent = t; };
    if (cur === "AED") { ci.rate = "1"; return; }
    if (!FP || !FP.fetchCheckinExchangeRate) return note("Rate service not ready; type the rate.");
    note("Getting the rate…");
    const r = await FP.fetchCheckinExchangeRate(cur, ci.doc.head.isoDate || null).catch(() => null);
    if (r && r.rate > 0) {
      ci.rate = String(Math.round(r.rate * 1e6) / 1e6); note(`Rate of ${r.rateDate || "today"} (currency-api).`);
      const el = $("#rciRate"); if (el && !el.matches(":focus")) el.value = ci.rate;
    } else note("No rate found; type it.");
    ciUpdate();
  }
  function ciOnInput(e) {
    const el = e.target;
    if (el.id === "rciRate") ci.rate = el.value.trim();
    else if (el.id === "rciShip") ci.extraShip = el.value.trim();
    else if (el.dataset.rci && el.dataset.rci !== "take") ci.lines[Number(el.dataset.i)][el.dataset.rci] = el.value;
    ciUpdate();
  }
  function ciOnChange(e) {
    const el = e.target;
    if (el.dataset.rci === "take") { ci.lines[Number(el.dataset.i)].take = el.checked; el.closest("tr").classList.toggle("rn-zero", !el.checked); ciUpdate(); }
  }
  async function ciOnClick(e) {
    const t = e.target.closest("[data-rci-act]");
    if (!t) return;
    if (t.dataset.rciAct === "rate") return ciGetRate();
    if (t.dataset.rciAct !== "confirm" || ci.busy) return;
    const pv = ciPreview();
    if (ciProblems(pv).length) return;
    const h = ci.doc.head;
    const newOnes = pv.rows.filter((r) => r.isNew).length;
    if (!window.confirm(`Check in ${pv.take.length} lines to the RENSON stock${newOnes ? ` (${newOnes} new item${newOnes > 1 ? "s" : ""})` : ""}?\n\nFreedom stock is not changed.`)) return;
    ci.busy = true; ciUpdate();
    const lines = pv.take.map((l, k) => ({ item_code: l.code, qty: Number(l.qty), original_unit_cost: pv.rows[k].price, shipping_allocated: pv.rows[k].shipAlloc,
      new_item: l.item ? undefined : { description: l.desc.trim(), unit: l.unit.trim() } }));
    const { data, error } = await sb.rpc("renson_checkin", { p: { supplier: "Renson NV", invoice_number: h.number, po_number: h.orderRef || h.projectRef || "",
      document_date: h.isoDate || null, currency: h.currency || "EUR", exchange_rate: Number(ci.rate), document_name: ci.file ? ci.file.name : null, document_hash: ci.hash || null, lines } });
    ci.busy = false;
    if (error) {
      const m = /already_checked_in/.test(error.message) ? "This document was already checked in." : /renson_not_allowed/.test(error.message) ? "Renson is for Admins only (or switched off)." : error.message;
      const pl = $("#rciProbs"); pl.innerHTML = `<li class="error">Not saved: ${esc(m)} Nothing was changed.</li>`; pl.style.display = "";
      return ciUpdate();
    }
    ci.done = `<div class="fp-done"><h3>Renson Check-in confirmed — ${data.lines} line${data.lines === 1 ? "" : "s"}</h3>
      <p class="small">${esc(h.docType || "Document")} <b>${esc(h.number)}</b> checked in to the <b>Renson</b> stock${data.new_items ? `, ${data.new_items} new item${data.new_items > 1 ? "s" : ""} added` : ""}, value ${aed(data.total_value)}. Freedom stock was not changed. See Master Inventory → Renson → Movements.</p></div>`;
    ciDraw();
  }
  const RENSON_CHECKIN = {
    async open({ text, file, hash }) {
      ci.doc = R.readRensonDocument(text); ci.file = file; ci.hash = hash || ""; ci.done = null; ci.busy = false; ci.extraShip = ""; ci.rate = ""; ci.rateNote = "";
      const { data, error } = await sb.from("renson_items").select("*").order("item_code").order("id");
      if (error) throw new Error("Could not read the Renson inventory: " + error.message);
      ui.items = data || [];
      const items = byCode();
      ci.lines = ci.doc.items.filter((it) => !it.charge).map((it) => {
        const q = R.rensonStockQty(it), item = items.get(it.code) || null;
        return { code: it.code, item, docDesc: it.description, docQty: `${it.qty} ${it.unit}`, net: it.net, how: q.how || "", ask: q.ask || "", why: q.why || "",
          qty: q.ask ? "" : String(q.qty), stockUnit: q.unit || (q.ask === "metres" ? "m" : q.ask === "pieces" ? "pc" : ""), take: true,
          desc: item ? "" : it.description, unit: item ? "" : (q.unit || (q.ask === "metres" ? "m" : "pc")) };
      });
      if (hash) {
        const prev = await sb.from("renson_transactions").select("id").eq("type", "check_in").eq("document_hash", hash).limit(1);
        ci.already = !!(prev.data && prev.data.length);
      } else ci.already = false;
      ciDraw();
      await ciGetRate();
      return { lines: ci.lines.length, ask: ci.lines.filter((l) => l.ask).length, newItems: ci.lines.filter((l) => !l.item).length, totalMatches: ci.doc.totalMatches };
    },
    reset() { ci.doc = null; ci.lines = []; ci.done = null; ci.file = null; ci.hash = ""; ciDraw(); },
  };

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
  const TABS = [["inventory", "Inventory"], ["moves", "Movements"], ["import", "Import stock file"]];

  function render() {
    const body = $("#rnBody");
    if (!body) return;
    const tabs = `<div class="rn-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" data-rn-tab="${k}" class="${ui.tab === k ? "on" : ""}">${t}</button>`).join("")}</div>`;
    const msg = ui.msg ? `<div class="rn-msg ${ui.msg[0]}">${esc(ui.msg[1])}</div>` : "";
    if (ui.loading) { body.innerHTML = tabs + `<div class="card">Loading Renson inventory…</div>`; return; }
    if (ui.loadError) { body.innerHTML = tabs + `<div class="rn-msg bad">Could not read the Renson inventory: ${esc(ui.loadError)}</div>`; return; }
    const draw = { inventory: inventoryHtml, moves: movesHtml }[ui.tab] || importHtml;
    body.innerHTML = tabs + msg + draw() + codeList();
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
    const rows = shownItems();
    const shownValue = rows.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const opts = SHOW.map(([k, t, f]) => { const n = st.filter(f).length; return (k === "all" || n || ui.show === k) ? `<option value="${k}" ${ui.show === k ? "selected" : ""}>${t} (${n})</option>` : ""; }).join("");
    // Same headline as Freedom's Master Inventory (#miTally): value without
    // the fils, then items / codes (user's request 2026-11-02).
    return `<div class="mi-kpis">
        <span class="mi-kpi"><b>${esc(aed(value).replace(/\.\d\d$/, ""))}</b> stock value</span>
        <span class="mi-kpi"><b>${all.length}</b> items in ${new Set(all.map((i) => String(i.item_code).toUpperCase())).size} codes</span>
      </div>
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

  // ------------------------------------------------------------ events
  function onClick(e) {
    const t = e.target.closest("[data-rn-tab],[data-rn-act]");
    if (!t) {
      const row = e.target.closest("tr[data-rn-item]");
      if (row) openItem(row.dataset.rnItem);
      return;
    }
    if (t.dataset.rnTab) {
      ui.tab = t.dataset.rnTab; ui.msg = null; return render();
    }
    const act = t.dataset.rnAct, i = Number(t.dataset.i);
    if (act === "cancel") { ui.file = null; ui.parsed = null; ui.hash = ""; ui.msg = null; return render(); }
    if (act === "confirm") return confirmImport();
    if (act === "reset") return resetPilot();
    if (act === "extract") return extract();
  }
  function onInput(e) {
    const el = e.target;
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
    if (el.id === "rnShow") { ui.show = el.value; return render(); }
    // Typed fields are kept and the sums updated on input (no redraw).
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
