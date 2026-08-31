/* Flyscreen inventory allocation.
 *
 * Reads an FP Pro optimisation PDF, the Freedom item list, and the Flyscreen
 * stock file — all in the browser, nothing uploaded — and produces an
 * updated stock file with the deduction applied to the correct job column,
 * plus an appended row per line item on the CHECK OUT sheet.
 *
 * The flow is deliberately staged so nothing is deducted by accident:
 *   1. Upload the three files and enter Job number + Client name
 *   2. Click "Analyse and preview" — the tool extracts, aggregates,
 *      matches, checks stock, and shows every line item with a status.
 *   3. Any UNMATCHED, SHORTAGE or FUZZY row must be resolved (skip or
 *      accept) before the sticky "Confirm allocation" button unlocks.
 *   4. On confirm, an updated stock file is generated and downloaded.
 *
 * Design notes:
 *   - The stock file's own formulas (AO consumption, AU available stock,
 *     AV moving-avg cost, AW inventory value, AY reorder flag) are left
 *     untouched. We only write into the first empty job column (N..AN).
 *     Excel recalculates the rest on open.
 *   - PDF SHA-256 fingerprint + job number is stored in localStorage to
 *     prevent double-processing of the same file.
 *   - Fuzzy matching runs only as a fallback for codes that failed exact
 *     numeric-prefix matching. Fuzzy matches never auto-deduct — they
 *     appear as FUZZY status and must be explicitly accepted. */

