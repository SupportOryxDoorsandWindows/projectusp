// Monthly stock movements report (Freedom + Renson) -- the pure part, no
// network: period maths, rows -> summary, rows -> Excel workbook. Used by
// index.ts (Deno, Edge Function) and tests/monthly-report.test.js (Node).
// User's request 2026-11-04: "automate the reports to be sent on the 1st of
// each month" (transactions + summary, emailed). Same layout as the October
// 2026 report sent by hand: Summary / Freedom transactions / Renson
// transactions. Read-only: nothing here writes stock.

const DUBAI_OFFSET_MS = 4 * 3600 * 1000; // Asia/Dubai, no daylight saving
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The calendar month (Dubai) before `now`, or the month "YYYY-MM" given.
// Returns UTC instants for querying plus labels.
export function reportPeriod(now = new Date(), month = null) {
  let y, m;
  if (month) {
    const mm = /^(\d{4})-(\d{2})$/.exec(String(month));
    if (!mm || +mm[2] < 1 || +mm[2] > 12) throw new Error("month must be YYYY-MM");
    y = +mm[1]; m = +mm[2] - 1;
  } else {
    const d = new Date(now.getTime() + DUBAI_OFFSET_MS); // Dubai wall clock in UTC fields
    y = d.getUTCFullYear(); m = d.getUTCMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const start = new Date(Date.UTC(y, m, 1) - DUBAI_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1) - DUBAI_OFFSET_MS);
  return { key: `${y}-${String(m + 1).padStart(2, "0")}`, label: `${MONTHS[m]} ${y}`, start, end };
}

const isManual = (r) => (r.supplier || "") === "Manual correction" || (r.client || "") === "Manual correction";
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

// One normalised line for either inventory: dir +1 into stock, -1 out.
export function freedomLine(r) {
  const dir = r.type === "check_in" ? 1 : -1;
  const kind = isManual(r) ? (dir > 0 ? "Adjustment (+)" : "Adjustment (-)") : (dir > 0 ? "Check-in" : "Check-out");
  const ref = (r.type === "check_out" ? r.job_number : (r.invoice_number || r.po_number)) || r.job_number || r.invoice_number || "";
  const price = r.original_unit_cost != null && r.original_currency ? `${r.original_currency} ${Number(r.original_unit_cost)}` : "";
  return { at: r.created_at, kind, ref, party: (r.type === "check_out" ? r.client : r.supplier) || "", code: r.item_code || "",
    description: r.description || "", qty: dir * num(r.quantity), unit: r.unit || "", unitCost: r.unit_cost_used == null ? null : num(r.unit_cost_used),
    value: dir * Math.abs(num(r.value)), price, document: r.source_document_name || "", by: r.performed_by_name || "Not recorded", id: String(r.id) };
}

export function rensonLine(r, itemsById) {
  const delta = num(r.qty_after) - num(r.qty_before);
  const dir = delta >= 0 ? 1 : -1;
  const it = (itemsById && itemsById.get(String(r.item_id))) || {};
  const kind = r.type === "check_in" ? "Check-in" : r.type === "check_out" ? "Check-out" : r.type === "adjustment" ? (dir > 0 ? "Adjustment (+)" : "Adjustment (-)") : "Opening stock";
  const ref = r.type === "check_out" ? (r.job_number || "") : r.type === "check_in" ? (r.invoice_number || r.po_number || "") : [r.reference, r.reason].filter(Boolean).join(": ");
  const price = r.original_unit_cost != null && r.original_currency ? `${r.original_currency} ${Number(r.original_unit_cost)}` : "";
  return { at: r.created_at, kind, ref, party: r.supplier || "", code: r.item_code || "", description: it.description || "",
    qty: delta, unit: r.unit || it.unit || "", unitCost: r.unit_cost == null ? null : num(r.unit_cost), value: dir * Math.abs(num(r.value)),
    price, document: r.document_name || "", by: r.performed_by_name || "Not recorded", id: String(r.id) };
}

const KINDS = [["Check-in", "Supplier deliveries"], ["Check-out", "Jobs (materials used)"],
  ["Adjustment (+)", "Stock counts / added by hand"], ["Adjustment (-)", "Stock counts / taken out by hand"]];

// lines -> {kind: {docs, lines, value}}; a "document / job" = same reference at the same minute.
export function summarise(lines) {
  const out = {};
  for (const [k] of KINDS) out[k] = { docs: 0, lines: 0, value: 0, _refs: new Set() };
  for (const l of lines) {
    const g = out[l.kind]; if (!g) continue;
    g.lines += 1; g.value += l.value; g._refs.add(l.ref + "|" + String(l.at).slice(0, 16));
  }
  for (const k of Object.keys(out)) { out[k].docs = out[k]._refs.size; out[k].value = r2(out[k].value); delete out[k]._refs; }
  return out;
}

