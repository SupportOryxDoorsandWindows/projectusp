/* Materials in Transit (tab "Materials in Transit", 2026-11-05).
 *
 * Everything Oryx has ordered from a supplier but not yet received:
 * purchase orders (PO number, supplier, lines with ordered / received /
 * cancelled / pending quantities, prices, payment + delivery status,
 * expected date, documents, delivery history, change log).
 *
 * Owner's answers (2026-11-05): received goods are costed from the supplier
 * invoice through the NORMAL Check-in (unchanged); "Pending QC" is a status
 * label only; POs live here (no separate Purchase Orders page).
 *
 * NEVER stock. Transit quantities are not stock and never change stock.
 * "Receive from Transit": choose the PO, type what arrived + delivery note,
 * then the normal Check-in page opens with a banner; once that Check-in is
 * confirmed, fp-checkin-screen.js / renson.js call
 * ORYX_TRANSIT.afterCheckin(), which finds that Check-in's own stock lines
 * and records the delivery with transit_receive() (once per Receive: a
 * retry never counts twice; the server checks the Check-in exists).
 * Database: supabase/sql/materials_in_transit.sql. Pure parts
 * (window.ORYX_TRANSIT_CORE) are tested in tests/transit.test.js.
 */
(function (root) {
  "use strict";

  /* ============================== pure part ============================== */
  const STATUS = { ordered: "Ordered", in_transit: "In transit", partially_received: "Partially received",
    pending_qc: "Pending QC", completed: "Completed", cancelled: "Cancelled" };
  const STATUS_HELP = {
    ordered: "PO created; the supplier has not dispatched the materials yet.",
    in_transit: "The supplier has dispatched the materials.",
    partially_received: "Some materials have arrived; some are still pending.",
    pending_qc: "Materials have arrived and are awaiting quality inspection (label only: received goods are already in stock).",
    completed: "Everything has been received (or the rest cancelled).",
    cancelled: "The PO or its remaining quantity was cancelled.",
  };
  const PAYMENT = { tbc: "TBC", unpaid: "Unpaid", partially_paid: "Partially paid", paid: "Paid" };
  const GROUPS = ["Freedom", "Renson", "Fusion", "Other"];
  const OPEN = (s) => s !== "completed" && s !== "cancelled";

  const num = (v) => { const n = Number(String(v == null ? "" : v).replace(/,/g, "").trim()); return Number.isFinite(n) ? n : NaN; };
  const round = (v, d = 2) => Math.round((Number(v) || 0) * 10 ** d) / 10 ** d;
  const poKey = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  function supplierGroup(name) {
    const s = String(name || "");
    return /renson/i.test(s) ? "Renson" : /freedom/i.test(s) ? "Freedom" : /fusion/i.test(s) ? "Fusion" : "Other";
  }

  // One row per PO line, with the PO's fields and the worked-out values.
  function rowsOf(orders, lines) {
    const byId = new Map(orders.map((o) => [String(o.id), o]));
    return lines.map((l) => {
      const o = byId.get(String(l.order_id));
      if (!o) return null;
      const price = l.unit_price == null ? null : Number(l.unit_price);
      const rate = Number(o.rate_to_aed) || 1;
      return {
        ...l, order: o, po_number: o.po_number, supplier: o.supplier, supplier_group: o.supplier_group,
        delivery_status: o.delivery_status, payment_status: o.payment_status, expected_delivery: o.expected_delivery,
        currency: o.currency, updated: [o.updated_at, l.updated_at].filter(Boolean).sort().pop() || null,
        line_value: price == null ? null : round(Number(l.qty_ordered) * price),
        pending_aed: price == null ? null : round(Number(l.qty_pending) * price * rate),
        open: OPEN(o.delivery_status),
      };
    }).filter(Boolean);
  }

  // Cards + supplier breakdown. Only open POs count as "in transit".
  function summarise(orders, lines) {
    const rows = rowsOf(orders, lines).filter((r) => r.open);
    const sum = (a, f) => round(a.reduce((s, r) => s + (Number(f(r)) || 0), 0), 2);
    const groups = {};
    for (const g of GROUPS) {
      const gr = rows.filter((r) => r.supplier_group === g);
      groups[g] = { value: sum(gr, (r) => r.pending_aed), pos: new Set(gr.map((r) => r.order_id)).size,
        pendingLines: gr.filter((r) => Number(r.qty_pending) > 0).length };
    }
    return {
      value: sum(rows, (r) => r.pending_aed),
      ordered: sum(rows, (r) => r.qty_ordered), received: sum(rows, (r) => r.qty_received), pending: sum(rows, (r) => r.qty_pending),
      openPos: orders.filter((o) => OPEN(o.delivery_status)).length,
      noPrice: rows.filter((r) => r.unit_price == null && Number(r.qty_pending) > 0).length,
      groups,
    };
  }

  // f: {group, supplier, po, material, status, payment, from, to, search, showClosed}
  function filterRows(rows, f) {
    const q = String(f.search || "").trim().toLowerCase();
    const m = String(f.material || "").trim().toLowerCase();
    return rows.filter((r) => {
      if (!f.showClosed && !r.open) return false;
      if (f.group && r.supplier_group !== f.group) return false;
      if (f.supplier && r.supplier !== f.supplier) return false;
      if (f.po && String(r.order_id) !== String(f.po)) return false;
      if (f.status && r.delivery_status !== f.status) return false;
      if (f.payment && r.payment_status !== f.payment) return false;
      if (f.from && (!r.expected_delivery || r.expected_delivery < f.from)) return false;
      if (f.to && (!r.expected_delivery || r.expected_delivery > f.to)) return false;
      if (m && !`${r.item_code || ""} ${r.description}`.toLowerCase().includes(m)) return false;
      if (q && !`${r.po_number} ${r.supplier} ${r.item_code || ""} ${r.description} ${r.order.quote_ref || ""} ${STATUS[r.delivery_status]}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function sortRows(rows, key, dir) {
    const d = dir === "desc" ? -1 : 1;
    const val = (r) => r[key] == null ? "" : r[key];
    return rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "number" || typeof y === "number" || /^qty_|value|price|_aed$/.test(key)
        ? (Number(x) || 0) - (Number(y) || 0) : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c * d || String(a.po_number).localeCompare(String(b.po_number)) || a.line_no - b.line_no;
    });
  }

  /* ---- reading a PO / quote PDF (text from pdf.js, as extractPdfText) ---- */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function isoDate(s) {
    let m = String(s || "").match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b/);
    if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = String(s || "").match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);   // dd/mm/yyyy (UAE / AU / TH)
    if (m && +m[2] <= 12) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = String(s || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    return m ? m[0] : null;
  }
  const CUR = /\b(USD|AUD|EUR|AED|GBP|THB|CNY|INR)\b/;
  const UNIT = "Units?|Unit|Pieces?|Pcs?|PCS|PC|Length|Lengths|Rolls?|ROL|Box(?:es)?|Sets?|Lot|Each|EA|CAR|M|m|Metres?|Meters?|Kg|KG";
  const N = "\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0005);

  function documentCurrency(text) {
    const counts = {};
    for (const m of String(text).matchAll(new RegExp(CUR.source, "g"))) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }
  function documentTotal(text) {
    const re = new RegExp(`(?:Sub\\s*Total|Untaxed Amount|Total(?:\\s+Amount)?)\\s*(?:(?:USD|AUD|EUR|AED|GBP)\\s*)?(${N})|(?:USD|AUD|EUR|AED|GBP)\\s+Total\\s+(${N})`, "gi");
    let last = null;
    for (const m of String(text).matchAll(re)) { const v = num(m[1] || m[2]); if (v > 0) last = v; }
    return last;
  }

  // Item lines of a quote / PO. Three layouts, every line must reconcile
  // (qty x price = amount), or it is not read:
  //  A  "[134002] Brake Rod (1.5m) ... 600.00 Units USD 2.10 0% USD 1,260.00"  (Freedom Global)
  //  B  "820.00 0% 20.50 40.00 Length SMB1 Zip Track 220002 2"              (Freedom AU, read right to left)
  //  C  "220002 SMB1 Zip Track Length 40.00 20.50 0% 820.00"                (left to right, any supplier)
  function parseLines(text) {
    const t = String(text || "");
    const out = [];
    if (/\[[A-Z0-9][\w./-]*\]/.test(t)) {
      const parts = t.split(/\[([A-Z0-9][\w./-]*)\]/);
      for (let i = 1; i < parts.length; i += 2) {
        const code = parts[i], seg = parts[i + 1] || "";
        const flat = seg.replace(/\s+/g, " ").trim();
        const m = flat.match(new RegExp(`(${N})\\s+(${UNIT})\\s+(?:([A-Z]{3})\\s+)?(${N})\\s+(?:\\d+(?:\\.\\d+)?\\s*%\\s+)?(?:[A-Z]{3}\\s+)?(${N})`));
        if (!m) continue;
        const qty = num(m[1]), price = num(m[4]), amount = num(m[5]);
        if (!(qty > 0) || !close(qty * price, amount)) continue;
        const desc = flat.slice(0, m.index).replace(/\s*\b(?:[A-Z]+\s*-\s*)?HS CODE\b.*$/i, "").trim();
        out.push({ code, description: desc, unit: m[2], qty, price, amount });
      }
      if (out.length) return out;
    }
    for (const raw of t.split("\n")) {
      const line = raw.replace(/\s+/g, " ").trim();
      // B: right to left, with "code line-no" at the end, or neither
      // (a line whose code was printed apart, e.g. "International -Misc")
      let m = line.match(new RegExp(`^(${N}) (?:\\d+(?:\\.\\d+)?% )?(${N}) (${N}) (${UNIT}) (.+?)(?: ([A-Z0-9][\\w./-]*\\d[\\w./-]*) (\\d{1,4}))?$`));
      if (m) {
        const amount = num(m[1]), price = num(m[2]), qty = num(m[3]);
        if (qty > 0 && close(qty * price, amount)) { out.push({ code: m[6] || null, description: m[5].trim(), unit: m[4], qty, price, amount }); continue; }
      }
      m = line.match(new RegExp(`^(?:\\d{1,4} )?([A-Z0-9][\\w./-]*\\d[\\w./-]*) (.+?) (?:(${UNIT}) )?(${N}) (?:(${UNIT}) )?(?:[A-Z]{3} )?(${N}) (?:\\d+(?:\\.\\d+)?% )?(?:[A-Z]{3} )?(${N})$`));
      if (m) {
        const qty = num(m[4]), price = num(m[6]), amount = num(m[7]);
        if (qty > 0 && close(qty * price, amount)) out.push({ code: m[1], description: m[2].trim(), unit: m[3] || m[5] || "", qty, price, amount });
      }
    }
    return out;
  }

  // Header of a PO (or a quote): number, date, supplier, currency, total,
  // quotation reference. Values the document does not state stay null.
  function parseHeader(text) {
    const t = String(text || "");
    const isPo = /purchase\s+order/i.test(t);
    let poNumber = null, quoteRef = null, date = null, supplier = null;
    if (isPo) {
      const m = t.match(/Purchase Order (?:No|Number)\.?\s*:?\s*([A-Z]{1,4}[\w/-]*\d[\w/-]*)/i) || t.match(/\b(PO[\s-]?\d[\w/-]*)\b/);
      poNumber = m ? m[1].trim() : null;
      const d = t.match(/Purchase Order Date[\s\S]{0,120}?(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}[/.]\d{1,2}[/.]\d{4})/i);
      date = d ? isoDate(d[1]) : isoDate(t);
      const q = t.match(/Quotation\s*(?:ref|reference|no\.?|number|#)?\s*:?\s*#?\s*([A-Z]{1,3}-?\d[\d-]*)/i);
      quoteRef = q ? q[1] : null;
    } else {
      const q = t.match(/Quotation\s*#\s*([A-Z]{1,3}-?\d[\d-]*)/i) || t.match(/\b(SQ-\d+)\b/) || t.match(/\bQuote\s*(?:No\.?|#)?\s*:?\s*([A-Z]{1,3}-?\d[\d-]+)/i);
      quoteRef = q ? q[1] : null;
      const d = t.match(/(?:Quote|Quotation)\s+Date[\s\S]{0,40}?(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/i);
      date = d ? isoDate(d[1]) : null;
    }
    const s = t.split("\n").map((x) => x.trim()).find((x) => /^(Freedom Screens|Renson|Fusion)[\w ,.()&-]*$/i.test(x) && !/oryx/i.test(x));
    supplier = s ? s.replace(/\s+/g, " ") : null;
    return { kind: isPo ? "po" : "quote", poNumber, quoteRef, date, supplier, currency: documentCurrency(t), total: documentTotal(t) };
  }

  // PO + quote read together: header from the PO, lines from whichever
  // document has them; problems say what doesn't agree.
  function combineDocuments(docs) {
    const po = docs.find((d) => d.header.kind === "po") || null;
    const withLines = docs.filter((d) => d.lines.length);
    const src = withLines.find((d) => d.header.kind === "quote") || withLines[0] || null;
    const h = (po || src || docs[0] || { header: {} }).header;
    const draft = {
      po_number: (po && po.header.poNumber) || "", supplier: h.supplier || (src && src.header.supplier) || "",
      po_date: (po && po.header.date) || "", quote_ref: (po && po.header.quoteRef) || (src && src.header.quoteRef) || "",
      currency: h.currency || (src && src.header.currency) || "AED",
      lines: src ? src.lines.map((l) => ({ item_code: l.code || "", description: l.description, unit: l.unit || "", qty_ordered: l.qty, unit_price: l.price })) : [],
    };
    const notes = [], problems = [];
    if (!po) notes.push("No purchase order among the files: type the PO number.");
    if (!src) problems.push("No item lines could be read (each line must show quantity × price = amount). Add the quotation, import an Excel list, or type the lines.");
    if (src) {
      const sum = round(src.lines.reduce((s, l) => s + l.amount, 0));
      const total = (po && po.header.total) || src.header.total;
      if (total != null) (close(sum, total) ? notes : problems).push(close(sum, total)
        ? `The ${src.lines.length} lines add up to ${draft.currency} ${sum.toLocaleString("en-US", { minimumFractionDigits: 2 })} = the document total.`
        : `The lines read add up to ${sum.toLocaleString("en-US", { minimumFractionDigits: 2 })} but the document total is ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}: some lines were not read. Check against the document.`);
    }
    if (po && src && po.header.quoteRef && src.header.quoteRef && poKey(po.header.quoteRef) !== poKey(src.header.quoteRef)) {
      problems.push(`The PO refers to quotation ${po.header.quoteRef}, but the file read is ${src.header.quoteRef}.`);
    }
    return { draft, notes, problems };
  }

  // Excel / CSV rows (first row = headings) -> drafts, one per PO number.
  const HEAD = {
    po_number: /^(po|po\s*(no|number|#|ref)|purchase\s*order(\s*(no|number))?)\.?$/i,
    supplier: /^supplier(\s*name)?$/i,
    item_code: /^(material\s*code|item\s*code|code|sku|part\s*(no|number))\.?$/i,
    description: /^(material\s*)?description$|^material$|^item$/i,
    qty_ordered: /^(ordered\s*)?(qty|quantity)(\s*ordered)?$/i,
    unit: /^(unit|uom|unit\s*of\s*measure(ment)?|units)$/i,
    unit_price: /^(unit\s*)?price$|^rate$/i,
    currency: /^currency$/i,
    expected_delivery: /^(expected\s*(delivery|arrival)(\s*date)?|eta)$/i,
    po_date: /^po\s*date$|^order\s*date$/i,
    quote_ref: /^quot(e|ation)(\s*(no|number|ref|#))?\.?$/i,
  };
  function parseSheetRows(rows) {
    const hi = rows.findIndex((r) => (r || []).filter((c) => Object.values(HEAD).some((re) => re.test(String(c || "").trim()))).length >= 3);
    if (hi < 0) return { drafts: [], problems: ["No heading row found. The first row needs columns such as PO Number, Supplier, Material Code, Description, Quantity, Unit, Unit Price."] };
    const col = {};
    rows[hi].forEach((c, i) => { for (const [k, re] of Object.entries(HEAD)) if (col[k] == null && re.test(String(c || "").trim())) col[k] = i; });
    const problems = [];
    for (const k of ["po_number", "description", "qty_ordered"]) if (col[k] == null) problems.push(`Column missing: ${k === "po_number" ? "PO Number" : k === "qty_ordered" ? "Quantity" : "Description"}.`);
    if (problems.length) return { drafts: [], problems };
    const byPo = new Map();
    const cell = (r, k) => (col[k] == null ? "" : r[col[k]]);
    const dateOf = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" && v > 30000 && v < 80000
      ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : isoDate(String(v || "")) || "";
    rows.slice(hi + 1).forEach((r, i) => {
      if (!r || r.every((c) => c == null || String(c).trim() === "")) return;
      const po = String(cell(r, "po_number") || "").trim();
      if (!po) { problems.push(`Row ${hi + i + 2}: no PO number, row skipped.`); return; }
      const k = poKey(po);
      if (!byPo.has(k)) byPo.set(k, { po_number: po, supplier: String(cell(r, "supplier") || "").trim(), currency: String(cell(r, "currency") || "AED").trim().toUpperCase() || "AED",
        po_date: dateOf(cell(r, "po_date")), expected_delivery: dateOf(cell(r, "expected_delivery")), quote_ref: String(cell(r, "quote_ref") || "").trim(), lines: [] });
      const price = String(cell(r, "unit_price") ?? "").trim() === "" ? null : num(cell(r, "unit_price"));
      byPo.get(k).lines.push({ item_code: String(cell(r, "item_code") || "").trim(), description: String(cell(r, "description") || "").trim(),
        unit: String(cell(r, "unit") || "").trim(), qty_ordered: num(cell(r, "qty_ordered")), unit_price: price, row: hi + i + 2 });
    });
    return { drafts: [...byPo.values()], problems };
  }

  // Everything that stops a PO from being saved (the server checks again).
  function draftProblems(d, existingKeys) {
    const p = [];
    if (!String(d.po_number || "").trim()) p.push("PO number is missing.");
    else if (existingKeys && existingKeys.has(poKey(d.po_number))) p.push(`PO ${d.po_number} is already in Materials in Transit. Open it there instead of adding it twice.`);
    if (!String(d.supplier || "").trim()) p.push("Supplier is missing.");
    const cur = String(d.currency || "AED").toUpperCase();
    if (cur !== "AED" && !(num(d.rate_to_aed) > 0)) p.push(`Exchange rate ${cur} → AED is missing.`);
    if (!d.lines || !d.lines.length) p.push("No lines.");
    const seen = new Set();
    (d.lines || []).forEach((l, i) => {
      const n = `Line ${i + 1}${l.item_code ? ` (${l.item_code})` : ""}`;
      if (!String(l.description || "").trim()) p.push(`${n}: description is missing.`);
      if (!(num(l.qty_ordered) > 0)) p.push(`${n}: quantity must be more than 0.`);
      if (l.unit_price != null && l.unit_price !== "" && !(num(l.unit_price) >= 0)) p.push(`${n}: price is not a number.`);
      if (l.needsPick) p.push(`${n}: choose which Master Inventory item (bar length) it is, or "Not linked".`);
      const k = `${String(l.item_code || "").toUpperCase()}|${String(l.description || "").trim().toLowerCase()}`;
      if (seen.has(k)) p.push(`${n}: the same material is listed twice.`); seen.add(k);
    });
    return p;
  }

  // What the person typed in Receive: problems + the lines to send.
  function receiveCheck(lines, typed) {
    const problems = [], send = [];
    for (const l of lines) {
      const raw = typed[l.id];
      if (raw == null || String(raw).trim() === "") continue;
      const q = num(raw);
      const n = l.item_code || l.description;
      if (!(q > 0)) { problems.push(`${n}: delivered quantity must be more than 0 (or leave it empty).`); continue; }
      if (q > Number(l.qty_pending) + 1e-9) { problems.push(`${n}: ${q} is more than the ${Number(l.qty_pending)} still pending. An Admin must raise the ordered quantity first.`); continue; }
      send.push({ line_id: l.id, qty: q });
    }
    if (!problems.length && !send.length) problems.push("Type the quantity delivered on at least one line.");
    return { problems, send };
  }

  // The stock lines of the Check-in just confirmed: by its document
  // fingerprint, else (typed by hand) the newest Check-in batch of this
  // person (one Check-in = one timestamp on all its lines).
  function latestBatch(rows) {
    if (!rows.length) return [];
    const t = rows[0].created_at;
    return rows.filter((r) => r.created_at === t).map((r) => String(r.id));
  }

  const CORE = { STATUS, PAYMENT, GROUPS, OPEN, poKey, supplierGroup, rowsOf, summarise, filterRows, sortRows, isoDate,
    parseLines, parseHeader, combineDocuments, parseSheetRows, draftProblems, receiveCheck, latestBatch, documentTotal };
  root.ORYX_TRANSIT_CORE = CORE;
  if (typeof document === "undefined" || !root.ORYX_AUTH) return;

  /* ================================ page ================================ */
  const AUTH = root.ORYX_AUTH, sb = AUTH.sb;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (v, d = 2) => v == null || v === "" || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
  const aed = (v) => v == null ? "—" : "AED " + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v, c) => v == null ? "—" : `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (v) => v ? new Date(String(v).length === 10 ? v + "T00:00:00" : v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const badge = (s) => `<span class="badge tr-st tr-st-${esc(s)}" title="${esc(STATUS_HELP[s] || "")}">${esc(STATUS[s] || s)}</span>`;
  const payBadge = (s) => `<span class="badge ${s === "paid" ? "ok" : s === "unpaid" ? "no" : s === "partially_paid" ? "warn" : "grey"}">${esc(PAYMENT[s] || s)}</span>`;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
  const ERR = {
    duplicate_po: "This PO number is already in Materials in Transit.", not_allowed: "Your account can't do this (signed out or switched off).",
    admins_only: "Only an Admin can do this.", rate_missing: "Enter the exchange rate to AED.", reason_missing: "A reason is required.",
    still_pending: "Completed is only possible when nothing is pending.", cancel_through_admin: "Cancelling is done by an Admin (Cancel remaining).",
    nothing_received: "Nothing has been received yet.", already_received: "Something was already received, so it can't go back to Ordered.",
    order_closed: "This PO is completed or cancelled.", checkin_not_found: "The Check-in's stock lines were not found (or were entered by someone else).",
    checkin_already_used: "That Check-in was already recorded against this PO.", checkin_wrong_inventory: "The Check-in went to the other inventory (Freedom / Renson) than this PO.",
    order_has_receipts: "This PO has deliveries recorded, so it can't be deleted. Cancel the remaining quantity instead.",
    below_received: "The ordered quantity can't be less than what was already received + cancelled.", line_has_receipts: "That line has deliveries recorded.",
    cancel_more_than_pending: "You can't cancel more than is pending.", nothing_to_cancel: "Nothing is pending to cancel.",
    file_not_stored: "The file was not stored.", line_item_mismatch: "The Master Inventory item chosen has a different code.",
  };
  function errText(e) {
    const m = String((e && e.message) || e);
    let x = m.match(/more_than_pending: (.*)/);
    if (x) return "More than is still pending: " + x[1] + ". An Admin must raise the ordered quantity first.";
    x = m.match(/duplicate_line: (.*)/);
    if (x) return "The same material is listed twice: " + x[1];
    const k = Object.keys(ERR).find((key) => m.includes(key));
    return k ? ERR[k] : m;
  }

  const ui = { orders: [], lines: [], receipts: [], rlines: [], docs: [], log: [], loaded: false, busy: false,
    f: { showClosed: false }, sort: { key: "expected_delivery", dir: "asc" }, freedomItems: null, rensonItems: null, queue: [] };

  async function load() {
    $("#trStatus").textContent = "Loading…";
    const all = (q) => q.then(({ data, error }) => { if (error) throw error; return data || []; });
    try {
      const [orders, lines, receipts, rlines, docs] = await Promise.all([
        all(sb.from("transit_orders").select("*").order("id")),
        all(sb.from("transit_lines").select("*").order("order_id").order("line_no").range(0, 9999)),
        all(sb.from("transit_receipts").select("*").order("id")),
        all(sb.from("transit_receipt_lines").select("*").range(0, 9999)),
        all(sb.from("transit_documents").select("*").order("id")),
      ]);
      Object.assign(ui, { orders, lines, receipts, rlines, docs, loaded: true });
      $("#trStatus").textContent = "";
      draw();
    } catch (e) {
      $("#trStatus").textContent = "Could not read Materials in Transit: " + (e.message || e) + (/transit_/.test(e.message || "") ? " (the database part may not be installed yet)" : "");
    }
  }

  function draw() {
    const s = summarise(ui.orders, ui.lines);
    $("#trCards").innerHTML = `
      <div class="db-tile dark"><div class="db-k">Materials in transit</div><div class="db-v"><small>AED</small>${fmtN(s.value, 0)}</div>
        <div class="db-sub">Pending value of open POs${s.noPrice ? ` · ${s.noPrice} line${s.noPrice > 1 ? "s" : ""} without a price` : ""} · not in stock value</div></div>
      <div class="db-tile"><div class="db-k">Ordered quantity</div><div class="db-v">${fmtN(s.ordered)}</div><div class="db-sub">Open POs, all units</div></div>
      <div class="db-tile"><div class="db-k">Received quantity</div><div class="db-v">${fmtN(s.received)}</div><div class="db-sub">Checked in so far</div></div>
      <div class="db-tile"><div class="db-k">Pending quantity</div><div class="db-v">${fmtN(s.pending)}</div><div class="db-sub">Ordered − received − cancelled</div></div>
      <div class="db-tile"><div class="db-k">Open purchase orders</div><div class="db-v">${s.openPos}</div><div class="db-sub">Not completed or cancelled</div></div>`;
    $("#trGroups").innerHTML = GROUPS.map((g) => { const x = s.groups[g];
      return `<button type="button" class="tr-group${ui.f.group === g ? " on" : ""}" data-tr-group="${g}" aria-pressed="${ui.f.group === g}">
        <b>${g}</b><span class="tr-g-v">${aed(x.value)}</span><span class="db-sub">${x.pos} open PO${x.pos === 1 ? "" : "s"} · ${x.pendingLines} line${x.pendingLines === 1 ? "" : "s"} pending</span></button>`; }).join("");
    drawFilters();
    drawTable();
  }

  function drawFilters() {
    const f = ui.f;
    const opt = (v, t, cur) => `<option value="${esc(v)}"${String(cur || "") === String(v) ? " selected" : ""}>${esc(t)}</option>`;
    const suppliers = [...new Set(ui.orders.map((o) => o.supplier))].sort();
    const pos = ui.orders.filter((o) => f.showClosed || OPEN(o.delivery_status)).slice().sort((a, b) => a.po_number.localeCompare(b.po_number));
    $("#trFilters").innerHTML = `
      <div><label class="field-label" for="trSearch">Search</label><input id="trSearch" type="search" value="${esc(f.search || "")}" placeholder="PO, supplier, code, description…" autocomplete="off"></div>
      <div><label class="field-label" for="trFSupplier">Supplier</label><select id="trFSupplier">${opt("", "All suppliers", f.supplier)}${suppliers.map((x) => opt(x, x, f.supplier)).join("")}</select></div>
      <div><label class="field-label" for="trFPo">Purchase order</label><select id="trFPo">${opt("", "All POs", f.po)}${pos.map((o) => opt(o.id, o.po_number, f.po)).join("")}</select></div>
      <div><label class="field-label" for="trFMaterial">Material</label><input id="trFMaterial" type="search" value="${esc(f.material || "")}" placeholder="Code or name" autocomplete="off"></div>
      <div><label class="field-label" for="trFStatus">Delivery status</label><select id="trFStatus">${opt("", "Any", f.status)}${Object.entries(STATUS).map(([k, v]) => opt(k, v, f.status)).join("")}</select></div>
      <div><label class="field-label" for="trFPay">Payment</label><select id="trFPay">${opt("", "Any", f.payment)}${Object.entries(PAYMENT).map(([k, v]) => opt(k, v, f.payment)).join("")}</select></div>
      <div><label class="field-label" for="trFFrom">Expected from</label><input id="trFFrom" type="date" value="${esc(f.from || "")}"></div>
      <div><label class="field-label" for="trFTo">to</label><input id="trFTo" type="date" value="${esc(f.to || "")}"></div>
      <label class="tr-closed"><input type="checkbox" id="trFClosed"${f.showClosed ? " checked" : ""}> Show completed / cancelled</label>
      ${Object.keys(f).some((k) => k !== "showClosed" && f[k]) ? `<button type="button" class="db-link" id="trFClear">Clear filters</button>` : ""}`;
  }

  const COLS = [["po_number", "PO number"], ["supplier", "Supplier"], ["item_code", "Code"], ["description", "Description"],
    ["qty_ordered", "Ordered", "num"], ["qty_received", "Received", "num"], ["qty_pending", "Pending", "num"], ["unit", "Unit"],
    ["unit_price", "Unit price", "num"], ["line_value", "Line value", "num"], ["payment_status", "Payment"], ["delivery_status", "Delivery status"],
    ["expected_delivery", "Expected"], ["updated", "Last updated"]];
  function drawTable() {
    const rows = sortRows(filterRows(rowsOf(ui.orders, ui.lines), ui.f), ui.sort.key, ui.sort.dir);
    const total = round(rows.reduce((s, r) => s + (r.pending_aed || 0), 0));
    if (!ui.orders.length) {
      $("#trTable").innerHTML = `<div class="tr-empty"><b>No purchase orders yet.</b><p>Add one with <b>+ New PO</b> (type it, or read the PO / quotation PDF or an Excel list). Nothing here is stock until it is received through Check-in.</p></div>`;
      return;
    }
    $("#trTable").innerHTML = `<div class="tr-count small muted">${rows.length} line${rows.length === 1 ? "" : "s"} · pending value ${aed(total)}</div>
      <div class="tr-scroll"><table class="mi-table tr-table"><thead><tr>${COLS.map(([k, t, c]) =>
        `<th class="${c || ""}"><button type="button" class="tr-sort" data-tr-sort="${k}">${esc(t)}${ui.sort.key === k ? (ui.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button></th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-tr-po="${r.order_id}" tabindex="0" title="Open PO ${esc(r.po_number)}">
        <td><b>${esc(r.po_number)}</b></td><td>${esc(r.supplier)}</td><td><code>${esc(r.item_code || "—")}</code></td><td>${esc(r.description)}</td>
        <td class="num">${fmtN(r.qty_ordered)}</td><td class="num">${fmtN(r.qty_received)}</td><td class="num"><b>${fmtN(r.qty_pending)}</b></td><td>${esc(r.unit || "")}</td>
        <td class="num">${r.unit_price == null ? "—" : money(r.unit_price, r.currency)}</td><td class="num">${r.line_value == null ? "—" : money(r.line_value, r.currency)}</td>
        <td>${payBadge(r.payment_status)}</td><td>${badge(r.delivery_status)}</td><td>${day(r.expected_delivery)}</td><td class="small">${day(r.updated)}</td></tr>`).join("")
        || `<tr><td colspan="${COLS.length}" class="muted">Nothing matches these filters.</td></tr>`}</tbody></table></div>`;
  }

  function onFilter(e) {
    const t = e.target, f = ui.f;
    const map = { trSearch: "search", trFSupplier: "supplier", trFPo: "po", trFMaterial: "material", trFStatus: "status", trFPay: "payment", trFFrom: "from", trFTo: "to" };
    const typed = t.id === "trSearch" || t.id === "trFMaterial";
    if (map[t.id]) {
      if (e.type === "input" && !typed) return;          // selects / dates: on change
      f[map[t.id]] = t.value;
      if (t.id === "trFSupplier") f.group = "";
    } else if (t.id === "trFClosed") {
      if (e.type !== "change") return;
      f.showClosed = t.checked;
    } else return;
    if (t.id === "trFSupplier" || t.id === "trFClosed") draw();   // group cards / PO list follow
    else drawTable();                                             // keeps the typing box in place
  }

  /* ----------------------------- PO detail ----------------------------- */
  const dlg = () => $("#trDlg");
  async function openPo(id) {
    const o = ui.orders.find((x) => String(x.id) === String(id));
    if (!o) return;
    ui.open = o.id;
    const { data: log } = await sb.from("transit_log").select("*").eq("order_id", o.id).order("id");
    ui.log = log || [];
    drawPo();
    if (!dlg().open) dlg().showModal();
  }
  function drawPo() {
    const o = ui.orders.find((x) => x.id === ui.open);
    if (!o) { dlg().close(); return; }
    const lines = ui.lines.filter((l) => l.order_id === o.id);
    const recs = ui.receipts.filter((r) => r.order_id === o.id);
    const docs = ui.docs.filter((d) => d.order_id === o.id);
    const admin = AUTH.isAdmin();
    const total = round(lines.reduce((s, l) => s + (l.unit_price == null ? 0 : l.qty_ordered * l.unit_price), 0));
    const pendAed = round(lines.reduce((s, l) => s + (l.unit_price == null ? 0 : l.qty_pending * l.unit_price * o.rate_to_aed), 0));
    const lineName = (id) => { const l = lines.find((x) => x.id === id); return l ? (l.item_code || l.description) : "?"; };
    const statusOpts = Object.keys(STATUS).filter((k) => k !== "cancelled" || o.delivery_status === "cancelled");
    dlg().innerHTML = `<div class="bar"><b>PO ${esc(o.po_number)}</b> ${badge(o.delivery_status)}<button type="button" class="btn-outline btn-sm" data-tr-close>Close</button></div>
    <div class="tr-dlg-body">
      <div class="tr-po-head">
        <div><span class="db-sub">Supplier</span><b>${esc(o.supplier)}</b><span class="db-sub">${esc(o.supplier_group)} · ${o.inventory === "renson" ? "Renson stock" : "Freedom stock"}</span></div>
        <div><span class="db-sub">PO date</span><b>${day(o.po_date)}</b></div>
        <div><span class="db-sub">Quotation</span><b>${esc(o.quote_ref || "—")}</b></div>
        <div><span class="db-sub">Total PO value</span><b>${money(total, o.currency)}</b>${o.currency !== "AED" ? `<span class="db-sub">at 1 ${esc(o.currency)} = ${fmtN(o.rate_to_aed, 6)} AED</span>` : ""}</div>
        <div><span class="db-sub">Still in transit</span><b>${aed(pendAed)}</b></div>
        <div><span class="db-sub">Entered by</span><b>${esc(o.created_by_name || "—")}</b><span class="db-sub">${day(o.created_at)}</span></div>
      </div>
      <form class="tr-edit" id="trEdit">
        <div><label class="field-label" for="trEExp">Expected delivery</label><input id="trEExp" type="date" value="${esc(o.expected_delivery || "")}"></div>
        <div><label class="field-label" for="trEPay">Payment status</label><select id="trEPay">${Object.entries(PAYMENT).map(([k, v]) => `<option value="${k}"${o.payment_status === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label class="field-label" for="trESt">Delivery status</label><select id="trESt"${o.delivery_status === "cancelled" ? " disabled" : ""}>${statusOpts.map((k) => `<option value="${k}"${o.delivery_status === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}</select></div>
        <div><label class="field-label" for="trEQuote">Quotation ref.</label><input id="trEQuote" value="${esc(o.quote_ref || "")}" maxlength="60"></div>
        <div class="tr-wide"><label class="field-label" for="trENotes">Notes</label><input id="trENotes" value="${esc(o.notes || "")}" maxlength="2000"></div>
        <div class="tr-edit-act"><button type="submit" class="btn-yellow btn-sm">Save changes</button><span id="trEMsg" class="small" role="status"></span></div>
      </form>
      <p class="small muted">${esc(STATUS_HELP[o.delivery_status] || "")}</p>
      <h3 class="tr-h3">Materials</h3>
      <div class="tr-scroll"><table class="mi-table tr-table"><thead><tr><th>#</th><th>Code</th><th>Description</th><th>Unit</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Cancelled</th><th class="num">Outstanding</th><th class="num">Unit price</th><th class="num">Line value</th><th class="num">Outstanding (AED)</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td>${l.line_no}</td><td><code>${esc(l.item_code || "—")}</code></td><td>${esc(l.description)}${l.freedom_item_id || l.renson_item_id ? "" : ` <span class="badge grey" title="Not linked to a Master Inventory item">not in Master</span>`}</td><td>${esc(l.unit || "")}</td>
        <td class="num">${fmtN(l.qty_ordered)}</td><td class="num">${fmtN(l.qty_received)}</td><td class="num">${fmtN(l.qty_cancelled)}</td><td class="num"><b>${fmtN(l.qty_pending)}</b></td>
        <td class="num">${l.unit_price == null ? "—" : money(l.unit_price, o.currency)}</td><td class="num">${l.unit_price == null ? "—" : money(l.qty_ordered * l.unit_price, o.currency)}</td>
        <td class="num">${l.unit_price == null ? "—" : aed(l.qty_pending * l.unit_price * o.rate_to_aed)}</td></tr>`).join("")}</tbody></table></div>
      ${OPEN(o.delivery_status) ? `<p><button type="button" class="btn-yellow" data-tr-receive="${o.id}">Receive from Transit</button></p>` : ""}
      ${admin ? adminPanel(o, lines) : ""}
      <h3 class="tr-h3">Delivery history</h3>
      ${recs.length ? `<div class="tr-scroll"><table class="mi-table tr-table"><thead><tr><th>Received</th><th>Delivery note</th><th>DN date</th><th>Check-in</th><th>Materials</th><th>By</th></tr></thead><tbody>
        ${recs.map((r) => `<tr><td>${day(r.created_at)}</td><td>${esc(r.delivery_note_no || "—")}</td><td>${day(r.delivery_date)}</td>
          <td>${esc(r.checkin_reference || "—")}${r.document_name ? `<div class="small muted">${esc(r.document_name)}</div>` : ""}<div class="small muted">${r.checkin_tx_ids.length} stock line${r.checkin_tx_ids.length === 1 ? "" : "s"} (${r.checkin_kind === "renson" ? "Renson" : "Freedom"} Check-in)</div></td>
          <td class="small">${ui.rlines.filter((x) => x.receipt_id === r.id).map((x) => `${esc(lineName(x.line_id))} × ${fmtN(x.qty)}`).join("<br>")}</td><td>${esc(r.received_by_name || "—")}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="small muted">Nothing received yet.</p>`}
      <h3 class="tr-h3">Documents</h3>
      <ul class="tr-docs">${docs.map((d) => `<li><button type="button" class="db-link" data-tr-doc="${d.id}">${esc(d.name)}</button> <span class="small muted">${esc(d.kind.toUpperCase())} · ${esc(d.uploaded_by_name || "")} · ${day(d.created_at)}</span></li>`).join("") || `<li class="small muted">No documents kept.</li>`}</ul>
      <label class="btn-outline btn-sm tr-file">Add a document (PDF / Excel)<input type="file" id="trDocFile" accept=".pdf,.xlsx,.xls,application/pdf" hidden></label> <span id="trDocMsg" class="small" role="status"></span>
      <details class="tr-log"><summary>History of changes (${ui.log.length})</summary><ul>${ui.log.map((x) => `<li><b>${day(x.created_at)}</b> ${esc(x.action.replace(/_/g, " "))} by ${esc(x.by_name || "—")} <span class="small muted">${esc(logText(x))}</span></li>`).join("")}</ul></details>
    </div>`;
  }
  function logText(x) {
    const d = x.detail || {};
    if (x.action === "updated") return Object.entries(d).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v[0] ?? "—"} → ${v[1] ?? "—"}`).join("; ");
    if (x.action === "received") return `${d.lines} line(s)${d.delivery_note_no ? `, DN ${d.delivery_note_no}` : ""}${d.checkin_reference ? `, Check-in ${d.checkin_reference}` : ""}`;
    if (d.reason) return `Reason: ${d.reason}`;
    if (x.action === "created") return `${d.lines} line(s), ${d.source || "manual"}`;
    return "";
  }
  function adminPanel(o, lines) {
    return `<details class="tr-admin"><summary>Admin: change quantities, prices, cancel or delete</summary>
      <form id="trAdm" class="tr-edit">
        <div class="tr-wide"><label class="field-label" for="trALine">Line</label><select id="trALine"><option value="">— choose —</option>${lines.map((l) => `<option value="${l.id}">${l.line_no}. ${esc(l.item_code || "")} ${esc(l.description)} (ordered ${fmtN(l.qty_ordered)}, pending ${fmtN(l.qty_pending)})</option>`).join("")}<option value="new">+ Add a new line</option></select></div>
        <div class="tr-new" hidden><label class="field-label" for="trACode">Code</label><input id="trACode" maxlength="60"></div>
        <div class="tr-new tr-wide" hidden><label class="field-label" for="trADesc">Description</label><input id="trADesc" maxlength="300"></div>
        <div class="tr-new" hidden><label class="field-label" for="trAUnit">Unit</label><input id="trAUnit" maxlength="30"></div>
        <div><label class="field-label" for="trAQty">New ordered qty</label><input id="trAQty" inputmode="decimal"></div>
        <div><label class="field-label" for="trAPrice">New unit price (${esc(o.currency)})</label><input id="trAPrice" inputmode="decimal"></div>
        <div class="tr-old"><label class="field-label" for="trACancel">Cancel qty</label><input id="trACancel" inputmode="decimal" placeholder="pending"></div>
        <div class="tr-wide"><label class="field-label" for="trAReason">Reason (required)</label><input id="trAReason" maxlength="300"></div>
        <div class="tr-edit-act tr-wide">
          <button type="button" class="btn-outline btn-sm" data-tr-adm="change">Apply change</button>
          <button type="button" class="btn-outline btn-sm" data-tr-adm="cancel">Cancel this quantity</button>
          <button type="button" class="btn-outline btn-sm" data-tr-adm="remove">Remove line</button>
          <button type="button" class="btn-outline btn-sm" data-tr-adm="cancelall">Cancel everything pending</button>
          <button type="button" class="btn-outline btn-sm um-remove" data-tr-adm="delete">Delete PO</button>
          <span id="trAMsg" class="small" role="status"></span></div>
      </form></details>`;
  }
  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  }
  async function savePo(e) {
    e.preventDefault();
    const o = ui.orders.find((x) => x.id === ui.open), msg = $("#trEMsg");
    const p = { id: o.id, expected_delivery: $("#trEExp").value || null, payment_status: $("#trEPay").value, notes: $("#trENotes").value, quote_ref: $("#trEQuote").value };
    if ($("#trESt") && !$("#trESt").disabled) p.delivery_status = $("#trESt").value;
    msg.className = "small"; msg.textContent = "Saving…";
    try {
      const r = await rpc("transit_update_order", { p });
      await load(); await openPo(o.id);
      const m = $("#trEMsg"); if (m) { m.className = "small ok"; m.textContent = r.changed ? "Saved." : "Nothing changed."; }
    } catch (err) { msg.className = "small error"; msg.textContent = "Not saved: " + errText(err); }
  }
  async function adminAct(act) {
    const o = ui.orders.find((x) => x.id === ui.open), msg = $("#trAMsg");
    const lineId = $("#trALine").value, reason = $("#trAReason").value.trim();
    const say = (t, bad) => { msg.className = "small " + (bad ? "error" : "ok"); msg.textContent = t; };
    if (!reason) return say("Type the reason first.", true);
    try {
      if (act === "delete") {
        if (!confirm(`Delete PO ${o.po_number}? It is kept in the history of changes.`)) return;
        await rpc("transit_delete_order", { p_id: o.id, p_reason: reason });
        dlg().close(); await load(); return;
      }
      if (act === "cancelall") {
        if (!confirm(`Cancel everything still pending on PO ${o.po_number}?`)) return;
        await rpc("transit_cancel", { p: { order_id: o.id, reason } });
      } else if (lineId === "new") {
        const q = num($("#trAQty").value), pr = $("#trAPrice").value.trim();
        await rpc("transit_admin_change", { p: { order_id: o.id, reason, changes: [{ action: "add", item_code: $("#trACode").value, description: $("#trADesc").value, unit: $("#trAUnit").value, qty_ordered: q, unit_price: pr === "" ? null : num(pr) }] } });
      } else if (!lineId) return say("Choose the line.", true);
      else if (act === "cancel") {
        const c = $("#trACancel").value.trim();
        await rpc("transit_cancel", { p: { order_id: o.id, line_id: Number(lineId), reason, ...(c === "" ? {} : { qty: num(c) }) } });
      } else if (act === "remove") {
        if (!confirm("Remove this line from the PO?")) return;
        await rpc("transit_admin_change", { p: { order_id: o.id, reason, changes: [{ action: "remove", line_id: Number(lineId) }] } });
      } else {
        const ch = { action: "edit", line_id: Number(lineId) };
        if ($("#trAQty").value.trim()) ch.qty_ordered = num($("#trAQty").value);
        if ($("#trAPrice").value.trim()) ch.unit_price = num($("#trAPrice").value);
        if (Object.keys(ch).length === 2) return say("Type a new quantity or price.", true);
        await rpc("transit_admin_change", { p: { order_id: o.id, reason, changes: [ch] } });
      }
      await load(); await openPo(o.id);
      const m = $("#trAMsg"); if (m) { m.className = "small ok"; m.textContent = "Done."; }
    } catch (err) { say("Not done: " + errText(err), true); }
  }
  async function sha256(file) {
    const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function keepDocument(orderId, file, kind) {
    const ext = (file.name.match(/\.(pdf|xlsx|xls)$/i) || [, "pdf"])[1].toLowerCase();
    const path = `${orderId}/${await sha256(file)}.${ext}`;
    const up = await sb.storage.from("transit-documents").upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(up.error.message);
    return rpc("transit_add_document", { p_order: orderId, p_kind: kind, p_name: file.name, p_path: path });
  }
  async function openDoc(id) {
    const d = ui.docs.find((x) => String(x.id) === String(id));
    const { data, error } = await sb.storage.from("transit-documents").createSignedUrl(d.path, 300);
    if (error) return alert("Could not open the document: " + error.message);
    window.open(data.signedUrl, "_blank", "noopener");
  }

  /* ------------------------------- new PO ------------------------------- */
  const nd = () => $("#trNewDlg");
  async function masterItems(inv) {
    if (inv === "renson") {
      if (!ui.rensonItems) { const { data } = await sb.from("renson_items").select("id, item_code, description, unit").order("item_code"); ui.rensonItems = data || []; }
      return ui.rensonItems;
    }
    if (!ui.freedomItems) {
      const { data } = await sb.from("inventory_items").select("id, item_code, description, bar_length_mm, unit_of_measure, status").order("item_code").range(0, 4999);
      ui.freedomItems = data || [];
    }
    return ui.freedomItems;
  }
  // Freedom: one code can be several bar lengths -> the person picks; one
  // match is linked; none = kept as text ("not in Master"). Never guessed
  // from the description.
  async function linkLines(d) {
    const items = await masterItems(d.inventory);
    for (const l of d.lines) {
      const code = String(l.item_code || "").trim().toUpperCase();
      const m = code ? items.filter((i) => String(i.item_code || "").trim().toUpperCase() === code) : [];
      l.matches = m;
      if (d.inventory === "renson") { l.freedom_item_id = null; l.needsPick = false; continue; }
      if (m.length === 1) { l.freedom_item_id = m[0].id; l.needsPick = false; }
      else if (m.length > 1 && !m.some((i) => i.id === l.freedom_item_id) && l.freedom_item_id !== "none") { l.freedom_item_id = ""; l.needsPick = true; }
      else l.needsPick = false;
    }
  }
  function blankDraft() {
    return { po_number: "", supplier: "", supplier_group: "", inventory: "freedom", po_date: "", quote_ref: "", currency: "AED", rate_to_aed: "",
      expected_delivery: "", payment_status: "tbc", delivery_status: "ordered", notes: "", lines: [], files: [], notes2: [], problems2: [], source: "manual" };
  }
  async function openNew(draft) {
    ui.draft = Object.assign(blankDraft(), draft || {});
    const d = ui.draft;
    d.supplier_group = d.supplier_group || supplierGroup(d.supplier);
    d.inventory = d.supplier_group === "Renson" ? "renson" : "freedom";
    if (!d.lines.length) d.lines.push({ item_code: "", description: "", unit: "", qty_ordered: "", unit_price: "" });
    await linkLines(d);
    drawNew();
    if (!nd().open) nd().showModal();
    if (d.currency !== "AED" && !(num(d.rate_to_aed) > 0)) getRate();
  }
  function drawNew() {
    const d = ui.draft, keys = new Set(ui.orders.map((o) => poKey(o.po_number)));
    const probs = [...d.problems2, ...draftProblems(d, keys)];
    const sum = round(d.lines.reduce((s, l) => s + (num(l.qty_ordered) > 0 && num(l.unit_price) >= 0 ? num(l.qty_ordered) * num(l.unit_price) : 0), 0));
    const curs = ["AED", "USD", "AUD", "EUR", "GBP"].concat(d.currency && !["AED", "USD", "AUD", "EUR", "GBP"].includes(d.currency) ? [d.currency] : []);
    nd().innerHTML = `<div class="bar"><b>New purchase order${ui.queue.length ? ` <span class="small">(${ui.queue.length} more from the Excel file after this)</span>` : ""}</b><button type="button" class="btn-outline btn-sm" data-tr-nclose>Close</button></div>
    <div class="tr-dlg-body">
      <div class="tr-import">
        <label class="btn-outline btn-sm tr-file">Read PO / quotation PDF<input type="file" id="trPdf" accept=".pdf,application/pdf" multiple hidden></label>
        <label class="btn-outline btn-sm tr-file">Import Excel list<input type="file" id="trXls" accept=".xlsx,.xls,.csv" hidden></label>
        <span class="small muted">Read files fill the form below. Nothing is saved until you press <b>Save purchase order</b>.</span>
        <span id="trNMsg" class="small" role="status"></span>
      </div>
      ${d.notes2.length ? `<ul class="tr-notes">${d.notes2.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="tr-edit">
        <div><label class="field-label" for="trNPo">PO number *</label><input id="trNPo" data-nd="po_number" value="${esc(d.po_number)}" maxlength="60"></div>
        <div class="tr-wide"><label class="field-label" for="trNSup">Supplier *</label><input id="trNSup" data-nd="supplier" value="${esc(d.supplier)}" maxlength="160" list="trSupList">
          <datalist id="trSupList">${[...new Set(ui.orders.map((o) => o.supplier).concat(["Freedom Screens Global Co., Ltd", "Freedom Screens of Australia Pty Ltd", "Renson NV"]))].map((s) => `<option value="${esc(s)}">`).join("")}</datalist></div>
        <div><label class="field-label" for="trNGroup">Supplier group</label><select id="trNGroup" data-nd="supplier_group">${GROUPS.map((g) => `<option${d.supplier_group === g ? " selected" : ""}>${g}</option>`).join("")}</select>
          <span class="db-sub">Received into ${d.inventory === "renson" ? "Renson" : "Freedom"} stock</span></div>
        <div><label class="field-label" for="trNDate">PO date</label><input id="trNDate" type="date" data-nd="po_date" value="${esc(d.po_date)}"></div>
        <div><label class="field-label" for="trNQuote">Quotation ref.</label><input id="trNQuote" data-nd="quote_ref" value="${esc(d.quote_ref)}" maxlength="60"></div>
        <div><label class="field-label" for="trNCur">Currency</label><select id="trNCur" data-nd="currency">${curs.map((c) => `<option${d.currency === c ? " selected" : ""}>${c}</option>`).join("")}</select></div>
        ${d.currency !== "AED" ? `<div><label class="field-label" for="trNRate">1 ${esc(d.currency)} = AED</label><input id="trNRate" data-nd="rate_to_aed" inputmode="decimal" value="${esc(d.rate_to_aed)}">
          <button type="button" class="db-link" data-tr-rate>Get rate${d.po_date ? " of the PO date" : ""}</button> <span class="db-sub" id="trRateNote">${esc(d.rateNote || "")}</span></div>` : ""}
        <div><label class="field-label" for="trNExp">Expected delivery</label><input id="trNExp" type="date" data-nd="expected_delivery" value="${esc(d.expected_delivery)}"></div>
        <div><label class="field-label" for="trNPay">Payment status</label><select id="trNPay" data-nd="payment_status">${Object.entries(PAYMENT).map(([k, v]) => `<option value="${k}"${d.payment_status === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label class="field-label" for="trNSt">Delivery status</label><select id="trNSt" data-nd="delivery_status"><option value="ordered"${d.delivery_status === "ordered" ? " selected" : ""}>Ordered</option><option value="in_transit"${d.delivery_status === "in_transit" ? " selected" : ""}>In transit (dispatched)</option></select></div>
        <div class="tr-wide"><label class="field-label" for="trNNotes">Notes</label><input id="trNNotes" data-nd="notes" value="${esc(d.notes)}" maxlength="2000"></div>
      </div>
      <h3 class="tr-h3">Materials (${d.lines.length})</h3>
      <div class="tr-scroll"><table class="mi-table tr-table tr-lines"><thead><tr><th>#</th><th>Code</th><th>Description *</th><th>Unit</th><th class="num">Qty *</th><th class="num">Unit price</th><th class="num">Line total</th><th>Master Inventory</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr><td>${i + 1}</td>
        <td><input data-nl="item_code" data-i="${i}" value="${esc(l.item_code)}" size="9" maxlength="60" aria-label="Code, line ${i + 1}"></td>
        <td><input data-nl="description" data-i="${i}" value="${esc(l.description)}" size="30" maxlength="300" aria-label="Description, line ${i + 1}"></td>
        <td><input data-nl="unit" data-i="${i}" value="${esc(l.unit)}" size="6" maxlength="30" aria-label="Unit, line ${i + 1}"></td>
        <td class="num"><input data-nl="qty_ordered" data-i="${i}" value="${esc(l.qty_ordered)}" size="7" inputmode="decimal" aria-label="Quantity, line ${i + 1}"></td>
        <td class="num"><input data-nl="unit_price" data-i="${i}" value="${esc(l.unit_price == null ? "" : l.unit_price)}" size="7" inputmode="decimal" aria-label="Price, line ${i + 1}"></td>
        <td class="num" data-total="${i}">${num(l.qty_ordered) > 0 && String(l.unit_price ?? "") !== "" && num(l.unit_price) >= 0 ? fmtN(num(l.qty_ordered) * num(l.unit_price)) : "—"}</td>
        <td>${linkCell(l, i, d.inventory)}</td>
        <td><button type="button" class="db-link" data-tr-del="${i}" aria-label="Remove line ${i + 1}">Remove</button></td></tr>`).join("")}</tbody></table></div>
      <p><button type="button" class="btn-outline btn-sm" data-tr-add>+ Add line</button> <span class="small muted">Total: <b id="trNSum">${esc(d.currency)} ${fmtN(sum)}</b></span></p>
      <ul class="tr-probs" id="trNProbs">${probs.map((x) => `<li class="error">${esc(x)}</li>`).join("")}</ul>
      <div class="tr-edit-act"><button type="button" class="btn-yellow" data-tr-save${probs.length || ui.busy ? " disabled" : ""}>Save purchase order</button>
        <span class="small muted">Saves the PO only. Stock changes only when materials are received through Check-in.</span></div>
    </div>`;
  }
  function linkCell(l, i, inv) {
    if (!String(l.item_code || "").trim()) return `<span class="small muted">no code</span>`;
    if (inv === "renson") return l.matches && l.matches.length ? `<span class="badge ok">${esc(l.matches[0].description).slice(0, 40)}</span>` : `<span class="badge grey">not in Master</span>`;
    if (!l.matches || !l.matches.length) return `<span class="badge grey" title="No Master Inventory item has this code. Kept as typed (Check-in decides when it arrives).">not in Master</span>`;
    if (l.matches.length === 1) return `<span class="badge ok" title="${esc(l.matches[0].description)}">${esc(l.matches[0].description).slice(0, 34)}</span>`;
    return `<select data-nl="freedom_item_id" data-i="${i}" aria-label="Master item, line ${i + 1}"${l.needsPick ? ' class="tr-need"' : ""}><option value="">Choose bar length…</option>
      ${l.matches.map((m) => `<option value="${m.id}"${l.freedom_item_id === m.id ? " selected" : ""}>${esc(m.description)}${m.bar_length_mm ? ` · ${m.bar_length_mm} mm` : ""}</option>`).join("")}
      <option value="none"${l.freedom_item_id === "none" ? " selected" : ""}>Not linked</option></select>`;
  }
  function refreshNewProblems() {
    const d = ui.draft, keys = new Set(ui.orders.map((o) => poKey(o.po_number)));
    const probs = [...d.problems2, ...draftProblems(d, keys)];
    $("#trNProbs").innerHTML = probs.map((x) => `<li class="error">${esc(x)}</li>`).join("");
    $("[data-tr-save]", nd()).disabled = !!probs.length || ui.busy;
    const sum = round(d.lines.reduce((s, l) => s + (num(l.qty_ordered) > 0 && num(l.unit_price) >= 0 ? num(l.qty_ordered) * num(l.unit_price) : 0), 0));
    $("#trNSum").textContent = `${d.currency} ${fmtN(sum)}`;
    d.lines.forEach((l, i) => { const c = nd().querySelector(`[data-total="${i}"]`); if (c) c.textContent = num(l.qty_ordered) > 0 && String(l.unit_price ?? "") !== "" && num(l.unit_price) >= 0 ? fmtN(num(l.qty_ordered) * num(l.unit_price)) : "—"; });
  }
  async function regroup(d) {
    const inv = d.supplier_group === "Renson" ? "renson" : "freedom";
    if (inv !== d.inventory) { d.inventory = inv; d.lines.forEach((l) => { l.freedom_item_id = null; }); await linkLines(d); }
    drawNew();
  }
  async function onNewInput(e) {
    const t = e.target, d = ui.draft;
    if (!d) return;
    const sel = t.tagName === "SELECT", typing = e.type === "input" || sel;
    if (sel && e.type !== "change") return;
    if (t.dataset.nd) {
      const k = t.dataset.nd;
      if (typing) d[k] = t.value;
      if (k === "supplier_group") return regroup(d);
      if (k === "supplier" && e.type === "change") { d.supplier_group = supplierGroup(t.value); return regroup(d); }
      if (k === "currency") { d.rate_to_aed = ""; d.rateNote = ""; d.rateManual = false; drawNew(); if (d.currency !== "AED") getRate(); return; }
      if (k === "po_date" && e.type === "change" && d.currency !== "AED" && !d.rateManual) getRate();
      if (k === "rate_to_aed" && e.type === "input") { d.rateManual = true; d.rateNote = "entered by hand"; const n = $("#trRateNote"); if (n) n.textContent = d.rateNote; }
    } else if (t.dataset.nl) {
      const l = d.lines[Number(t.dataset.i)], k = t.dataset.nl;
      if (typing) l[k] = t.value;
      if (k === "freedom_item_id") { l.needsPick = !t.value; t.classList.toggle("tr-need", !t.value); }
      if (k === "item_code" && e.type === "change") { l.freedom_item_id = null; await linkLines(d); drawNew(); return; }
    } else return;
    refreshNewProblems();
  }
  async function getRate() {
    const d = ui.draft, FP = root.ORYX_FP;
    if (!d || d.currency === "AED" || !FP || !FP.fetchCheckinExchangeRate) return;
    const note = (t) => { d.rateNote = t; const n = $("#trRateNote"); if (n) n.textContent = t; };
    note("Getting the rate…");
    const r = await FP.fetchCheckinExchangeRate(d.currency, d.po_date || null).catch(() => null);
    if (!r) return note("Rate not available: type it in.");
    d.rate_to_aed = String(Math.round(r.rate * 1e6) / 1e6); d.rateManual = false;
    note(`currency-api, ${r.rateDate || "latest"}${r.source === "api-latest-fallback" ? " (the PO date's rate wasn't published)" : ""}`);
    const i = $("#trNRate"); if (i) i.value = d.rate_to_aed;
    refreshNewProblems();
  }
  async function readPdfs(files) {
    const FP = root.ORYX_FP, msg = $("#trNMsg");
    msg.className = "small"; msg.textContent = "Reading…";
    try {
      const docs = [];
      for (const f of files) { const text = await FP.extractPdfText(f); docs.push({ file: f, header: parseHeader(text), lines: parseLines(text) }); }
      const c = combineDocuments(docs);
      const keep = { expected_delivery: ui.draft.expected_delivery, payment_status: ui.draft.payment_status, notes: ui.draft.notes };
      const files2 = docs.map((x) => ({ file: x.file, kind: x.header.kind }));
      await openNew(Object.assign({}, c.draft, keep, { files: files2, notes2: [...c.notes, `Read: ${files.map((f) => f.name).join(", ")}.`], problems2: c.problems, source: "pdf" }));
      const m = $("#trNMsg"); if (m) { m.className = "small ok"; m.textContent = "Read. Check every field before saving."; }
    } catch (e) { msg.className = "small error"; msg.textContent = "Could not read the file: " + (e.message || e); }
  }
  async function readExcel(file) {
    const FP = root.ORYX_FP, msg = $("#trNMsg");
    msg.className = "small"; msg.textContent = "Reading…";
    try {
      await FP.loadXlsxLib();
      const wb = root.XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const res = parseSheetRows(root.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }));
      if (!res.drafts.length) { msg.className = "small error"; msg.textContent = res.problems.join(" "); return; }
      const keys = new Set(ui.orders.map((o) => poKey(o.po_number)));
      const skipped = res.drafts.filter((x) => keys.has(poKey(x.po_number))).map((x) => x.po_number);
      const todo = res.drafts.filter((x) => !keys.has(poKey(x.po_number)));
      if (!todo.length) { msg.className = "small error"; msg.textContent = `Every PO in the file is already here (${skipped.join(", ")}). Nothing to add.`; return; }
      ui.queue = todo.slice(1).map((x) => Object.assign(x, { source: "excel", files: [], notes2: [`From ${file.name}.`], problems2: [] }));
      await openNew(Object.assign(todo[0], { source: "excel", files: [{ file, kind: "other" }], problems2: [],
        notes2: [`From ${file.name}: ${res.drafts.length} PO${res.drafts.length > 1 ? "s" : ""}.`, ...(skipped.length ? [`Already here, left out: ${skipped.join(", ")}.`] : []), ...res.problems] }));
    } catch (e) { msg.className = "small error"; msg.textContent = "Could not read the file: " + (e.message || e); }
  }
  async function saveNew() {
    const d = ui.draft;
    if (ui.busy || draftProblems(d, new Set(ui.orders.map((o) => poKey(o.po_number)))).length) return;
    ui.busy = true; refreshNewProblems();
    const msg = $("#trNMsg");
    try {
      const p = { po_number: d.po_number.trim(), supplier: d.supplier.trim(), supplier_group: d.supplier_group, inventory: d.inventory,
        po_date: d.po_date || null, quote_ref: d.quote_ref, currency: d.currency, rate_to_aed: d.currency === "AED" ? 1 : num(d.rate_to_aed),
        expected_delivery: d.expected_delivery || null, payment_status: d.payment_status, delivery_status: d.delivery_status, notes: d.notes, source: d.source,
        lines: d.lines.map((l) => ({ item_code: l.item_code, description: l.description, unit: l.unit, qty_ordered: num(l.qty_ordered),
          unit_price: String(l.unit_price ?? "").trim() === "" ? null : num(l.unit_price),
          freedom_item_id: d.inventory === "freedom" && l.freedom_item_id && l.freedom_item_id !== "none" ? l.freedom_item_id : null })) };
      const r = await rpc("transit_create_order", { p });
      const kept = [];
      for (const f of d.files || []) { try { await keepDocument(r.id, f.file, f.kind); kept.push(f.file.name); } catch (e) { kept.push(`${f.file.name} NOT kept (${errText(e)})`); } }
      ui.busy = false;
      await load();
      if (ui.queue.length) { await openNew(ui.queue.shift()); const m = $("#trNMsg"); if (m) { m.className = "small ok"; m.textContent = `PO ${p.po_number} saved. Next one from the file:`; } return; }
      nd().close();
      $("#trStatus").innerHTML = `<span class="ok">PO ${esc(p.po_number)} saved (${r.lines} line${r.lines === 1 ? "" : "s"})${kept.length ? `, documents: ${esc(kept.join(", "))}` : ""}.</span>`;
    } catch (e) {
      ui.busy = false; refreshNewProblems();
      msg.className = "small error"; msg.textContent = "Not saved: " + errText(e);
    }
  }

  /* ------------------------ Receive from Transit ------------------------ */
  // Open a page the way its menu button does (pages load their data on that click).
  function go(view) {
    const b = document.querySelector(`nav button[data-v="${view}"]`);
    if (b) b.click(); else if (root.ORYX_SHOW_VIEW) root.ORYX_SHOW_VIEW(view);
  }
  const rd = () => $("#trRcvDlg");
  // opts.checkin: an already-confirmed Check-in to link (from afterCheckin)
  function openReceive(orderId, opts) {
    ui.rcv = { orderId: orderId ? Number(orderId) : null, typed: {}, dn: "", dnDate: "", key: uuid(), checkin: (opts && opts.checkin) || null };
    drawReceive();
    if (!rd().open) rd().showModal();
  }
  function drawReceive() {
    const r = ui.rcv, c = r.checkin;
    const open = ui.orders.filter((o) => OPEN(o.delivery_status) && ui.lines.some((l) => l.order_id === o.id && Number(l.qty_pending) > 0)
      && (!c || o.inventory === c.kind)).sort((a, b) => a.po_number.localeCompare(b.po_number));
    const o = open.find((x) => x.id === r.orderId) || null;
    const lines = o ? ui.lines.filter((l) => l.order_id === o.id) : [];
    const chk = o ? receiveCheck(lines.filter((l) => Number(l.qty_pending) > 0), r.typed) : { problems: [] };
    rd().innerHTML = `<div class="bar"><b>Receive from Transit</b><button type="button" class="btn-outline btn-sm" data-tr-rclose>Close</button></div>
    <div class="tr-dlg-body">
      ${c ? `<p class="tr-banner-in">Linking the Check-in just confirmed (${esc(c.reference || c.docName || "typed by hand")}, ${c.ids.length} stock line${c.ids.length === 1 ? "" : "s"}). Type what this delivery brought for the PO; the stock itself was already updated by the Check-in.</p>`
        : `<p class="small muted">1. Choose the PO. 2. Type what arrived and the delivery note. 3. <b>Continue to Check-in</b>: check in the supplier invoice as usual. The PO is updated right after the Check-in is confirmed.</p>`}
      <div class="tr-edit">
        <div class="tr-wide"><label class="field-label" for="trRPo">Purchase order</label><select id="trRPo"><option value="">— choose a PO with materials outstanding —</option>
          ${open.map((x) => `<option value="${x.id}"${x.id === r.orderId ? " selected" : ""}>${esc(x.po_number)} · ${esc(x.supplier)} · ${STATUS[x.delivery_status]}</option>`).join("")}</select>
          ${!open.length ? `<span class="db-sub">No open PO has anything outstanding${c ? ` for ${c.kind === "renson" ? "Renson" : "Freedom"} stock` : ""}.</span>` : ""}</div>
        <div><label class="field-label" for="trRDn">Delivery note no.</label><input id="trRDn" value="${esc(r.dn)}" maxlength="60"></div>
        <div><label class="field-label" for="trRDate">Delivery date</label><input id="trRDate" type="date" value="${esc(r.dnDate)}"></div>
      </div>
      ${o ? `<div class="tr-scroll"><table class="mi-table tr-table"><thead><tr><th>Code</th><th>Description</th><th>Unit</th><th class="num">Ordered</th><th class="num">Received before</th><th class="num">Remaining</th><th class="num">Delivered now</th></tr></thead><tbody>
        ${lines.map((l) => `<tr class="${Number(l.qty_pending) > 0 ? "" : "tr-done-row"}"><td><code>${esc(l.item_code || "—")}</code></td><td>${esc(l.description)}</td><td>${esc(l.unit || "")}</td>
          <td class="num">${fmtN(l.qty_ordered)}</td><td class="num">${fmtN(l.qty_received)}</td><td class="num"><b>${fmtN(l.qty_pending)}</b></td>
          <td class="num">${Number(l.qty_pending) > 0 ? `<input data-rq="${l.id}" value="${esc(r.typed[l.id] || "")}" size="7" inputmode="decimal" aria-label="Delivered now, ${esc(l.item_code || l.description)}">` : `<span class="small muted">complete</span>`}</td></tr>`).join("")}</tbody></table></div>
        <p><button type="button" class="db-link" data-tr-fill>Everything outstanding arrived</button></p>
        <ul class="tr-probs" id="trRProbs">${chk.problems.map((x) => `<li class="error">${esc(x)}</li>`).join("")}</ul>
        <div class="tr-edit-act"><button type="button" class="btn-yellow" data-tr-rgo${chk.problems.length ? " disabled" : ""}>${c ? "Record this delivery" : "Continue to Check-in"}</button>
          <span id="trRMsg" class="small" role="status"></span></div>` : ""}
    </div>`;
  }
  function refreshReceive() {
    const r = ui.rcv, lines = ui.lines.filter((l) => l.order_id === r.orderId && Number(l.qty_pending) > 0);
    const chk = receiveCheck(lines, r.typed);
    $("#trRProbs").innerHTML = chk.problems.map((x) => `<li class="error">${esc(x)}</li>`).join("");
    $("[data-tr-rgo]", rd()).disabled = !!chk.problems.length;
  }
  async function receiveGo() {
    const r = ui.rcv, o = ui.orders.find((x) => x.id === r.orderId);
    const lines = ui.lines.filter((l) => l.order_id === o.id);
    const chk = receiveCheck(lines.filter((l) => Number(l.qty_pending) > 0), r.typed);
    if (chk.problems.length) return;
    const ctx = { key: r.key, order: o, lines: chk.send.map((s) => ({ ...s, line: lines.find((l) => l.id === s.line_id) })), dn: r.dn.trim(), dnDate: r.dnDate || null };
    if (r.checkin) {
      const out = $("#trRMsg"); out.className = "small"; out.textContent = "Recording…";
      try { const res = await record(ctx, r.checkin); rd().close(); await load(); if (r.checkin.mount) r.checkin.mount.innerHTML = doneHtml(ctx, res); }
      catch (e) { out.className = "small error"; out.textContent = "Not recorded: " + errText(e); }
      return;
    }
    ui.pending = ctx;
    rd().close();
    banner();
    go("checkin");
  }

  // Banner on the Check-in page while a Receive waits for its Check-in.
  function banner() {
    let b = $("#trCiBanner");
    const host = $("#v-checkin .page-body") || $("#v-checkin");
    if (!host) return;
    if (!ui.pending) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement("div"); b.id = "trCiBanner"; b.className = "tr-ci-banner"; host.prepend(b); }
    const c = ui.pending;
    b.innerHTML = `<div><b>Receiving PO ${esc(c.order.po_number)}</b> · ${esc(c.order.supplier)}${c.dn ? ` · DN ${esc(c.dn)}` : ""}
      <div class="small">${c.lines.map((l) => `${esc(l.line.item_code || l.line.description)} × ${fmtN(l.qty)} ${esc(l.line.unit || "")}`).join(" · ")}</div>
      <div class="small">Now check in the supplier's ${c.order.inventory === "renson" ? "Renson " : ""}invoice / delivery as usual (PDF or typed by hand). The PO is updated as soon as that Check-in is confirmed. These quantities are not stock until then.</div></div>
      <button type="button" class="btn-outline btn-sm" data-tr-stop>Stop receiving</button>`;
  }

  async function record(ctx, ck) {
    return rpc("transit_receive", { p: { receive_key: ctx.key, order_id: ctx.order.id, delivery_note_no: ctx.dn, delivery_date: ctx.dnDate,
      checkin_kind: ck.kind, checkin_tx_ids: ck.ids, checkin_reference: ck.reference || null, document_name: ck.docName || null,
      lines: ctx.lines.map((l) => ({ line_id: l.line_id, qty: l.qty })) } });
  }
  function doneHtml(ctx, res) {
    return `<div class="tr-done"><b>PO ${esc(ctx.order.po_number)} updated${res.already ? " (already recorded)" : ""}</b>: ${ctx.lines.length} line${ctx.lines.length === 1 ? "" : "s"} received${ctx.dn ? `, DN ${esc(ctx.dn)}` : ""}. Status: ${badge(res.status)}
      <button type="button" class="db-link" data-tr-openpo="${ctx.order.id}">Open the PO</button></div>`;
  }
  // The stock lines of the Check-in just confirmed.
  async function checkinIds(kind, hash) {
    const me = AUTH.user && AUTH.user.id;
    const table = kind === "renson" ? "renson_transactions" : "inventory_transactions";
    const hcol = kind === "renson" ? "document_hash" : "source_document_hash";
    let q = sb.from(table).select("id, created_at").eq("type", "check_in");
    q = hash ? q.eq(hcol, hash) : q.eq("performed_by", me).order("created_at", { ascending: false }).limit(1000);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return hash ? (data || []).map((r) => String(r.id)) : latestBatch(data || []);
  }

  // Called by fp-checkin-screen.js (Freedom) and renson.js (Renson) right
  // after a Check-in was confirmed. info: {kind, hash, poNumber, reference,
  // docName, lines, mount}. Never throws (the Check-in is already saved).
  async function afterCheckin(info) {
    const mount = info.mount;
    try {
      if (!ui.loaded) await load();
      const ctx = ui.pending;
      if (ctx && ctx.order.inventory !== info.kind) {
        mount.innerHTML = `<div class="tr-done warn">This Check-in went to ${info.kind === "renson" ? "Renson" : "Freedom"} stock, but PO ${esc(ctx.order.po_number)} is for ${ctx.order.inventory === "renson" ? "Renson" : "Freedom"} stock, so the PO was NOT updated. Check in that PO's own invoice.</div>`;
        return;
      }
      // Nothing to do (no Receive waiting, PO number not an open PO here):
      // stay silent, the Check-in screen looks exactly as before.
      const k = poKey(info.poNumber);
      const match = !ctx && k ? ui.orders.find((x) => poKey(x.po_number) === k && x.inventory === info.kind && OPEN(x.delivery_status)) : null;
      if (!ctx && !match) return;
      const ids = await checkinIds(info.kind, info.hash || null);
      const ck = { kind: info.kind, ids, reference: info.reference || null, docName: info.docName || null, mount };
      if (!ids.length) { mount.innerHTML = `<div class="tr-done warn">The Check-in's stock lines could not be read back, so no PO was updated. Use <b>Receive from Transit</b> later to link it.</div>`; return; }
      if (ctx) {
        const go = async () => {
          mount.innerHTML = `<div class="tr-done">Updating PO ${esc(ctx.order.po_number)}…</div>`;
          try { const res = await record(ctx, ck); ui.pending = null; banner(); await load(); mount.innerHTML = doneHtml(ctx, res); }
          catch (e) {
            mount.innerHTML = `<div class="tr-done warn">The Check-in is saved, but PO ${esc(ctx.order.po_number)} was NOT updated: ${esc(errText(e))} <button type="button" class="btn-outline btn-sm" data-tr-retry>Try again</button></div>`;
            $("[data-tr-retry]", mount).addEventListener("click", go);
          }
        };
        return go();
      }
      // No Receive started, but the document's PO number is an open PO: offer it.
      mount.innerHTML = `<div class="tr-done">PO <b>${esc(match.po_number)}</b> (${esc(match.supplier)}) is in Materials in Transit with materials outstanding.
        <button type="button" class="btn-outline btn-sm" data-tr-link>Update the PO from this Check-in</button></div>`;
      $("[data-tr-link]", mount).addEventListener("click", () => openReceive(match.id, { checkin: ck }));
    } catch (e) {
      mount.innerHTML = `<div class="tr-done warn">Materials in Transit could not be updated: ${esc(errText(e))}. The Check-in itself is saved.</div>`;
    }
  }

  /* ------------------------------- wiring ------------------------------- */
  function mount() {
    const v = $("#v-transit");
    if (!v || v.dataset.wired) return;
    v.dataset.wired = "1";
    // The windows open from the Check-in page too (linking a Check-in), so
    // they can't live inside this (then hidden) page.
    ["#trDlg", "#trNewDlg", "#trRcvDlg"].forEach((id) => { const d = $(id); if (d) document.body.appendChild(d); });
    v.addEventListener("input", onFilter);
    v.addEventListener("change", onFilter);
    v.addEventListener("click", (e) => {
      const t = e.target;
      const g = t.closest("[data-tr-group]");
      if (g) { ui.f.group = ui.f.group === g.dataset.trGroup ? "" : g.dataset.trGroup; ui.f.supplier = ""; draw(); return; }
      const s = t.closest("[data-tr-sort]");
      if (s) { const k = s.dataset.trSort; ui.sort = { key: k, dir: ui.sort.key === k && ui.sort.dir === "asc" ? "desc" : "asc" }; drawTable(); return; }
      if (t.id === "trFClear") { ui.f = { showClosed: ui.f.showClosed }; draw(); return; }
      const row = t.closest("[data-tr-po]");
      if (row) openPo(row.dataset.trPo);
      if (t.id === "trNew") openNew();
      if (t.id === "trReceive") openReceive(ui.f.po || null);
      if (t.id === "trReload") load();
    });
    v.addEventListener("keydown", (e) => { const row = e.target.closest && e.target.closest("[data-tr-po]"); if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPo(row.dataset.trPo); } });
    dlg().addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-tr-close]")) dlg().close();
      const rc = t.closest("[data-tr-receive]"); if (rc) { dlg().close(); openReceive(rc.dataset.trReceive); }
      const dc = t.closest("[data-tr-doc]"); if (dc) openDoc(dc.dataset.trDoc);
      const ad = t.closest("[data-tr-adm]"); if (ad) adminAct(ad.dataset.trAdm);
    });
    dlg().addEventListener("submit", (e) => { if (e.target.id === "trEdit") savePo(e); else e.preventDefault(); });
    dlg().addEventListener("change", async (e) => {
      if (e.target.id === "trALine") { const isNew = e.target.value === "new"; dlg().querySelectorAll(".tr-new").forEach((x) => { x.hidden = !isNew; }); dlg().querySelectorAll(".tr-old").forEach((x) => { x.hidden = isNew; }); }
      if (e.target.id === "trDocFile" && e.target.files[0]) {
        const m = $("#trDocMsg"); m.className = "small"; m.textContent = "Keeping…";
        try { await keepDocument(ui.open, e.target.files[0], /quot/i.test(e.target.files[0].name) ? "quote" : /\bpo\b|purchase/i.test(e.target.files[0].name) ? "po" : "other"); await load(); await openPo(ui.open); }
        catch (err) { m.className = "small error"; m.textContent = "Not kept: " + errText(err); }
      }
    });
    nd().addEventListener("input", onNewInput);
    nd().addEventListener("change", (e) => {
      if (e.target.id === "trPdf" && e.target.files.length) return readPdfs([...e.target.files]);
      if (e.target.id === "trXls" && e.target.files[0]) return readExcel(e.target.files[0]);
      onNewInput(e);
    });
    nd().addEventListener("click", async (e) => {
      const t = e.target;
      if (t.closest("[data-tr-nclose]")) { ui.queue = []; nd().close(); }
      if (t.closest("[data-tr-add]")) { ui.draft.lines.push({ item_code: "", description: "", unit: "", qty_ordered: "", unit_price: "" }); drawNew(); }
      const del = t.closest("[data-tr-del]"); if (del) { ui.draft.lines.splice(Number(del.dataset.trDel), 1); drawNew(); }
      if (t.closest("[data-tr-rate]")) { ui.draft.rateManual = false; getRate(); }
      if (t.closest("[data-tr-save]")) saveNew();
    });
    rd().addEventListener("change", (e) => { if (e.target.id === "trRPo") { ui.rcv.orderId = Number(e.target.value) || null; ui.rcv.typed = {}; drawReceive(); } });
    rd().addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.rq) { ui.rcv.typed[t.dataset.rq] = t.value; refreshReceive(); }
      if (t.id === "trRDn") ui.rcv.dn = t.value;
      if (t.id === "trRDate") ui.rcv.dnDate = t.value;
    });
    rd().addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-tr-rclose]")) rd().close();
      if (t.closest("[data-tr-fill]")) { ui.lines.filter((l) => l.order_id === ui.rcv.orderId && Number(l.qty_pending) > 0).forEach((l) => { ui.rcv.typed[l.id] = String(Number(l.qty_pending)); }); drawReceive(); }
      if (t.closest("[data-tr-rgo]")) receiveGo();
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-tr-stop]")) { ui.pending = null; banner(); }
      const op = e.target.closest("[data-tr-openpo]");
      if (op) { go("transit"); openPo(op.dataset.trOpenpo); }
    });
    // Load on every opening of the page (others may have changed it).
    const nav = document.querySelector('nav button[data-v="transit"]');
    if (nav) nav.addEventListener("click", () => load());
    if (v.classList.contains("on")) load();
  }

  root.ORYX_TRANSIT = { afterCheckin, open: openPo, receive: openReceive, reload: load, get pending() { return ui.pending || null; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})(typeof window !== "undefined" ? window : globalThis);
