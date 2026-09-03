/* FP Pro Optimization tab.
 *
 * Reads an FP Pro optimisation PDF and the Flyscreen stock Excel file,
 * matches every item against the stock file, checks nothing goes negative,
 * and — only after the user clicks Confirm — writes an updated stock file
 * with a new job column and the quantities filled in. Everything runs in
 * the browser; the original stock file is never modified.
 *
 * The stock file's own formulas (Consumption AO, Available Stock AU,
 * Available Stock Cost AV, Inventory Value AW, Reorder AY) are left
 * intact — we only write into the first empty job column (N..AN). Excel
 * recalculates the rest when the file is opened. */

(function () {
  const $ = (s) => document.querySelector(s);

  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const HISTORY_KEY = "oryx_fp_history_v1";

  let libsPromise = null;
  function loadLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = Promise.all([
      import(/* @vite-ignore */ PDFJS_SRC).then((m) => {
        m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        window.__pdfjs = m;
      }),
      new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = XLSX_SRC;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Could not load SheetJS from CDN."));
        document.head.appendChild(s);
      }),
    ]);
    return libsPromise;
  }

  /* --------------------------- State ------------------------- */
  const state = {
    pdfFile: null, stockFile: null,
    pdfHash: null,
    parsedJob: null,
    rows: null,
    stockWb: null,
    stockMeta: null,
  };

  /* --------------------------- Duplicate-PDF tracking -------- */

  async function pdfFingerprint(file) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function readHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); } catch { return {}; }
  }
  function writeHistory(obj) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(obj)); } catch {}
  }

  /* --------------------------- PDF parsing ------------------- */

  async function extractPdfText(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    const pdf = await window.__pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let lastY = null;
      let pageText = "";
      for (const item of content.items) {
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) pageText += "\n";
        else if (pageText && !pageText.endsWith(" ")) pageText += " ";
        pageText += item.str;
        lastY = y;
      }
      pages.push(pageText);
    }
    return pages.join("\n\n");
  }

  function parseJobHeader(text) {
    return {
      ref: (text.match(/Job\/Group:\s*(\S+)/) || [])[1] || "",
      user: (text.match(/User:\s*([^\n]+?)(?:\s{2,}|\n|$)/) || [])[1] || "",
      description: (text.match(/Description:\s*([^\n]+)/) || [])[1] || "",
      printedAt: (text.match(/Printout date\/time:\s*([^\n]+?)(?:Pagina|\n|$)/) || [])[1] || "",
    };
  }

  function splitSections(text) {
    const sections = [];
    const fitStart = text.search(/Fittings List\s*\(1 of/);
    if (fitStart !== -1) {
      const rest = text.slice(fitStart);
      const end = rest.search(/Bars Optimization Report|Items list-/);
      sections.push({ kind: "fittings", text: end === -1 ? rest : rest.slice(0, end) });
    }
    const barStart = text.search(/Bars Optimization Report\s*\(1 of/);
    if (barStart !== -1) {
      const rest = text.slice(barStart);
      const end = rest.search(/Items list-/);
      sections.push({ kind: "bars", text: end === -1 ? rest : rest.slice(0, end) });
    }
    return sections;
  }

  const CODE_RE = /^([0-9]+R?)-/;
  function parseFittings(text) {
    const out = [];
    const entries = text.split(/\bORYX\b/).slice(1);
    for (const raw of entries) {
      const cleaned = raw.replace(/\s+/g, " ").trim();
      const codeMatch = cleaned.match(/^([\w-()]+)/);
      if (!codeMatch) continue;
      const fullCode = codeMatch[1];
      const codeM = fullCode.match(CODE_RE);
      if (!codeM) continue;
      const code = codeM[1];
      const rest = cleaned.slice(fullCode.length).trim();
      const qtyMatch = rest.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(m\b)?\s+(.+)$/);
      if (!qtyMatch) continue;
      const qty = parseFloat(qtyMatch[1]);
      const unit = qtyMatch[2] ? "m" : "pcs";
      const description = qtyMatch[3].trim();
      out.push({ kind: "fitting", code, qty, unit, description });
    }
    return out;
  }

  function parseBars(text) {
    const out = [];
    const re = /Bars:\s*(\d+)\s*x\s*(\d+)[\s\S]*?Description:\s*([^\n]+?)\s*Total length:\s*([\d.]+)\s*m/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const bars = parseInt(m[1], 10);
      const barLenMm = parseInt(m[2], 10);
      const desc = m[3].trim();
      const totalLenM = parseFloat(m[4]);
      const codeM = desc.match(/(\d+)\s*[-–]/);
      const code = codeM ? codeM[1] : "";
      out.push({ kind: "bar", code, description: desc, bars, barLenMm, totalLenM });
    }
    return out;
  }

  // Aggregate:
  //   Fittings — same code+unit summed
  //   Bars     — same code+barLen summed; different bar lengths stay separate
  function aggregate(entries) {
    const byKey = new Map();
    for (const e of entries) {
      if (!e.code) continue;
      const key = e.kind === "bar"
        ? `bar|${e.code}|${e.barLenMm}`
        : `fit|${e.code}|${e.unit}`;
      const cur = byKey.get(key);
      if (cur) {
        if (e.kind === "bar") { cur.bars += e.bars; cur.totalLenM += e.totalLenM; }
        else { cur.qty += e.qty; }
      } else {
        byKey.set(key, { ...e });
      }
    }
    return [...byKey.values()];
  }

  function parsePdf(text) {
    const all = [];
    for (const s of splitSections(text)) {
      const entries = s.kind === "fittings" ? parseFittings(s.text) : parseBars(s.text);
      for (const e of entries) all.push(e);
    }
    return aggregate(all);
  }

  /* --------------------------- Stock file inspection --------- */

  async function loadStockFile(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array", cellStyles: true, cellFormula: true });
    if (!wb.Sheets["STOCK"]) throw new Error('The uploaded file has no "STOCK" sheet — is it the right file?');
    return wb;
  }

  function codeFromPartName(partName) {
    if (!partName) return "";
    const m = String(partName).match(/^\s*(\d+[A-Z]?)/);
    return m ? m[1] : "";
  }

  function inspectStock(wb) {
    const XLSX = window.XLSX;
    const ws = wb.Sheets["STOCK"];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const HEADER_ROW = 1;
    const headers = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: HEADER_ROW, c })];
      if (cell && cell.v != null) headers[c] = String(cell.v).trim();
    }
    let partCodeCol = null, availStockCol = null, lengthCol = null, openCostCol = null;
    for (const [c, h] of Object.entries(headers)) {
      const hh = h.toUpperCase();
      if (partCodeCol === null && /CHILD PROFILE PART CODE|PART CODE/.test(hh)) partCodeCol = +c;
      if (availStockCol === null && hh === "AVAILABLE STOCK") availStockCol = +c;
      if (lengthCol === null && hh === "LENGTH") lengthCol = +c;
      if (openCostCol === null && /OPENING COST PER PROFILE/.test(hh)) openCostCol = +c;
    }
    if (partCodeCol === null) throw new Error('Could not find the "Child Profile Part code" column in the STOCK sheet.');

    // Build lookup: code -> list of stock rows (each with row index + length + avail + cost + description).
    const codeToRows = new Map();
    for (let r = HEADER_ROW + 1; r <= range.e.r; r++) {
      const partCell = ws[XLSX.utils.encode_cell({ r, c: partCodeCol })];
      const partName = partCell && partCell.v != null ? String(partCell.v) : "";
      const code = codeFromPartName(partName);
      if (!code) continue;
      const lenCell = lengthCol != null ? ws[XLSX.utils.encode_cell({ r, c: lengthCol })] : null;
      const availCell = availStockCol != null ? ws[XLSX.utils.encode_cell({ r, c: availStockCol })] : null;
      const costCell = openCostCol != null ? ws[XLSX.utils.encode_cell({ r, c: openCostCol })] : null;
      const arr = codeToRows.get(code) || [];
      arr.push({
        row: r,
        partName,
        length: lenCell ? lenCell.v : null,
        available: availCell && typeof availCell.v === "number" ? availCell.v : Number(availCell?.v) || 0,
        cost: costCell && typeof costCell.v === "number" ? costCell.v : Number(costCell?.v) || 0,
      });
      codeToRows.set(code, arr);
    }
    // Find target job column: first empty header slot in N..AN.
    let targetCol = null;
    for (let c = 13; c <= 39; c++) {
      if (!headers[c] || headers[c] === "") { targetCol = c; break; }
    }
    return {
      range, HEADER_ROW, headers,
      partCodeCol, availStockCol, lengthCol, openCostCol,
      codeToRows, targetCol, willInsert: targetCol === null,
    };
  }

  /* --------------------------- Match PDF entries to stock ---- */

  // Best-stock-row picker. For bars: prefer row whose length matches the
  // PDF's bar length in metres. For fittings: prefer row with non-zero cost
  // (skips dummy placeholder rows). Falls back to first row otherwise.
  function pickStockRow(entry, candidates) {
    if (!candidates || !candidates.length) return null;
    if (entry.kind === "bar") {
      const targetM = entry.barLenMm / 1000;
      const exact = candidates.find((c) => typeof c.length === "number" && Math.abs(c.length - targetM) < 0.05);
      if (exact) return exact;
      // If no exact match, prefer any candidate with a numeric length that's closest.
      const numeric = candidates.filter((c) => typeof c.length === "number");
      if (numeric.length) {
        return numeric.reduce((best, c) =>
          !best || Math.abs(c.length - targetM) < Math.abs(best.length - targetM) ? c : best, null);
      }
      // Fall back to non-zero-cost row, else first row.
      const active = candidates.find((c) => c.cost && c.available !== 0) || candidates.find((c) => c.cost);
      return active || candidates[0];
    }
    // Fitting: prefer a real row (non-zero cost or non-zero available).
    const active = candidates.find((c) => c.cost || (c.available && c.available !== 0));
    return active || candidates[0];
  }

  function buildRows(entries, stockMeta) {
    const rows = [];
    for (const e of entries) {
      const candidates = stockMeta.codeToRows.get(e.code) || [];
      const stockRow = pickStockRow(e, candidates);

      // Effective PDF quantity for stock deduction:
      //   Fittings: qty as-is (pcs / m)
      //   Bars: bar count
      const requiredQty = e.kind === "bar" ? e.bars : e.qty;
      const unit = e.kind === "bar" ? "bars" : e.unit;
      const pdfDetail = e.kind === "bar" ? `${e.bars} × ${e.barLenMm} mm` : "";

      if (!stockRow) {
        rows.push({
          kind: e.kind, code: e.code,
          description: e.description, pdfDetail,
          requiredQty, unit,
          available: null, remaining: null,
          costPerUnit: 0, estValue: 0,
          status: "unmatched", baseStatus: "unmatched",
          action: "pending", decided: false,
          stockRowIndex: null, hasVariants: false,
        });
        continue;
      }
      const remaining = stockRow.available - requiredQty;
      const status = remaining < 0 ? "shortage" : "ok";
      rows.push({
        kind: e.kind, code: e.code,
        description: stockRow.partName || e.description, pdfDetail,
        requiredQty, unit,
        available: stockRow.available, remaining,
        costPerUnit: stockRow.cost || 0,
        estValue: requiredQty * (stockRow.cost || 0),
        status, baseStatus: status,
        action: status === "ok" ? "deduct" : "pending",
        decided: status === "ok",
        stockRowIndex: stockRow.row,
        hasVariants: candidates.length > 1,
      });
    }
    return rows;
  }

  /* --------------------------- Render ------------------------ */

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Math.round(n * 100) / 100;
  }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    // The Stock file's own cost/value columns are formatted as AED
    // ([$AED] #,##0.00) — matching that here rather than assuming a currency.
    return "AED " + fmt(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function statusChip(status) {
    if (status === "ok") return `<span class="fp-status-ok">OK</span>`;
    if (status === "shortage") return `<span class="fp-status-short">Shortage</span>`;
    if (status === "unmatched") return `<span class="fp-status-unmatched">Unmatched</span>`;
    if (status === "skipped") return `<span class="fp-status-skip">Skipped</span>`;
    return `<span class="fp-status-skip">${esc(status)}</span>`;
  }

  function unresolvedByStatus() {
    return {
      shortage: state.rows.filter((r) => !r.decided && r.baseStatus === "shortage").length,
      unmatched: state.rows.filter((r) => !r.decided && r.baseStatus === "unmatched").length,
    };
  }
  function tallyTotals() {
    const active = state.rows.filter((r) => r.action === "deduct");
    return {
      totalItems: active.length,
      totalValue: active.reduce((s, r) => s + (r.estValue || 0), 0),
      shortages: state.rows.filter((r) => r.decided && r.baseStatus === "shortage" && r.action === "deduct").length,
      skipped: state.rows.filter((r) => r.decided && r.action === "skip").length,
      unresolved: state.rows.filter((r) => !r.decided).length,
    };
  }

  function renderRowActionButtons(idx, row) {
    const on = (yes) => yes ? "on" : "";
    if (row.baseStatus === "ok") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.action === "skip")}">Skip</button>
        ${row.action === "skip" ? `<button data-act="deduct" data-i="${idx}">Undo</button>` : ""}
      </div>`;
    }
    if (row.baseStatus === "shortage") {
      return `<div class="fp-row-actions">
        <button data-act="deduct" data-i="${idx}" class="${on(row.decided && row.action === "deduct")}">Allow negative</button>
        <button data-act="skip" data-i="${idx}" class="${on(row.decided && row.action === "skip")}">Skip</button>
      </div>`;
    }
    if (row.baseStatus === "unmatched") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Skip (acknowledge)</button>
      </div>`;
    }
    return "";
  }

  function applyRowAction(idx, act) {
    // Batch actions
    if (act === "skip-all-shortage" || act === "allow-all-shortage" || act === "skip-all-unmatched") {
      state.rows.forEach((rr) => {
        if (rr.decided) return;
        if (act === "skip-all-shortage" && rr.baseStatus === "shortage") { rr.action = "skip"; rr.decided = true; }
        if (act === "allow-all-shortage" && rr.baseStatus === "shortage") { rr.action = "deduct"; rr.decided = true; }
        if (act === "skip-all-unmatched" && rr.baseStatus === "unmatched") { rr.action = "skip"; rr.decided = true; }
      });
      render();
      return;
    }
    const r = state.rows[idx];
    if (!r) return;
    if (act === "skip") { r.action = "skip"; r.decided = true; }
    else if (act === "deduct") { r.action = "deduct"; r.decided = true; }
    render();
  }

  function render() {
    const job = state.parsedJob;
    const t = tallyTotals();
    const u = unresolvedByStatus();

    const historyHit = state.pdfHash && (readHistory()[state.pdfHash]);
    const historyWarn = historyHit
      ? `<div class="fp-warn">
          <h4>This PDF has already been processed</h4>
          <p class="small">Same file was allocated on <b>${esc(historyHit.processedAt)}</b>
          for job <code>${esc(historyHit.jobRef)}</code> (${esc(historyHit.client)}). Deducting
          again would double-count. Reset and use a different PDF unless this is intentional.</p>
        </div>`
      : "";

    const rowsHtml = state.rows.map((r, i) => {
      const rowClass = r.decided && r.action === "skip" ? "fp-skipped" : "";
      const remainingClass = r.remaining != null && r.remaining < 0 ? 'style="color:var(--danger); font-weight:600"' : "";
      const displayStatus = r.decided && r.action === "skip" ? "skipped" : r.status;
      const variantNote = r.hasVariants
        ? `<div class="small muted">Code has multiple stock rows — the row with the best cost/length match was used.</div>`
        : "";
      return `<tr class="${rowClass}">
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.description)}
          ${r.pdfDetail ? `<div class="small muted">${esc(r.pdfDetail)}</div>` : ""}
          ${variantNote}</td>
        <td class="num">${fmt(r.requiredQty)} ${esc(r.unit)}</td>
        <td class="num">${r.available != null ? fmt(r.available) : "—"}</td>
        <td class="num" ${remainingClass}>${r.remaining != null ? fmt(r.remaining) : "—"}</td>
        <td class="num">${money(r.estValue)}</td>
        <td>${statusChip(displayStatus)}</td>
        <td>${renderRowActionButtons(i, r)}</td>
      </tr>`;
    }).join("");

    const warnBox = t.unresolved > 0 ? `<div class="fp-warn">
      <h4>${t.unresolved} row${t.unresolved === 1 ? "" : "s"} need${t.unresolved === 1 ? "s" : ""} a decision</h4>
      <ul>
        ${u.shortage ? `<li><b>${u.shortage} shortage${u.shortage === 1 ? "" : "s"}</b> — required qty exceeds available.
          <span class="fp-batch-actions">
            <button data-act="allow-all-shortage" data-i="-1">Allow all shortages</button>
            <button data-act="skip-all-shortage" data-i="-1">Skip all shortages</button>
          </span></li>` : ""}
        ${u.unmatched ? `<li><b>${u.unmatched} unmatched item${u.unmatched === 1 ? "" : "s"}</b> — code not in the stock file. Not deducted; click Acknowledge to confirm you've seen them.
          <span class="fp-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>` : ""}
      </ul>
    </div>` : "";

    $("#fpOut").innerHTML = `
      ${historyWarn}
      <div class="fp-jobcard">
        <div class="fp-jobfield"><label>Job ref</label><strong>${esc(job.ref || "—")}</strong></div>
        <div class="fp-jobfield"><label>PDF user</label><strong>${esc(job.user || "—")}</strong></div>
        <div class="fp-jobfield"><label>Description</label><strong>${esc(job.description || "—")}</strong></div>
        <div class="fp-jobfield"><label>Printed</label><strong>${esc(job.printedAt || "—")}</strong></div>
      </div>
      <div class="fp-tally">
        <div class="fp-tally-item"><strong>${t.totalItems}</strong><span>Items to deduct</span></div>
        <div class="fp-tally-item"><strong>${money(t.totalValue)}</strong><span>Est. value</span></div>
        <div class="fp-tally-item"><strong>${t.shortages}</strong><span>Shortages allowed</span></div>
        <div class="fp-tally-item"><strong>${t.skipped}</strong><span>Skipped</span></div>
        <div class="fp-tally-item"><strong>${t.unresolved}</strong><span>Unresolved</span></div>
      </div>
      ${warnBox}
      <div class="fp-section-h">Allocation preview</div>
      <div class="fp-scroll">
        <table class="fp-table">
          <thead><tr>
            <th>Code</th><th>Description</th>
            <th class="num">Required</th>
            <th class="num">Available</th>
            <th class="num">Remaining</th>
            <th class="num">Est. value</th>
            <th>Status</th><th>Action</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:var(--space-3)">Nothing has been deducted yet.
      The confirm button unlocks once every row shows OK, Shortage (allowed) or Skipped.</p>
    `;

    // Confirm bar summary + enable
    const canConfirm =
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !!$("#fpJobNumber").value.trim() &&
      !!$("#fpClient").value.trim() &&
      !historyHit;
    $("#fpConfirmSummary").textContent =
      `${t.totalItems} items · ${money(t.totalValue)}` +
      (t.shortages ? ` · ${t.shortages} shortage${t.shortages === 1 ? "" : "s"} allowed` : "") +
      (t.skipped ? ` · ${t.skipped} skipped` : "");
    $("#fpConfirmBar").hidden = false;
    $("#fpConfirm").disabled = !canConfirm;

    // Wire row / batch action buttons
    document.querySelectorAll("#fpOut .fp-row-actions button, #fpOut .fp-batch-actions button").forEach((b) => {
      b.addEventListener("click", () => applyRowAction(+b.dataset.i, b.dataset.act));
    });
  }

  /* --------------------------- Confirm & apply --------------- */

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function shiftColumnsRight(ws, fromCol, range) {
    const XLSX = window.XLSX;
    for (let c = range.e.c; c >= fromCol; c--) {
      for (let r = range.s.r; r <= range.e.r; r++) {
        const from = XLSX.utils.encode_cell({ r, c });
        const to = XLSX.utils.encode_cell({ r, c: c + 1 });
        if (ws[from]) { ws[to] = ws[from]; delete ws[from]; }
      }
    }
  }

  async function confirmAllocation() {
    const XLSX = window.XLSX;
    const jobRef = $("#fpJobNumber").value.trim();
    const client = $("#fpClient").value.trim();
    const newColHeader = `${jobRef}-${client}`;
    const wb = state.stockWb;
    const ws = wb.Sheets["STOCK"];
    const meta = state.stockMeta;

    let targetCol = meta.targetCol;
    let inserted = false;
    if (targetCol == null) {
      // Fallback: insert before Consumption (find it dynamically).
      targetCol = 40;
      for (const [c, h] of Object.entries(meta.headers)) {
        if (String(h).toUpperCase() === "CONSUMPTION") { targetCol = +c; break; }
      }
      shiftColumnsRight(ws, targetCol, meta.range);
      inserted = true;
    }

    // Header
    ws[XLSX.utils.encode_cell({ r: meta.HEADER_ROW, c: targetCol })] = { t: "s", v: newColHeader };

    // Quantities
    let deducted = 0;
    for (const r of state.rows) {
      if (r.action !== "deduct" || r.stockRowIndex == null) continue;
      ws[XLSX.utils.encode_cell({ r: r.stockRowIndex, c: targetCol })] = { t: "n", v: r.requiredQty };
      deducted++;
    }

    const newRange = { s: meta.range.s, e: { r: meta.range.e.r, c: Math.max(meta.range.e.c, targetCol) } };
    ws["!ref"] = XLSX.utils.encode_range(newRange);

    // Save fingerprint so a duplicate upload gets flagged next time.
    if (state.pdfHash) {
      const hist = readHistory();
      hist[state.pdfHash] = { jobRef, client, processedAt: todayISO() };
      writeHistory(hist);
    }

    const srcName = state.stockFile.name.replace(/\.xlsx?$/i, "");
    const outName = `${srcName} - ${todayISO()}.xlsx`;
    XLSX.writeFile(wb, outName);

    $("#fpConfirmBar").hidden = true;
    $("#fpDone").innerHTML = `
      <div class="fp-done">
        <h3>Allocation confirmed — ${deducted} stock row${deducted === 1 ? "" : "s"} updated</h3>
        <p class="small">Downloaded as <code>${esc(outName)}</code>. When you open it in Excel,
        Available Stock, Consumption, and Inventory Value recalculate automatically.
        This PDF's fingerprint has been recorded so it can't be silently re-processed.</p>
        ${inserted ? `<p class="small muted"><b>Note:</b> the file's existing job columns (N–AN) were full, so a new column was inserted. Formulas that reference specific column ranges (e.g. <code>SUM(N3:AN3)</code>) may need widening manually.</p>` : ""}
        <div class="fp-done-actions">
          <button class="ghost" id="fpNew">Start another allocation</button>
        </div>
      </div>`;
    $("#fpNew").addEventListener("click", resetAll);
  }

  /* --------------------------- Analyse pipeline -------------- */

  async function analyse() {
    if (!state.pdfFile || !state.stockFile) return;
    const btn = $("#fpExtract");
    btn.disabled = true;
    status("Reading files and matching items — this can take a few seconds…");
    try {
      const [pdfText, stockWb, hash] = await Promise.all([
        extractPdfText(state.pdfFile),
        loadStockFile(state.stockFile),
        pdfFingerprint(state.pdfFile),
      ]);
      state.parsedJob = parseJobHeader(pdfText);
      state.stockWb = stockWb;
      state.stockMeta = inspectStock(stockWb);
      state.pdfHash = hash;

      // Pre-fill Job number if the user hasn't typed one.
      const jbox = $("#fpJobNumber");
      if (!jbox.value.trim() && state.parsedJob.ref) jbox.value = state.parsedJob.ref;

      const entries = parsePdf(pdfText);
      state.rows = buildRows(entries, state.stockMeta);
      render();

      const t = tallyTotals();
      status(`Analysis ready — ${t.totalItems + t.unresolved} items in the PDF, ${t.unresolved} need decisions.`);
    } catch (err) {
      console.error(err);
      status("Could not analyse the files: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  /* --------------------------- Reset / status ---------------- */

  function resetAll() {
    state.pdfFile = state.stockFile = null;
    state.pdfHash = state.parsedJob = state.rows = state.stockWb = state.stockMeta = null;
    $("#fpPdf").value = ""; $("#fpStock").value = "";
    $("#fpPdfName").textContent = "Click or drop the PDF file here";
    $("#fpStockName").textContent = "Click or drop the stock file here";
    $("#fpDrop").classList.remove("ready");
    $("#fpDropStock").classList.remove("ready");
    $("#fpJobNumber").value = ""; $("#fpClient").value = "";
    $("#fpOut").innerHTML = "";
    $("#fpDone").innerHTML = "";
    $("#fpConfirmBar").hidden = true;
    $("#fpExtract").disabled = true;
    status("");
  }

  function status(text, kind) {
    const el = $("#fpStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  /* --------------------------- Wire-up ----------------------- */

  function wireDrop(dropEl, inputEl, kind) {
    dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
    dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
    dropEl.addEventListener("drop", (e) => {
      e.preventDefault();
      dropEl.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        inputEl.files = e.dataTransfer.files;
        inputEl.dispatchEvent(new Event("change"));
      }
    });
    inputEl.addEventListener("change", () => {
      const f = inputEl.files && inputEl.files[0];
      if (!f) return;
      if (kind === "pdf") { state.pdfFile = f; $("#fpPdfName").textContent = f.name; }
      else if (kind === "stock") { state.stockFile = f; $("#fpStockName").textContent = f.name; }
      dropEl.classList.add("ready");
      $("#fpExtract").disabled = !(state.pdfFile && state.stockFile);
    });
  }

  function init() {
    if (!$("#fpExtract")) { setTimeout(init, 50); return; }
    wireDrop($("#fpDrop"), $("#fpPdf"), "pdf");
    wireDrop($("#fpDropStock"), $("#fpStock"), "stock");
    $("#fpExtract").addEventListener("click", analyse);
    $("#fpReset").addEventListener("click", resetAll);
    $("#fpConfirm").addEventListener("click", async () => {
      const btn = $("#fpConfirm");
      btn.disabled = true;
      try { await confirmAllocation(); }
      catch (err) { console.error(err); status("Could not confirm: " + err.message, "err"); btn.disabled = false; }
    });
    ["fpJobNumber", "fpClient"].forEach((id) => {
      $("#" + id).addEventListener("input", () => { if (state.rows) render(); });
    });
  }

  init();
})();
