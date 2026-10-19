/* Purchase price export: Excel (.xlsx) or PDF (the browser's own print ->
 * "Save as PDF") of the purchase price history.
 *
 * Opened from Master Inventory -> Transaction History ("Purchase prices",
 * a window with item / dates / supplier / format) and from the item panel's
 * "Purchase prices" list (one item). window.ORYX_PRICE_EXPORT.
 *
 * Read-only. It reads the same saved Check-in lines as the price notes
 * (inventory_transactions, staff-only read) and uses the same rules
 * (price-history.js: what counts as a purchase, how changes are compared),
 * so the screen, the Excel file and the PDF always agree. Nothing is written.
 */
(function () {
  const P = () => window.ORYX_PRICES;
  const sb = () => window.ORYX_AUTH.sb;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
  const TX_COLS = "id,item_id,type,item_code,description,quantity,unit,unit_cost_used,original_unit_cost,original_currency," +
    "exchange_rate,supplier,invoice_number,po_number,document_date,created_at";

  const pad = (n) => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const niceDay = (day) => {
    if (!day) return "";
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const num = (v, max) => (v == null || v === "" ? "" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max || 4 }));
  // A real Excel date (sorts and filters as a date), "" when unknown.
  const xlDate = (day) => { if (!day) return ""; const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
  const supplierPrice = (t) => (t && t.original_unit_cost != null ? `${t.original_currency || ""} ${num(t.original_unit_cost)}`.trim() : "");

  // ---- data -------------------------------------------------------------

  async function fetchPurchases(itemId) {
    const PAGE = 1000, all = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb().from("inventory_transactions").select(TX_COLS)
        .eq("type", "check_in").not("original_unit_cost", "is", null);
      if (itemId) q = q.eq("item_id", itemId);
      const { data, error } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  async function fetchItems(itemId) {
    let q = sb().from("inventory_items").select("id,item_code,description,unit_of_measure,unit_cost,bar_length_mm");
    if (itemId) q = q.eq("id", itemId);
    const { data, error } = await q.order("item_code");
    if (error) throw error;
    return new Map(data.map((it) => [it.id, it]));
  }

  // The item as Master Inventory names it now (falls back to the line's own).
  function itemInfo(items, t) {
    const it = items.get(t.item_id);
    const len = it && Number(it.bar_length_mm) > 0 ? Math.round(Number(it.bar_length_mm)) : null;
    return {
      code: (it && it.item_code) || t.item_code || "",
      name: (it && it.description) || t.description || "",
      length: len,
      unit: (it && it.unit_of_measure) || t.unit || "",
      master: it && Number(it.unit_cost) > 0 ? Number(it.unit_cost) : null,
    };
  }

  // Change as a number for Excel (0.13 = +13%), "" when there is nothing to
  // compare with, and a short note saying how it was compared.
  function changeCells(change, previous) {
    if (!previous) return { pct: "", note: "First purchase on record" };
    if (!change) return { pct: "", note: "Not compared (different unit)" };
    const note = change.change === "same" ? "Same price" : change.basis === "aed" ? "Compared in AED (different currency)" : `Compared in ${change.currency}`;
    return { pct: change.change === "same" ? 0 : change.pct, note };
  }
  const changeText = (change, previous) => (!previous ? "first" : !change ? "—" : P().pctText(change));

  // ---- Excel ------------------------------------------------------------

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = XLSX_SRC; s.onload = res; s.onerror = () => rej(new Error("couldn't load the Excel library"));
      document.head.appendChild(s);
    });
  }

  const BRAND = "022A3A";
  const S_TITLE = { font: { bold: true, sz: 14, color: { rgb: BRAND } } };
  const S_SUB = { font: { italic: true, color: { rgb: "5B6B72" } } };
  const S_HEAD = { fill: { fgColor: { rgb: BRAND } }, font: { bold: true, color: { rgb: "FFFFFF" } }, alignment: { vertical: "center", wrapText: true } };
  const S_UP = { font: { bold: true, color: { rgb: "8A5A0F" } }, fill: { fgColor: { rgb: "FEF3C7" } } };
  const S_DOWN = { font: { bold: true, color: { rgb: "2F6F5E" } }, fill: { fgColor: { rgb: "E3F1EC" } } };

  // One sheet: title, filter line, blank, header, rows. formats: {col: numFmt}.
  function sheet(title, sub, head, rows, widths, formats, pctCol) {
    const X = window.XLSX;
    const ws = X.utils.aoa_to_sheet([[title], [sub], [], head, ...rows]);
    ws["!cols"] = widths.map((w) => ({ wch: w }));
    ws["!rows"] = [{ hpt: 22 }, null, null, { hpt: 30 }];
    ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + rows.length, c: head.length - 1 } }) };
    ws.A1.s = S_TITLE; ws.A2.s = S_SUB;
    for (let c = 0; c < head.length; c++) ws[X.utils.encode_cell({ r: 3, c })].s = S_HEAD;
    for (let r = 0; r < rows.length; r++) {
      for (const [c, z] of Object.entries(formats)) {
        const cell = ws[X.utils.encode_cell({ r: r + 4, c: Number(c) })];
        if (cell && typeof cell.v === "number") cell.z = z;
      }
      if (pctCol != null) {
        const cell = ws[X.utils.encode_cell({ r: r + 4, c: pctCol })];
        if (cell && typeof cell.v === "number" && cell.v !== 0) cell.s = cell.v > 0 ? S_UP : S_DOWN;
      }
    }
    return ws;
  }

  function buildWorkbook(report, latest, items, sub) {
    const X = window.XLSX;
    const AED = '#,##0.00', PRICE = '#,##0.00##', PCT = '+0.0%;-0.0%;0%', DAY = 'dd mmm yyyy';
    const allRows = report.map(({ t, change, previous, day }) => {
      const it = itemInfo(items, t), ch = changeCells(change, previous);
      return [xlDate(day), it.code, it.name, it.length || "", t.supplier || "", t.invoice_number || "", xlDate(P().invoiceDay(t)), t.po_number || "",
        Number(t.quantity) || "", it.unit, t.original_currency || "", Number(t.original_unit_cost),
        t.exchange_rate != null ? Number(t.exchange_rate) : "", Number(t.unit_cost_used), ch.pct, ch.note,
        previous ? supplierPrice(previous) : "", it.master != null ? it.master : ""];
    });
    const ws1 = sheet("Oryx Doors & Windows — Purchase prices", sub,
      ["Checked in", "Code", "Item", "Length (mm)", "Supplier", "Invoice no.", "Invoice date", "PO no.", "Qty", "Unit", "Currency",
        "Supplier price", "Exchange rate", "AED per unit (incl. shipping)", "Change vs last purchase", "How compared",
        "Last purchase price", "Master cost (AED)"],
      allRows, [12, 10, 38, 10, 24, 18, 12, 12, 8, 7, 9, 13, 10, 14, 12, 30, 16, 12],
      { 0: DAY, 6: DAY, 11: PRICE, 12: '0.0000', 13: AED, 14: PCT, 17: AED }, 14);

    const latestRows = latest.map((g) => {
      const it = itemInfo(items, g.last), ch = changeCells(g.change, g.previous);
      return [it.code, it.name, it.length || "", it.unit, g.count, xlDate(g.day), g.last.supplier || "", g.last.invoice_number || "",
        supplierPrice(g.last), Number(g.last.unit_cost_used), g.previous ? supplierPrice(g.previous) : "",
        g.previous ? Number(g.previous.unit_cost_used) : "", ch.pct, g.low, g.high, it.master != null ? it.master : ""];
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || (Number(a[2]) || 0) - (Number(b[2]) || 0));
    const ws2 = sheet("Oryx Doors & Windows — Latest purchase price per item", sub,
      ["Code", "Item", "Length (mm)", "Unit", "Purchases", "Last checked in", "Last supplier", "Last invoice",
        "Last supplier price", "Last AED per unit", "Previous supplier price", "Previous AED per unit", "Change",
        "Lowest AED", "Highest AED", "Master cost (AED)"],
      latestRows, [10, 38, 10, 7, 10, 12, 24, 18, 16, 13, 16, 13, 10, 11, 11, 12],
      { 5: DAY, 9: AED, 11: AED, 12: PCT, 13: AED, 14: AED, 15: AED }, 12);

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws1, "All purchases");
    X.utils.book_append_sheet(wb, ws2, "Latest price per item");
    return wb;
  }

  // ---- PDF (print) ------------------------------------------------------

  function printHtml(report, items, sub) {
    const rows = report.map(({ t, change, previous, day }) => {
      const it = itemInfo(items, t);
      const ch = changeText(change, previous);
      const cls = change && change.change === "up" ? "up" : change && change.change === "down" ? "down" : "muted";
      return `<tr><td>${esc(niceDay(day))}</td><td><b>${esc(it.code)}</b> ${esc(it.name)}${it.length ? ` · ${it.length} mm` : ""}</td>
        <td>${esc(t.supplier || "")}${t.invoice_number ? `<div class="muted">${esc(t.invoice_number)}${P().invoiceDay(t) ? ` · ${esc(niceDay(P().invoiceDay(t)))}` : ""}</div>` : ""}</td>
        <td class="r">${esc(Number(t.quantity).toLocaleString("en-US", { maximumFractionDigits: 2 }))} ${esc(it.unit)}</td><td class="r">${esc(supplierPrice(t))}</td>
        <td class="r">${esc(num(t.unit_cost_used, 2))}</td><td class="r ${cls}">${esc(ch)}</td></tr>`;
    }).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Oryx Purchase Prices - ${today()}</title>
      <style>
        @page{size:A4 landscape; margin:12mm}
        body{font:11px/1.4 Arial,Helvetica,sans-serif; color:#022A3A; margin:0}
        h1{font-size:17px; margin:0}
        .sub{color:#5B6B72; margin:2px 0 12px}
        table{width:100%; border-collapse:collapse}
        thead{display:table-header-group}
        th{background:#022A3A; color:#fff; text-align:left; padding:5px 6px; font-size:10.5px;
           -webkit-print-color-adjust:exact; print-color-adjust:exact}
        td{padding:5px 6px; border-bottom:1px solid #DCE3E6; vertical-align:top}
        tr{page-break-inside:avoid}
        .r{text-align:right; white-space:nowrap}
        .muted{color:#5B6B72}
        .up{color:#8A5A0F; font-weight:bold} .down{color:#2F6F5E; font-weight:bold}
        .foot{margin-top:10px; color:#5B6B72; font-size:10px}
      </style></head><body>
      <h1>Oryx Doors &amp; Windows — Purchase prices</h1>
      <div class="sub">${esc(sub)}</div>
      <table><thead><tr><th>Checked in</th><th>Item</th><th>Supplier · Invoice</th><th class="r">Qty</th>
        <th class="r">Supplier price</th><th class="r">AED / unit</th><th class="r">Change</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="foot">AED per unit includes shipping. Change = compared with the purchase before of the same item
        (supplier price when the currency is the same, otherwise AED). Manual corrections and stock counts are not purchases.</p>
      </body></html>`;
  }

  // A hidden frame on this page (a new window would be blocked: the data
  // arrives after the click). The browser's print window offers "Save as PDF".
  function printReport(html) {
    const old = $("#ppPrintFrame");
    if (old) old.remove();
    const f = document.createElement("iframe");
    f.id = "ppPrintFrame";
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden";
    document.body.appendChild(f);
    const doc = f.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); }, 250);
  }

  // ---- one export -------------------------------------------------------

  function filterLine(f, items, supplierCount) {
    const it = f.itemId && items.get(f.itemId);
    return [
      it ? `${it.item_code} ${it.description}${Number(it.bar_length_mm) > 0 ? ` · ${Math.round(it.bar_length_mm)} mm` : ""}` : "All items",
      f.from || f.to ? `checked in ${f.from ? niceDay(f.from) : "from the first purchase"} – ${f.to ? niceDay(f.to) : "today"}` : "All dates",
      f.supplier || (supplierCount === 1 ? "" : "All suppliers"),
      `exported ${niceDay(today())}`,
    ].filter(Boolean).join(" · ");
  }

  function fileName(f, items, ext) {
    const it = f.itemId && items.get(f.itemId);
    return `Oryx Purchase Prices${it ? " - " + it.item_code : ""} - ${today()}.${ext}`;
  }

  // Excel or PDF of the given rows. Returns a short message for the screen.
  async function produce(data, f, format) {
    const report = P().purchaseReport(data.txs, f);
    if (!report.length) return { ok: false, msg: "No purchases match these choices — nothing to export." };
    const suppliers = new Set(report.map((r) => r.t.supplier));
    const sub = filterLine(f, data.items, suppliers.size);
    if (format === "pdf") {
      printReport(printHtml(report, data.items, sub));
      return { ok: true, msg: `Print window opened (${report.length} purchase${report.length === 1 ? "" : "s"}). Choose "Save as PDF" there.` };
    }
    await loadXlsx();
    const name = fileName(f, data.items, "xlsx");
    window.XLSX.writeFile(buildWorkbook(report, P().latestPerItem(report), data.items, sub), name);
    return { ok: true, msg: `Exported ${report.length} purchase${report.length === 1 ? "" : "s"} as ${name}.` };
  }

  // Item panel: one item, all dates, straight away.
  async function downloadItem(itemId, format, statusEl) {
    const say = (m, err) => { if (statusEl) { statusEl.textContent = m; statusEl.style.color = err ? "var(--danger)" : ""; } };
    say(format === "pdf" ? "Preparing the PDF…" : "Preparing the Excel file…");
    try {
      const [txs, items] = await Promise.all([fetchPurchases(itemId), fetchItems(itemId)]);
      const r = await produce({ txs, items }, { itemId }, format);
      say(r.msg, !r.ok);
    } catch (err) {
      console.error("purchase price export", err);
      say("Could not export: " + err.message, true);
    }
  }

  // ---- the window (Master Inventory) -------------------------------------

  let dlgData = null;

  function dialogEl() {
    let d = $("#ppExportDialog");
    if (d) return d;
    d = document.createElement("dialog");
    d.id = "ppExportDialog";
    d.setAttribute("aria-labelledby", "ppExportTitle");
    d.innerHTML = `<div class="pp-dlg">
      <h3 id="ppExportTitle" style="margin-top:0">Export purchase prices</h3>
      <p class="small muted" style="margin-top:0">Every price paid on a Check-in, with the supplier, invoice and the change from the purchase before.</p>
      <label class="field-label" for="ppItem">Item</label>
      <input id="ppItem" list="ppItemList" autocomplete="off" placeholder="All items — type a code or name to pick one">
      <datalist id="ppItemList"></datalist>
      <div class="pp-two">
        <div><label class="field-label" for="ppFrom">Checked in from</label><input id="ppFrom" type="date"></div>
        <div><label class="field-label" for="ppTo">To</label><input id="ppTo" type="date"></div>
      </div>
      <p class="small muted" style="margin:4px 0 0">Dates are when the stock was checked in. The invoice's own date is in the file too.</p>
      <label class="field-label" for="ppSupplier">Supplier</label>
      <select id="ppSupplier"><option value="">All suppliers</option></select>
      <span class="field-label" style="display:block; margin-top:12px">Format</span>
      <label class="pp-opt"><input type="radio" name="ppFormat" value="xlsx" checked>
        <span><b>Excel (.xlsx)</b><span class="small muted" style="display:block">Two sheets: every purchase, and one line per item with its latest price.</span></span></label>
      <label class="pp-opt"><input type="radio" name="ppFormat" value="pdf">
        <span><b>PDF / Print</b><span class="small muted" style="display:block">A clean printable page. Choose "Save as PDF" in the print window.</span></span></label>
      <p class="small" id="ppCount" style="margin:12px 0 0" role="status" aria-live="polite"></p>
      <div class="bar">
        <button class="ghost" type="button" id="ppCancel">Cancel</button>
        <button class="btn-accent" type="button" id="ppDownload">Download</button>
      </div>
    </div>`;
    document.body.appendChild(d);
    $("#ppCancel", d).addEventListener("click", () => d.close());
    for (const id of ["#ppItem", "#ppFrom", "#ppTo", "#ppSupplier"]) {
      $(id, d).addEventListener("input", updateCount);
      $(id, d).addEventListener("change", updateCount);
    }
    $("#ppDownload", d).addEventListener("click", onDownload);
    return d;
  }

  const itemLabel = (it) => `${it.item_code} — ${it.description}${Number(it.bar_length_mm) > 0 ? ` (${Math.round(it.bar_length_mm)} mm)` : ""}`;

  function chosenFilters() {
    const d = dialogEl();
    const typed = $("#ppItem", d).value.trim();
    let itemId = null, badItem = false;
    if (typed && dlgData) {
      const hit = dlgData.itemByLabel.get(typed) ||
        [...dlgData.items.values()].filter((it) => String(it.item_code).toLowerCase() === typed.toLowerCase());
      if (hit && hit.id) itemId = hit.id;
      else if (Array.isArray(hit) && hit.length === 1) itemId = hit[0].id;
      else badItem = true;
    }
    return { itemId, badItem, from: $("#ppFrom", d).value || null, to: $("#ppTo", d).value || null, supplier: $("#ppSupplier", d).value || null };
  }

  function updateCount() {
    const d = dialogEl(), out = $("#ppCount", d), btn = $("#ppDownload", d);
    if (!dlgData) return;
    const f = chosenFilters();
    if (f.badItem) {
      out.textContent = "Pick an item from the list (or a code with one length), or clear the box for all items.";
      out.style.color = "var(--danger)"; btn.disabled = true; return;
    }
    if (f.from && f.to && f.from > f.to) { out.textContent = "“From” is after “To”."; out.style.color = "var(--danger)"; btn.disabled = true; return; }
    const rows = P().purchaseReport(dlgData.txs, f);
    const items = new Set(rows.map((r) => r.t.item_id)).size, sups = new Set(rows.map((r) => r.t.supplier)).size;
    out.style.color = "";
    out.textContent = rows.length
      ? `${rows.length} purchase${rows.length === 1 ? "" : "s"} · ${items} item${items === 1 ? "" : "s"} · ${sups} supplier${sups === 1 ? "" : "s"}`
      : "No purchases match these choices.";
    btn.disabled = !rows.length;
  }

  async function onDownload() {
    const d = dialogEl(), btn = $("#ppDownload", d), out = $("#ppCount", d);
    const f = chosenFilters();
    if (f.badItem || !dlgData) return;
    const format = (d.querySelector('input[name="ppFormat"]:checked') || {}).value || "xlsx";
    btn.disabled = true;
    try {
      const r = await produce(dlgData, f, format);
      const st = $("#miExportStatus");
      if (r.ok) { d.close(); if (st) { st.textContent = r.msg; st.style.color = ""; } }
      else { out.textContent = r.msg; }
    } catch (err) {
      console.error("purchase price export", err);
      out.textContent = "Could not export: " + err.message; out.style.color = "var(--danger)";
    } finally { btn.disabled = false; }
  }

  async function openDialog() {
    const d = dialogEl(), out = $("#ppCount", d), btn = $("#ppDownload", d);
    dlgData = null;
    $("#ppItem", d).value = ""; $("#ppFrom", d).value = ""; $("#ppTo", d).value = "";
    out.textContent = "Reading the purchase prices…"; out.style.color = ""; btn.disabled = true;
    if (!d.open) d.showModal();
    try {
      const [txs, items] = await Promise.all([fetchPurchases(null), fetchItems(null)]);
      const purchases = txs.filter(P().isPurchase);
      // Pick list: only items that have a purchase; suppliers likewise.
      const withPrice = [...new Set(purchases.map((t) => t.item_id))].map((id) => items.get(id)).filter(Boolean)
        .sort((a, b) => String(a.item_code).localeCompare(String(b.item_code)) || (Number(a.bar_length_mm) || 0) - (Number(b.bar_length_mm) || 0));
      const itemByLabel = new Map(withPrice.map((it) => [itemLabel(it), it]));
      $("#ppItemList", d).innerHTML = withPrice.map((it) => `<option value="${esc(itemLabel(it))}"></option>`).join("");
      const sel = $("#ppSupplier", d);
      const sups = [...new Set(purchases.map((t) => t.supplier).filter(Boolean))].sort();
      sel.innerHTML = `<option value="">All suppliers</option>` + sups.map((s) => `<option>${esc(s)}</option>`).join("");
      dlgData = { txs, items, itemByLabel };
      updateCount();
    } catch (err) {
      console.error("purchase price export", err);
      out.textContent = "Could not read the purchase prices: " + err.message; out.style.color = "var(--danger)";
    }
  }

  const btn = $("#miPriceBtn");
  if (btn) btn.addEventListener("click", openDialog);

  window.ORYX_PRICE_EXPORT = { openDialog, downloadItem };
})();