// inventories: [{name, lines, opening (number|null), closing (number|null), note?}]
export function buildWorkbook(XLSX, { period, inventories, preparedAt, notes = [] }) {
  const navy = "0F2C3F";
  const H = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: navy } }, alignment: { wrapText: true, vertical: "center" } };
  const B = { font: { bold: true } };
  const money = "#,##0.00";
  const wb = XLSX.utils.book_new();

  // Summary
  const s = [[`Oryx stock movements — ${period.label}`], [`Freedom and Renson inventories. Prepared ${preparedAt} by the StockFlow system. Values in AED.`], [],
    ["Inventory", "Movement", "Documents / jobs", "Lines", "Value (AED)"]];
  const totals = [];
  for (const inv of inventories) {
    const sum = summarise(inv.lines);
    totals.push({ name: inv.name, sum });
    if (!inv.lines.length) s.push([inv.name, inv.note || "No movements in this month", 0, 0, 0]);
    else for (const [k, what] of KINDS) s.push([inv.name, `${k} — ${what}`, sum[k].docs, sum[k].lines, sum[k].value]);
  }
  s.push([]);
  s.push(["Stock value (AED)", "", "Start of month", "", "End of month"]);
  let o = 0, c = 0, oKnown = true, cKnown = true;
  for (const inv of inventories) {
    s.push([inv.name, "", inv.opening == null ? "not recorded" : r2(inv.opening), "", inv.closing == null ? "not recorded" : r2(inv.closing)]);
    if (inv.opening == null) oKnown = false; else o += inv.opening;
    if (inv.closing == null) cKnown = false; else c += inv.closing;
  }
  s.push(["Total", "", oKnown ? r2(o) : "not recorded", "", cKnown ? r2(c) : "not recorded"]);
  if (notes.length) { s.push([]); s.push(["Notes"]); for (const n of notes) s.push(["• " + n]); }
  const ws = XLSX.utils.aoa_to_sheet(s);
  ws["!cols"] = [{ wch: 18 }, { wch: 44 }, { wch: 16 }, { wch: 8 }, { wch: 16 }];
  ws.A1.s = { font: { bold: true, sz: 15, color: { rgb: navy } } };
  for (let col = 0; col < 5; col++) { const a = XLSX.utils.encode_cell({ r: 3, c: col }); if (ws[a]) ws[a].s = H; }
  const valueRow = s.findIndex((row) => row[0] === "Stock value (AED)");
  for (let r = 4; r < s.length; r++) {
    // Value column everywhere; "Start of month" column only in the stock value block (above it, col 2 is a count).
    for (const col of r > valueRow ? [2, 4] : [4]) {
      const a = XLSX.utils.encode_cell({ r, c: col });
      if (ws[a] && typeof ws[a].v === "number") ws[a].z = money;
    }
  }
  if (ws[XLSX.utils.encode_cell({ r: valueRow, c: 0 })]) ws[XLSX.utils.encode_cell({ r: valueRow, c: 0 })].s = B;
  XLSX.utils.book_append_sheet(wb, ws, "Summary");

  // One sheet per inventory
  const head = ["Date (Dubai)", "Type", "Job / Invoice / Reason", "Client / Supplier", "Item code", "Description", "Qty", "Unit",
    "Unit cost (AED)", "Value (AED)", "Supplier price", "Document", "By"];
  for (const inv of inventories) {
    const rows = [head];
    const sorted = [...inv.lines].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
    for (const l of sorted) {
      const d = new Date(new Date(l.at).getTime() + DUBAI_OFFSET_MS);
      const when = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      rows.push([when, l.kind, l.ref, l.party, l.code, l.description, l.qty, l.unit, l.unitCost, r2(l.value), l.price, l.document, l.by]);
    }
    if (!sorted.length) rows.push([inv.note || "No movements in this month."]);
    else rows.push(["Total", "", "", "", "", "", "", "", "", r2(sorted.reduce((t, l) => t + l.value, 0))]);
    const sh = XLSX.utils.aoa_to_sheet(rows);
    sh["!cols"] = [{ wch: 16 }, { wch: 15 }, { wch: 26 }, { wch: 26 }, { wch: 11 }, { wch: 42 }, { wch: 9 }, { wch: 6 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 34 }, { wch: 16 }];
    for (let col = 0; col < head.length; col++) sh[XLSX.utils.encode_cell({ r: 0, c: col })].s = H;
    for (let r = 1; r < rows.length; r++) {
      const v = sh[XLSX.utils.encode_cell({ r, c: 9 })]; if (v && typeof v.v === "number") v.z = money;
      const u = sh[XLSX.utils.encode_cell({ r, c: 8 })]; if (u && typeof u.v === "number") u.z = "#,##0.0000";
    }
    if (sorted.length) { sh[XLSX.utils.encode_cell({ r: rows.length - 1, c: 0 })].s = B; sh["!autofilter"] = { ref: `A1:M${rows.length - 1}` }; }
    XLSX.utils.book_append_sheet(wb, sh, `${inv.name} transactions`);
  }
  return { wb, totals };
}

export function fileName(period) { return `Oryx stock movements - ${period.label}.xlsx`; }

export function emailHtml({ period, inventories, totals }) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = totals.map((t) => {
    const inv = inventories.find((i) => i.name === t.name);
    const s = t.sum;
    return `<tr><td style="padding:6px 10px"><b>${esc(t.name)}</b></td>
      <td style="padding:6px 10px;text-align:right">${s["Check-in"].docs} / AED ${fmt(s["Check-in"].value)}</td>
      <td style="padding:6px 10px;text-align:right">${s["Check-out"].docs} / AED ${fmt(Math.abs(s["Check-out"].value))}</td>
      <td style="padding:6px 10px;text-align:right">${inv.closing == null ? "—" : "AED " + fmt(inv.closing)}</td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0F2C3F">
    <p>Hello,</p><p>Attached is the stock movements report for <b>${esc(period.label)}</b> (Freedom and Renson): a summary and every Check-in, Check-out and adjustment line.</p>
    <table style="border-collapse:collapse;border:1px solid #D5DDE1"><tr style="background:#0F2C3F;color:#fff">
    <th style="padding:6px 10px;text-align:left">Inventory</th><th style="padding:6px 10px">Check-ins (documents / value)</th>
    <th style="padding:6px 10px">Check-outs (jobs / value)</th><th style="padding:6px 10px">Stock value at month end</th></tr>${rows}</table>
    <p style="color:#555;font-size:12px">Sent automatically by Oryx StockFlow on the 1st of each month.</p></div>`;
}