(function () {
  const $ = (s) => document.querySelector(s);

  // pdf.js and SheetJS are ~1 MB combined. Only load them when needed.
  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const HISTORY_KEY = "oryx_flyscreen_history_v1";

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

  /* --------------------------- State --------------------------- */
  const state = {
    pdfFile: null,
    xlsxFile: null,
    stockFile: null,
    pdfHash: null,
    parsedJob: null,       // { ref, user, description, printedAt }
    itemsByCode: null,     // Map<code, item>
    itemList: null,        // array of items (for fuzzy search)
    rows: null,            // array of allocation rows (see below)
    stockWb: null,         // parsed stock workbook (kept until confirm)
    stockMeta: null,       // { partCodeCol, jobColRange, targetCol, insertedCol }
  };

  // A row is:
  //   {
  //     code,            // canonical numeric code (either exact match or from PDF)
  //     description,     // description (from item list if matched, else from PDF)
  //     category,
  //     pdfText,         // supplementary detail from the PDF ("3 × 2500 mm = 7.5 m")
  //     unit,            // "pcs" | "m" | "bars"
  //     requiredQty,     // aggregated from PDF
  //     costPerUnit,     // from item list
  //     estValue,        // requiredQty × costPerUnit
  //     available,       // from stock file (Available Stock column)
  //     remaining,       // available − requiredQty  (updated with action)
  //     status,          // 'ok' | 'shortage' | 'unmatched' | 'fuzzy' | 'skipped'
  //     baseStatus,      // the status before any user action (for revert)
  //     action,          // 'deduct' | 'skip' | 'accept' (for fuzzy)
  //     stockRowIndex,   // 0-based row index in the STOCK sheet where deduction applies
  //     hasDuplicate,    // true if code appears in multiple stock rows
  //     fuzzyCandidate,  // { code, description, similarity } — only set if status was fuzzy
  //   }

  /* --------------------------- Duplicate-upload tracking ------ */

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

  /* --------------------------- PDF parsing --------------------- */

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
      out.push({ code, qty, unit, description, pdfText: "" });
    }
    return out;
  }

  function parseBars(text) {
    const out = [];
    const re = /Bars:\s*(\d+)\s*x\s*(\d+)[\s\S]*?Description:\s*([^\n]+?)\s*Total length:\s*([\d.]+)\s*m/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const bars = parseInt(m[1], 10);
      const barLen = parseInt(m[2], 10);
      const desc = m[3].trim();
      const totalLenM = parseFloat(m[4]);
      const codeM = desc.match(/(\d+)\s*[-–]/);
      const code = codeM ? codeM[1] : "";
      out.push({
        code, description: desc,
        qty: bars, unit: "bars",
        pdfText: `${bars} × ${barLen} mm = ${totalLenM} m`,
      });
    }
    return out;
  }

  // Aggregate: same code + same unit is summed. Different units (pcs vs bars)
  // for the same code stay separate — they represent different stock rows.
  function aggregate(entries) {
    const byKey = new Map();
    for (const e of entries) {
      if (!e.code) continue;
      const key = `${e.code}|${e.unit}`;
      const cur = byKey.get(key);
      if (cur) {
        cur.qty += e.qty;
        // Combine pdf-text so both source lines are traceable.
        if (e.pdfText && cur.pdfText && !cur.pdfText.includes(e.pdfText)) {
          cur.pdfText += " + " + e.pdfText;
        } else if (e.pdfText && !cur.pdfText) {
          cur.pdfText = e.pdfText;
        }
      } else {
        byKey.set(key, { ...e });
      }
    }
    return [...byKey.values()];
  }

  function parsePdf(text) {
    const sections = splitSections(text);
    const all = [];
    for (const s of sections) {
      const entries = s.kind === "fittings" ? parseFittings(s.text) : parseBars(s.text);
      for (const e of entries) all.push(e);
    }
    return aggregate(all);
  }

  /* --------------------------- Item list ---------------------- */

  async function loadItemList(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    let headerIdx = rows.findIndex((r) => /CODE/i.test(String(r[0] || "")));
    if (headerIdx === -1) headerIdx = 0;
    const header = rows[headerIdx].map((h) => String(h || "").trim().toUpperCase());
    const idx = (n) => header.indexOf(n);
    const iCode = idx("CODE");
    const iDesc = idx("DESCRIPTION");
    const iLen  = header.findIndex((h) => /LENGTH/i.test(h));
    const iCat  = idx("CATEGORY");
    const iInv  = idx("INVENTORY");
    const iCost = idx("COST");
    const items = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const code = row[iCode];
      if (code == null) continue;
      items.push({
        code: String(code).trim(),
        description: iDesc >= 0 ? String(row[iDesc] || "").trim() : "",
        length: iLen >= 0 ? row[iLen] : null,
        category: iCat >= 0 ? String(row[iCat] || "").trim() : "",
        inventory: Number(iInv >= 0 ? row[iInv] : 0) || 0,
        cost: Number(iCost >= 0 ? row[iCost] : 0) || 0,
      });
    }
    return items;
  }

  /* --------------------------- Stock file --------------------- */

  async function loadStockFile(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    // cellStyles keeps colouring where SheetJS can; formulas roundtrip natively.
    const wb = window.XLSX.read(buf, { type: "array", cellStyles: true, cellFormula: true });
    if (!wb.Sheets["STOCK"]) throw new Error('The uploaded file has no "STOCK" sheet — is it the right file?');
    return wb;
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
    let partCodeCol = null, availStockCol = null, productCol = null,
        openCostCol = null, oldNewCol = null;
    for (const [c, h] of Object.entries(headers)) {
      const hh = h.toUpperCase();
      if (partCodeCol === null && /CHILD PROFILE PART CODE|PART CODE/.test(hh)) partCodeCol = +c;
      if (availStockCol === null && hh === "AVAILABLE STOCK") availStockCol = +c;
      if (productCol === null && hh === "PRODUCT") productCol = +c;
      if (openCostCol === null && /OPENING COST PER PROFILE/.test(hh)) openCostCol = +c;
      if (oldNewCol === null && /OLD\/NEW/.test(hh)) oldNewCol = +c;
    }
    if (partCodeCol === null) throw new Error('Could not find the "Child Profile Part code" column in the STOCK sheet.');

    // Build lookup: numeric code -> [row indexes]. The first is the primary
    // match; the rest are variants surfaced as duplicates.
    const codeToRows = new Map();
    for (let r = HEADER_ROW + 1; r <= range.e.r; r++) {
      const partCell = ws[XLSX.utils.encode_cell({ r, c: partCodeCol })];
      const partName = partCell && partCell.v != null ? String(partCell.v) : "";
      const code = codeFromPartName(partName);
      if (!code) continue;
      const arr = codeToRows.get(code) || [];
      arr.push(r);
      codeToRows.set(code, arr);
    }
    // Find target job column: first slot in N..AN with no header text.
    let targetCol = null;
    for (let c = 13; c <= 39; c++) {
      if (!headers[c] || headers[c] === "") { targetCol = c; break; }
    }
    const willInsert = targetCol === null;
    return {
      range, HEADER_ROW, headers,
      partCodeCol, availStockCol, productCol, openCostCol, oldNewCol,
      codeToRows, targetCol, willInsert,
    };
  }

  function codeFromPartName(partName) {
    if (!partName) return "";
    const m = String(partName).match(/^\s*(\d+[A-Z]?)/);
    return m ? m[1] : "";
  }

  function getCachedAvailable(ws, meta, rowIdx) {
    if (meta.availStockCol == null) return null;
    const XLSX = window.XLSX;
    const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: meta.availStockCol })];
    if (!cell) return 0;
    // If it's a formula, its cached .v is the value from the last time Excel
    // recomputed. That's what we treat as "current available."
    return typeof cell.v === "number" ? cell.v : Number(cell.v) || 0;
  }

  /* --------------------------- Matching ----------------------- */

  // Very small tokeniser + Jaccard word overlap for fuzzy fallback. Fast
  // enough for 200 items × ~ dozen candidates.
  function tokens(s) {
    return new Set(String(s || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean));
  }
  function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter); // Jaccard
  }
  function bestFuzzyMatch(description, itemList) {
    let best = null;
    for (const it of itemList) {
      const s = similarity(description, it.description);
      if (!best || s > best.similarity) best = { item: it, similarity: s };
    }
    return best;
  }

  function buildRows(entries, itemList, itemsByCode, stockWs, stockMeta) {
    const rows = [];
    for (const e of entries) {
      const item = itemsByCode.get(e.code);
      let row;
      if (item) {
        // Exact code match to item list. Now find stock row for available qty.
        const stockRows = stockMeta.codeToRows.get(e.code) || [];
        const stockRowIdx = stockRows[0] ?? null;
        const available = stockRowIdx != null ? getCachedAvailable(stockWs, stockMeta, stockRowIdx) : null;
        const remaining = available != null ? available - e.qty : null;
        const status = stockRowIdx == null
          ? "unmatched"                     // in item list but not in stock file
          : (remaining < 0 ? "shortage" : "ok");
        row = {
          code: e.code, description: item.description || e.description,
          category: item.category, pdfText: e.pdfText, unit: e.unit,
          requiredQty: e.qty, costPerUnit: item.cost,
          estValue: e.qty * item.cost,
          available, remaining, status, baseStatus: status,
          // OK rows are auto-decided. Shortage/Unmatched/Fuzzy start undecided.
          action: status === "ok" ? "deduct" : "pending",
          decided: status === "ok",
          stockRowIndex: stockRowIdx,
          hasDuplicate: stockRows.length > 1,
          fuzzyCandidate: null,
        };
      } else {
        // No exact match — try fuzzy. Never auto-accept; surface for review.
        const cand = bestFuzzyMatch(e.description, itemList);
        const fuzzyOk = cand && cand.similarity >= 0.35;
        row = {
          code: e.code, description: e.description || `(code ${e.code})`,
          category: "", pdfText: e.pdfText, unit: e.unit,
          requiredQty: e.qty, costPerUnit: fuzzyOk ? cand.item.cost : 0,
          estValue: fuzzyOk ? e.qty * cand.item.cost : 0,
          available: null, remaining: null,
          status: fuzzyOk ? "fuzzy" : "unmatched",
          baseStatus: fuzzyOk ? "fuzzy" : "unmatched",
          action: "pending",
          decided: false,
          stockRowIndex: null,
          hasDuplicate: false,
          fuzzyCandidate: fuzzyOk ? { code: cand.item.code, description: cand.item.description, similarity: cand.similarity } : null,
        };
      }
      rows.push(row);
    }
    return rows;
  }

  /* --------------------------- Rendering ---------------------- */

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Math.round(n * 100) / 100;
  }
  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return "€ " + fmt(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function statusChip(status) {
    if (status === "ok") return `<span class="inv-status-ok">OK</span>`;
    if (status === "shortage") return `<span class="inv-status-short">Shortage</span>`;
    if (status === "unmatched") return `<span class="inv-status-unmatched">Unmatched</span>`;
    if (status === "fuzzy") return `<span class="inv-status-fuzzy">Fuzzy match — review</span>`;
    if (status === "skipped") return `<span class="inv-status-skip">Skipped</span>`;
    return `<span class="inv-status-skip">${esc(status)}</span>`;
  }

  function unresolvedCount() {
    return state.rows.filter((r) => !r.decided).length;
  }
  function unresolvedByStatus() {
    return {
      shortage: state.rows.filter((r) => !r.decided && r.baseStatus === "shortage").length,
      fuzzy: state.rows.filter((r) => !r.decided && r.baseStatus === "fuzzy").length,
      unmatched: state.rows.filter((r) => !r.decided && r.baseStatus === "unmatched").length,
    };
  }
  function shortageAllowedCount() {
    return state.rows.filter((r) => r.decided && r.baseStatus === "shortage" && r.action === "deduct").length;
  }
  function tallyTotals() {
    const active = state.rows.filter((r) => r.action === "deduct");
    return {
      totalItems: active.length,
      totalValue: active.reduce((s, r) => s + (r.estValue || 0), 0),
      shortages: shortageAllowedCount(),
      skipped: state.rows.filter((r) => r.decided && r.action === "skip").length,
      unresolved: unresolvedCount(),
    };
  }

  function renderRowActionButtons(idx, row) {
    const btns = [];
    const on = (yes) => yes ? "on" : "";
    if (row.baseStatus === "ok") {
      btns.push(`<button data-act="skip" data-i="${idx}" class="${on(row.action === "skip")}">Skip</button>`);
      if (row.action === "skip") btns.push(`<button data-act="deduct" data-i="${idx}">Undo</button>`);
    } else if (row.baseStatus === "shortage") {
      btns.push(`<button data-act="deduct" data-i="${idx}" class="${on(row.decided && row.action === "deduct")}">Allow negative</button>`);
      btns.push(`<button data-act="skip" data-i="${idx}" class="${on(row.decided && row.action === "skip")}">Skip</button>`);
    } else if (row.baseStatus === "fuzzy") {
      btns.push(`<button data-act="accept" data-i="${idx}" class="${on(row.decided && row.action === "deduct")}">Accept fuzzy match</button>`);
      btns.push(`<button data-act="skip" data-i="${idx}" class="${on(row.decided && row.action === "skip")}">Skip</button>`);
    } else if (row.baseStatus === "unmatched") {
      btns.push(`<button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Skip (acknowledge)</button>`);
    }
    return `<div class="inv-row-actions">${btns.join("")}</div>`;
  }

  function render() {
    const job = state.parsedJob;
    const t = tallyTotals();

    const historyHit = state.pdfHash && (readHistory()[state.pdfHash]);
    const historyWarn = historyHit
      ? `<div class="inv-warn">
          <h4>This PDF has already been processed</h4>
          <p class="small">Fingerprint match: same file was allocated on <b>${esc(historyHit.processedAt)}</b>
          for job <code>${esc(historyHit.jobRef)}</code> (${esc(historyHit.client)}). Deducting again would
          double-count the job. Reset or upload a different PDF unless you're sure this is intentional.</p>
        </div>`
      : "";

    const rowsHtml = state.rows.map((r, i) => {
      const rowClass = r.decided && r.action === "skip" ? "inv-skipped" : "";
      const fuzzyDetail = r.fuzzyCandidate
        ? `<div class="small muted">Best guess: <code>${esc(r.fuzzyCandidate.code)}</code>
            — ${esc(r.fuzzyCandidate.description)} (similarity ${Math.round(r.fuzzyCandidate.similarity * 100)}%)</div>`
        : "";
      const dupDetail = r.hasDuplicate
        ? `<div class="small muted">Multiple stock rows share this code — first match used; review manually if wrong variant.</div>`
        : "";
      const remainingClass = r.remaining != null && r.remaining < 0 ? 'style="color:var(--danger); font-weight:600"' : "";
      const displayStatus = r.decided && r.action === "skip" ? "skipped" : r.status;
      return `<tr class="${rowClass}">
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.description)}
          ${r.pdfText ? `<div class="small muted">${esc(r.pdfText)}</div>` : ""}
          ${fuzzyDetail}${dupDetail}</td>
        <td><span class="inv-cat">${esc(r.category || "—")}</span></td>
        <td class="num">${fmt(r.requiredQty)} ${esc(r.unit)}</td>
        <td class="num">${r.available != null ? fmt(r.available) : "—"}</td>
        <td class="num" ${remainingClass}>${r.remaining != null ? fmt(r.remaining) : "—"}</td>
        <td class="num">${money(r.estValue)}</td>
        <td>${statusChip(displayStatus)}</td>
        <td>${renderRowActionButtons(i, r)}</td>
      </tr>`;
    }).join("");

    $("#invOut").innerHTML = `
      ${historyWarn}
      <div class="inv-jobcard">
        <div class="inv-jobfield"><label>Job ref</label><strong>${esc(job.ref || "—")}</strong></div>
        <div class="inv-jobfield"><label>PDF user</label><strong>${esc(job.user || "—")}</strong></div>
        <div class="inv-jobfield"><label>Description</label><strong>${esc(job.description || "—")}</strong></div>
        <div class="inv-jobfield"><label>Printed</label><strong>${esc(job.printedAt || "—")}</strong></div>
      </div>

      <div class="inv-tally">
        <div class="inv-tally-item"><strong>${t.totalItems}</strong><span>Line items to deduct</span></div>
        <div class="inv-tally-item"><strong>${money(t.totalValue)}</strong><span>Est. deduction value</span></div>
        <div class="inv-tally-item"><strong>${t.shortages}</strong><span>Shortages (allowed)</span></div>
        <div class="inv-tally-item"><strong>${t.skipped}</strong><span>Skipped</span></div>
        <div class="inv-tally-item"><strong>${t.unresolved}</strong><span>Unresolved</span></div>
      </div>

      ${(() => {
        const u = unresolvedByStatus();
        if (!t.unresolved) return "";
        const parts = [];
        if (u.shortage) parts.push(`<li><b>${u.shortage} shortage${u.shortage === 1 ? "" : "s"}</b> — required qty exceeds available. Choose "Allow negative" (proceed) or "Skip" per row.
          <span class="inv-batch-actions">
            <button data-act="allow-all-shortage" data-i="-1">Allow all shortages</button>
            <button data-act="skip-all-shortage" data-i="-1">Skip all shortages</button>
          </span></li>`);
        if (u.fuzzy) parts.push(`<li><b>${u.fuzzy} fuzzy match${u.fuzzy === 1 ? "" : "es"}</b> — description-based guess needs your yes/no.
          <span class="inv-batch-actions">
            <button data-act="skip-all-fuzzy" data-i="-1">Skip all fuzzy</button>
          </span></li>`);
        if (u.unmatched) parts.push(`<li><b>${u.unmatched} unmatched item${u.unmatched === 1 ? "" : "s"}</b> — no code match at all. Not deducted, but click Acknowledge so we know you've seen them.
          <span class="inv-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>`);
        return `<div class="inv-warn">
          <h4>${t.unresolved} row${t.unresolved === 1 ? "" : "s"} need${t.unresolved === 1 ? "s" : ""} a decision before you can confirm</h4>
          <ul>${parts.join("")}</ul>
        </div>`;
      })()}

      <div class="inv-section-h">Allocation preview</div>
      <div class="inv-scroll">
        <table class="inv-table">
          <thead><tr>
            <th>Code</th><th>Description</th><th>Category</th>
            <th class="num">Required</th>
            <th class="num">Available</th>
            <th class="num">Remaining</th>
            <th class="num">Est. value</th>
            <th>Status</th>
            <th>Action</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:var(--space-3)">Preview only — no stock is changed yet.
      When every row shows OK, Shortage (allowed) or Skipped, the confirm button unlocks.</p>
    `;

    // Confirm bar summary + enable
    const canConfirm =
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !!$("#invJobNumber").value.trim() &&
      !!$("#invClient").value.trim() &&
      !historyHit;
    $("#invConfirmSummary").textContent =
      `${t.totalItems} items · ${money(t.totalValue)}` +
      (t.shortages ? ` · ${t.shortages} shortage${t.shortages === 1 ? "" : "s"} allowed` : "") +
      (t.skipped ? ` · ${t.skipped} skipped` : "");
    $("#invConfirmBar").hidden = false;
    $("#invConfirm").disabled = !canConfirm;

    // Wire per-row AND batch action buttons.
    document.querySelectorAll("#invOut .inv-row-actions button, #invOut .inv-batch-actions button").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = +b.dataset.i;
        const act = b.dataset.act;
        applyRowAction(idx, act);
      });
    });
  }

  function applyRowAction(idx, act) {
    // Batch actions use idx = -1 and don't refer to a specific row.
    if (act === "skip-all-shortage" || act === "allow-all-shortage"
        || act === "skip-all-unmatched" || act === "skip-all-fuzzy") {
      if (act === "skip-all-shortage") state.rows.forEach((rr) => { if (!rr.decided && rr.baseStatus === "shortage") { rr.action = "skip"; rr.decided = true; } });
      if (act === "allow-all-shortage") state.rows.forEach((rr) => { if (!rr.decided && rr.baseStatus === "shortage") { rr.action = "deduct"; rr.decided = true; } });
      if (act === "skip-all-unmatched") state.rows.forEach((rr) => { if (!rr.decided && rr.baseStatus === "unmatched") { rr.action = "skip"; rr.decided = true; } });
      if (act === "skip-all-fuzzy") state.rows.forEach((rr) => { if (!rr.decided && rr.baseStatus === "fuzzy") { rr.action = "skip"; rr.decided = true; } });
      render();
      return;
    }
    const r = state.rows[idx];
    if (!r) return;
    if (act === "skip") {
      r.action = "skip";
      r.decided = true;
    } else if (act === "deduct") {
      r.action = "deduct";
      r.decided = true;
    } else if (act === "accept") {
      const cand = r.fuzzyCandidate;
      if (!cand) return;
      r.code = cand.code;
      r.description = cand.description;
      const item = state.itemsByCode.get(cand.code);
      if (item) {
        r.category = item.category;
        r.costPerUnit = item.cost;
        r.estValue = r.requiredQty * item.cost;
      }
      const stockRows = state.stockMeta.codeToRows.get(cand.code) || [];
      r.stockRowIndex = stockRows[0] ?? null;
      r.hasDuplicate = stockRows.length > 1;
      if (r.stockRowIndex != null) {
        r.available = getCachedAvailable(state.stockWb.Sheets["STOCK"], state.stockMeta, r.stockRowIndex);
        r.remaining = r.available - r.requiredQty;
        if (r.remaining < 0) {
          r.baseStatus = "shortage";
          r.status = "shortage";
          r.action = "pending"; r.decided = false; // now needs a shortage decision
        } else {
          r.baseStatus = "ok"; r.status = "ok";
          r.action = "deduct"; r.decided = true;
        }
      } else {
        r.baseStatus = "unmatched"; r.status = "unmatched";
        r.action = "skip"; r.decided = true;  // fuzzy that resolved to no-stock — auto-skip
      }
    }
    render();
  }

  /* --------------------------- Confirm & apply ---------------- */

  async function confirmAllocation() {
    const XLSX = window.XLSX;
    const jobRef = $("#invJobNumber").value.trim();
    const client = $("#invClient").value.trim();
    const newColHeader = `${jobRef}-${client}`;
    const wb = state.stockWb;
    const ws = wb.Sheets["STOCK"];
    const meta = state.stockMeta;

    // Pick or insert the target column
    let targetCol = meta.targetCol;
    let inserted = false;
    if (targetCol == null) {
      // Insert immediately after AN (i.e. shift the SUM range).
      targetCol = 40; // AO
      // Find the current Consumption column position dynamically
      for (const [c, h] of Object.entries(meta.headers)) {
        if (String(h).toUpperCase() === "CONSUMPTION") { targetCol = +c; break; }
      }
      shiftColumnsRight(ws, targetCol, meta.range);
      inserted = true;
    }

    // Header for the new column
    ws[XLSX.utils.encode_cell({ r: meta.HEADER_ROW, c: targetCol })] = { t: "s", v: newColHeader };

    // Write quantities into the new job column for each active row.
    // The stock file's own formulas at AO, AU, AV, AW recompute on open —
    // we do NOT overwrite them. To prompt Excel to recalculate, we simply
    // let the workbook keep its formulas; SheetJS preserves them.
    let deducted = 0;
    for (const r of state.rows) {
      if (r.action !== "deduct" || r.stockRowIndex == null) continue;
      ws[XLSX.utils.encode_cell({ r: r.stockRowIndex, c: targetCol })] = { t: "n", v: r.requiredQty };
      deducted++;
    }

    // Widen the sheet ref if we've extended past the previous last column.
    const newRange = { s: meta.range.s, e: { r: meta.range.e.r, c: Math.max(meta.range.e.c, targetCol) } };
    ws["!ref"] = XLSX.utils.encode_range(newRange);

    // Append allocation history rows to CHECK OUT. The sheet's declared
    // range often extends far past its actual data (thousands of empty
    // rows reserved for future entries) — we find the true last populated
    // row starting from just after the header, then append from there.
    if (wb.Sheets["CHECK OUT"]) {
      const co = wb.Sheets["CHECK OUT"];
      const coRange = XLSX.utils.decode_range(co["!ref"]);
      let nextRow = 1; // right after the header row (row index 0)
      for (let r = 1; r <= coRange.e.r; r++) {
        const cell = co[XLSX.utils.encode_cell({ r, c: 0 })];
        if (cell && cell.v != null) nextRow = r + 1;
        else if (r > nextRow + 50) break; // stop scanning huge trailing empty gap
      }
      const today = todayISO();
      for (const r of state.rows) {
        if (r.action !== "deduct") continue;
        // Read Product name from STOCK column A of the matched row.
        const product = r.stockRowIndex != null
          ? (ws[XLSX.utils.encode_cell({ r: r.stockRowIndex, c: 0 })] || {}).v || ""
          : "";
        const total = r.requiredQty * (r.costPerUnit || 0);
        const cells = [today, product, r.code + " " + r.description, r.requiredQty, r.costPerUnit || 0, total, newColHeader];
        cells.forEach((v, ci) => {
          const addr = XLSX.utils.encode_cell({ r: nextRow, c: ci });
          co[addr] = { t: typeof v === "number" ? "n" : "s", v };
        });
        nextRow++;
      }
      const finalRange = { s: { r: 0, c: 0 }, e: { r: Math.max(nextRow - 1, coRange.e.r), c: Math.max(6, coRange.e.c) } };
      co["!ref"] = XLSX.utils.encode_range(finalRange);
    }

    // Save the fingerprint to history so this PDF can't be silently re-run.
    if (state.pdfHash) {
      const hist = readHistory();
      hist[state.pdfHash] = { jobRef, client, processedAt: todayISO() };
      writeHistory(hist);
    }

    // Write file.
    const srcName = state.stockFile.name.replace(/\.xlsx?$/i, "");
    const iso = todayISO();
    const outName = `${srcName} - ${iso}.xlsx`;
    XLSX.writeFile(wb, outName);

    // Show the done panel and hide the confirm bar.
    $("#invConfirmBar").hidden = true;
    const t = tallyTotals();
    $("#invDone").innerHTML = `
      <div class="inv-done">
        <h3>Allocation confirmed — ${deducted} stock row${deducted === 1 ? "" : "s"} updated</h3>
        <p class="small">The updated stock file has been downloaded as <code>${esc(outName)}</code>.
        The Available Stock, Consumption and Inventory Value columns will recalculate when you open it in Excel.
        A history row has been appended to the CHECK OUT sheet for every deducted item, and this PDF's fingerprint
        has been recorded so the same file can't be silently re-deducted.</p>
        ${inserted ? `<p class="small muted"><b>Note:</b> the file's existing job columns (N–AN) were full, so a new column was inserted. Formulas that reference specific column ranges (e.g. <code>SUM(N3:AN3)</code>) may need widening manually.</p>` : ""}
        <div class="inv-done-actions">
          <button class="ghost" id="invNew">Start another allocation</button>
        </div>
      </div>`;
    $("#invNew").addEventListener("click", resetAll);
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

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* --------------------------- Analyse pipeline --------------- */

  async function analyse() {
    if (!state.pdfFile || !state.xlsxFile || !state.stockFile) return;
    const btn = $("#invAnalyse");
    btn.disabled = true;
    status("Reading files and matching items — this can take a few seconds…");
    try {
      const [pdfText, items, stockWb, hash] = await Promise.all([
        extractPdfText(state.pdfFile),
        loadItemList(state.xlsxFile),
        loadStockFile(state.stockFile),
        pdfFingerprint(state.pdfFile),
      ]);
      state.parsedJob = parseJobHeader(pdfText);
      state.itemList = items;
      state.itemsByCode = new Map(items.map((it) => [it.code, it]));
      state.stockWb = stockWb;
      state.stockMeta = inspectStock(stockWb);
      state.pdfHash = hash;

      // If the user hasn't already typed a job number, pre-fill from the PDF.
      const jbox = $("#invJobNumber");
      if (!jbox.value.trim() && state.parsedJob.ref) jbox.value = state.parsedJob.ref;

      const entries = parsePdf(pdfText);
      state.rows = buildRows(entries, items, state.itemsByCode, stockWb.Sheets["STOCK"], state.stockMeta);
      render();

      const t = tallyTotals();
      status(`Analysis ready — ${t.totalItems} items to deduct, ${t.unresolved} need decisions, ${t.shortages} shortage${t.shortages === 1 ? "" : "s"}.`);
    } catch (err) {
      console.error(err);
      status("Could not analyse the files: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function resetAll() {
    state.pdfFile = state.xlsxFile = state.stockFile = null;
    state.pdfHash = state.parsedJob = state.itemsByCode = state.itemList = null;
    state.rows = state.stockWb = state.stockMeta = null;
    for (const id of ["invPdfName", "invXlsxName", "invStockName"]) {
      const map = { invPdfName: "Click or drop the PDF file here",
                    invXlsxName: "Click or drop the item-list file here",
                    invStockName: "Click or drop the stock file here" };
      $("#" + id).textContent = map[id];
    }
    ["invDropPdf", "invDropXlsx", "invDropStock"].forEach((id) => $("#" + id).classList.remove("ready"));
    for (const id of ["invPdf", "invXlsx", "invStock"]) $("#" + id).value = "";
    $("#invJobNumber").value = "";
    $("#invClient").value = "";
    $("#invOut").innerHTML = "";
    $("#invDone").innerHTML = "";
    $("#invConfirmBar").hidden = true;
    $("#invAnalyse").disabled = true;
    status("");
  }

  function status(text, kind) {
    const el = $("#invStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  /* --------------------------- Wire-up ------------------------ */

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
      if (kind === "pdf") { state.pdfFile = f; $("#invPdfName").textContent = f.name; }
      else if (kind === "xlsx") { state.xlsxFile = f; $("#invXlsxName").textContent = f.name; }
      else if (kind === "stock") { state.stockFile = f; $("#invStockName").textContent = f.name; }
      dropEl.classList.add("ready");
      $("#invAnalyse").disabled = !(state.pdfFile && state.xlsxFile && state.stockFile);
    });
  }

  function init() {
    if (!$("#invAnalyse")) { setTimeout(init, 50); return; }
    wireDrop($("#invDropPdf"), $("#invPdf"), "pdf");
    wireDrop($("#invDropXlsx"), $("#invXlsx"), "xlsx");
    wireDrop($("#invDropStock"), $("#invStock"), "stock");
    $("#invAnalyse").addEventListener("click", analyse);
    $("#invReset").addEventListener("click", resetAll);
    $("#invConfirm").addEventListener("click", async () => {
      const btn = $("#invConfirm");
      btn.disabled = true;
      try {
        await confirmAllocation();
      } catch (err) {
        console.error(err);
        status("Could not confirm: " + err.message, "err");
        btn.disabled = false;
      }
    });
    // Re-render when the user edits job number / client, so the confirm state updates.
    ["invJobNumber", "invClient"].forEach((id) => {
      $("#" + id).addEventListener("input", () => { if (state.rows) render(); });
    });
  }

  init();
})();
