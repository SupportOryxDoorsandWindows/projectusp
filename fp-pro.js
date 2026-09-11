/* FP Pro Optimization tab + Master Inventory view.
 *
 * Reads an FP Pro optimisation PDF, matches every item against the Master
 * Inventory (Supabase `inventory_items`, read via the same public/read-only
 * key as the rest of the app), and checks nothing goes negative. Only after
 * the user clicks Confirm does anything get written — and that write goes
 * through the `checkout` Edge Function (service-role key, server-side
 * re-validation), never straight from the browser. The public key here
 * stays exactly as read-only as it is for the rest of the site.
 *
 * There is no stock Excel file anymore. The Master Inventory is the single
 * source of truth; Check-out is a recorded transaction against it. */

(function () {
  const $ = (s) => document.querySelector(s);

  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  // xlsx-js-style, not plain SheetJS: verified (by writing a file and
  // inspecting its raw xl/styles.xml) that plain "xlsx" community builds
  // silently drop cell fill/font styling on write -- this fork is API
  // compatible but actually writes it, which the Oryx-blue report header
  // below depends on.
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
  const CHECKOUT_FN_URL = window.ORYX_CONFIG.supabaseUrl + "/functions/v1/checkout";

  const sb = window.supabase.createClient(window.ORYX_CONFIG.supabaseUrl, window.ORYX_CONFIG.supabaseKey);

  let libsPromise = null;
  function loadLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = import(/* @vite-ignore */ PDFJS_SRC).then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.__pdfjs = m;
    });
    return libsPromise;
  }

  // Only the Export button needs SheetJS -- loaded on demand so the PDF
  // matching path (the common case) never pays for it.
  let xlsxLibPromise = null;
  function loadXlsxLib() {
    if (xlsxLibPromise) return xlsxLibPromise;
    xlsxLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = XLSX_SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the Excel library from CDN."));
      document.head.appendChild(s);
    });
    return xlsxLibPromise;
  }

  /* --------------------------- State ------------------------- */
  const state = {
    pdfFile: null,
    pdfHash: null,
    parsedJob: null,
    rows: null,
    itemsByCode: null, // Map<item_code, [{id, description, bar_length_mm, unit_cost, current_qty, buffer_level}]>
  };

  /* --------------------------- Duplicate-PDF fingerprint ----- */
  // The actual duplicate check happens server-side, inside checkout_transaction()
  // (against inventory_transactions.source_document_hash) -- this is just how
  // we compute the value to send.
  async function pdfFingerprint(file) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  /* --------------------------- Master Inventory lookup -------- */

  async function loadInventoryItems() {
    const { data, error } = await sb.from("inventory_items").select("*");
    if (error) throw new Error("Could not load the Master Inventory: " + error.message);
    const byCode = new Map();
    for (const row of data) {
      const arr = byCode.get(row.item_code) || [];
      arr.push(row);
      byCode.set(row.item_code, arr);
    }
    return byCode;
  }

  // Best-variant picker. For bars: prefer the row whose bar_length_mm matches
  // the PDF's bar length. For fittings: prefer a row with non-zero cost
  // (skips zero-cost placeholder rows that belong to a different product
  // family sharing the same code). Falls back to first row otherwise.
  function pickInventoryRow(entry, candidates) {
    if (!candidates || !candidates.length) return null;
    if (entry.kind === "bar") {
      const target = entry.barLenMm;
      const exact = candidates.find((c) => typeof c.bar_length_mm === "number" && Math.abs(c.bar_length_mm - target) < 50);
      if (exact) return exact;
      const numeric = candidates.filter((c) => typeof c.bar_length_mm === "number");
      if (numeric.length) {
        return numeric.reduce((best, c) =>
          !best || Math.abs(c.bar_length_mm - target) < Math.abs(best.bar_length_mm - target) ? c : best, null);
      }
      const active = candidates.find((c) => c.unit_cost && c.current_qty !== 0) || candidates.find((c) => c.unit_cost);
      return active || candidates[0];
    }
    const active = candidates.find((c) => c.unit_cost || (c.current_qty && c.current_qty !== 0));
    return active || candidates[0];
  }

  function buildRows(entries, itemsByCode) {
    const rows = [];
    for (const e of entries) {
      const candidates = itemsByCode.get(e.code) || [];
      const item = pickInventoryRow(e, candidates);

      const requiredQty = e.kind === "bar" ? e.bars : e.qty;
      const unit = e.kind === "bar" ? "bars" : e.unit;
      const pdfDetail = e.kind === "bar" ? `${e.bars} × ${e.barLenMm} mm` : "";

      if (!item) {
        rows.push({
          kind: e.kind, code: e.code, barLenMm: e.barLenMm,
          description: e.description, pdfDetail,
          requiredQty, unit,
          available: null, remaining: null,
          costPerUnit: 0, estValue: 0,
          status: "unmatched", baseStatus: "unmatched",
          action: "pending", decided: false,
          itemId: null, hasVariants: false, editing: false,
        });
        continue;
      }
      // Shortages are allowed through (Phase 2: negative stock is expected,
      // corrected by a later Check-in) -- both "ok" and "shortage" rows
      // deduct by default. Only "unmatched" needs a decision, since we never
      // guess which Master Inventory item an unrecognised code means.
      const remaining = item.current_qty - requiredQty;
      const status = remaining < 0 ? "shortage" : "ok";
      rows.push({
        kind: e.kind, code: e.code, barLenMm: e.barLenMm,
        description: item.description || e.description, pdfDetail,
        requiredQty, unit,
        available: item.current_qty, remaining,
        costPerUnit: item.unit_cost || 0,
        estValue: requiredQty * (item.unit_cost || 0),
        status, baseStatus: status,
        action: "deduct",
        decided: true,
        itemId: item.id,
        hasVariants: candidates.length > 1, editing: false,
      });
    }
    return rows;
  }

  // Re-derives a row's match/availability/status after the user edits its
  // Code, Description, Quantity or Unit in the Allocation Preview. Mirrors
  // the single-entry logic in buildRows() above.
  function recomputeAfterEdit(row, newCode, newDescription, newQty, newUnit) {
    row.code = newCode;
    row.description = newDescription;
    row.requiredQty = newQty;
    row.unit = newUnit;

    const candidates = state.itemsByCode.get(newCode) || [];
    const item = pickInventoryRow({ kind: row.kind, barLenMm: row.barLenMm }, candidates);

    if (!item) {
      row.available = null; row.remaining = null;
      row.costPerUnit = 0; row.estValue = 0;
      row.status = "unmatched"; row.baseStatus = "unmatched";
      row.action = "pending"; row.decided = false;
      row.itemId = null; row.hasVariants = false;
      return;
    }
    row.description = item.description || newDescription;
    row.available = item.current_qty;
    row.remaining = item.current_qty - newQty;
    row.costPerUnit = item.unit_cost || 0;
    row.estValue = newQty * (item.unit_cost || 0);
    row.status = row.remaining < 0 ? "shortage" : "ok";
    row.baseStatus = row.status;
    row.action = "deduct";
    row.decided = true;
    row.itemId = item.id;
    row.hasVariants = candidates.length > 1;
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

  // Check-in has its own status chip (separate from Check-out's statusChip
  // above) purely so a short-code row can show an amber "Review" state --
  // this is presentation only, it does not change r.status/decided/action,
  // which the rest of the Check-in logic (tallies, confirm gating) still reads.
  function ciStatusChip(row, displayStatus) {
    // A CSS dot instead of a colour emoji -- emoji glyphs render
    // inconsistently across OS/browser font stacks (can show monochrome or
    // force a line-wrap between the glyph and the label); a dot is reliable
    // everywhere and the nowrap pill CSS keeps it glued to its label.
    const dot = `<span class="fp-dot"></span>`;
    if (displayStatus === "skipped") return statusChip("skipped");
    if (displayStatus === "ok") return `<span class="fp-status-ok">${dot}Matched</span>`;
    if (displayStatus === "unmatched" && row.truncatedHint) {
      return `<span class="fp-status-review">${dot}Review</span>`;
    }
    if (displayStatus === "unmatched") return `<span class="fp-status-unmatched">${dot}Unmatched</span>`;
    return statusChip(displayStatus);
  }

  function unresolvedByStatus() {
    // Shortages no longer require a decision -- they deduct by default and
    // go negative. Only unmatched codes (never guessed) need acknowledgement.
    return {
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
    const editBtn = `<button data-act="edit" data-i="${idx}">Edit</button>`;
    if (row.baseStatus === "ok" || row.baseStatus === "shortage") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.action === "skip")}">Skip</button>
        ${row.action === "skip" ? `<button data-act="deduct" data-i="${idx}">Undo</button>` : ""}
        ${editBtn}
      </div>`;
    }
    if (row.baseStatus === "unmatched") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Skip (acknowledge)</button>
        ${editBtn}
      </div>`;
    }
    return `<div class="fp-row-actions">${editBtn}</div>`;
  }

  function applyRowAction(idx, act) {
    if (act === "skip-all-unmatched") {
      state.rows.forEach((rr) => {
        if (rr.decided) return;
        if (rr.baseStatus === "unmatched") { rr.action = "skip"; rr.decided = true; }
      });
      render();
      return;
    }
    const r = state.rows[idx];
    if (!r) return;
    if (act === "skip") { r.action = "skip"; r.decided = true; }
    else if (act === "deduct") { r.action = "deduct"; r.decided = true; }
    else if (act === "edit") { r.editing = true; }
    else if (act === "cancel-edit") { r.editing = false; }
    else if (act === "save-edit") {
      // The code can only ever be a value the dropdown picker committed
      // (fpEditCodeValue) -- never free-typed text -- so a save can never
      // resolve to anything but an existing Master Inventory record.
      const codeValueEl = document.getElementById(`fpEditCodeValue${idx}`);
      const qtyEl = document.getElementById(`fpEditQty${idx}`);
      const unitEl = document.getElementById(`fpEditUnit${idx}`);
      const newCode = codeValueEl ? codeValueEl.value.trim() : "";
      const newQty = parseFloat(qtyEl.value);
      if (!newCode) {
        status("Select an item from the Master Inventory list before saving.", "err");
        return;
      }
      if (!isFinite(newQty) || newQty <= 0) {
        status("Enter a quantity greater than zero.", "err");
        return;
      }
      recomputeAfterEdit(r, newCode, "", newQty, unitEl.value.trim() || r.unit);
      r.editing = false;
    }
    render();
  }

  function render() {
    const job = state.parsedJob;
    const t = tallyTotals();
    const u = unresolvedByStatus();

    const rowsHtml = state.rows.map((r, i) => {
      if (r.editing) {
        const codeLabel = r.itemId ? `${esc(r.code)} — ${esc(r.description)}` : esc(r.code);
        return `<tr class="fp-editing">
          <td class="fp-code-picker">
            <input class="fp-inline-input" id="fpEditCodeSearch${i}" type="text" value="${codeLabel}"
              placeholder="Type to search Master Inventory" autocomplete="off">
            <input type="hidden" id="fpEditCodeValue${i}" value="${r.itemId ? esc(r.code) : ""}">
            <div class="fp-dropdown-results" id="fpEditCodeResults${i}" hidden></div>
          </td>
          <td><input class="fp-inline-input" id="fpEditDesc${i}" type="text" value="${esc(r.description)}" readonly></td>
          <td class="num">
            <input class="fp-inline-input fp-inline-input-num" id="fpEditQty${i}" type="number" step="any" min="0" value="${r.requiredQty}">
            <input class="fp-inline-input fp-inline-input-unit" id="fpEditUnit${i}" type="text" value="${esc(r.unit)}">
          </td>
          <td class="num">${r.available != null ? fmt(r.available) : "—"}</td>
          <td class="num">—</td>
          <td class="num">—</td>
          <td class="small muted">Editing…</td>
          <td><div class="fp-row-actions">
            <button data-act="save-edit" data-i="${i}" class="on">Save</button>
            <button data-act="cancel-edit" data-i="${i}">Cancel</button>
          </div></td>
        </tr>`;
      }
      const rowClass = r.decided && r.action === "skip" ? "fp-skipped" : "";
      const remainingClass = r.remaining != null && r.remaining < 0 ? 'style="color:var(--danger); font-weight:600"' : "";
      const displayStatus = r.decided && r.action === "skip" ? "skipped" : r.status;
      const variantNote = r.hasVariants
        ? `<div class="small muted">Code has multiple Master Inventory rows — the row with the best cost/length match was used.</div>`
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
        ${u.unmatched ? `<li><b>${u.unmatched} unmatched item${u.unmatched === 1 ? "" : "s"}</b> — code not in the Master Inventory. Not deducted; click Edit to correct the code, or Acknowledge to confirm you've seen it.
          <span class="fp-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>` : ""}
      </ul>
    </div>` : "";
    const shortageNote = t.shortages > 0 ? `<p class="small muted" style="color:var(--danger)">
      ${t.shortages} item${t.shortages === 1 ? "" : "s"} will go negative — allowed, and shown in red below.
      A future Check-in will correct it.</p>` : "";

    $("#fpOut").innerHTML = `
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
      ${shortageNote}
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
      The confirm button unlocks once every unmatched row has been edited or acknowledged.</p>
    `;

    const canConfirm =
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !state.rows.some((r) => r.editing) &&
      !!$("#fpJobNumber").value.trim() &&
      !!$("#fpClient").value.trim();
    $("#fpConfirmSummary").textContent =
      `${t.totalItems} items · ${money(t.totalValue)}` +
      (t.skipped ? ` · ${t.skipped} skipped` : "");
    $("#fpConfirmBar").hidden = false;
    $("#fpConfirm").disabled = !canConfirm;

    document.querySelectorAll("#fpOut .fp-row-actions button, #fpOut .fp-batch-actions button").forEach((b) => {
      b.addEventListener("click", () => applyRowAction(+b.dataset.i, b.dataset.act));
    });
    state.rows.forEach((r, i) => { if (r.editing) wireCodePicker("fpEdit", state.itemsByCode, i); });
  }

  /* --------------------------- Confirm & apply --------------- */

  async function confirmAllocation() {
    const jobRef = $("#fpJobNumber").value.trim();
    const client = $("#fpClient").value.trim();
    const lines = state.rows
      .filter((r) => r.action === "deduct" && r.itemId)
      .map((r) => ({ item_id: r.itemId, quantity: r.requiredQty, unit: r.unit }));

    const res = await fetch(CHECKOUT_FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + window.ORYX_CONFIG.supabaseKey,
        "apikey": window.ORYX_CONFIG.supabaseKey,
      },
      body: JSON.stringify({
        job_number: jobRef,
        client,
        pdf_hash: state.pdfHash,
        source_document_name: state.pdfFile ? state.pdfFile.name : null,
        lines,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      if (data.error === "duplicate_document") {
        throw new Error("This PDF has already been checked out — re-processing it would double-count the deduction.");
      }
      if (data.error === "insufficient_stock") {
        throw new Error("Stock changed since this was analysed — re-run Analyse and preview to refresh availability.");
      }
      throw new Error(data.detail || data.error || "The Check-out was not applied.");
    }

    $("#fpConfirmBar").hidden = true;
    $("#fpDone").innerHTML = `
      <div class="fp-done">
        <h3>Check-out confirmed — ${data.lines.length} item${data.lines.length === 1 ? "" : "s"} deducted</h3>
        <p class="small">Job <code>${esc(jobRef)}</code> for <b>${esc(client)}</b>. The Master Inventory
        and the Inventory tab now reflect this. A permanent Check-out transaction has been recorded for each item.</p>
        <div class="fp-done-actions">
          <button class="ghost" id="fpNew">Start another Check-out</button>
        </div>
      </div>`;
    $("#fpNew").addEventListener("click", resetAll);
  }

  /* --------------------------- Analyse pipeline -------------- */

  async function analyse() {
    if (!state.pdfFile) return;
    const btn = $("#fpExtract");
    btn.disabled = true;
    status("Reading the PDF and matching items against the Master Inventory…");
    try {
      const [pdfText, itemsByCode, hash] = await Promise.all([
        extractPdfText(state.pdfFile),
        loadInventoryItems(),
        pdfFingerprint(state.pdfFile),
      ]);
      state.parsedJob = parseJobHeader(pdfText);
      state.itemsByCode = itemsByCode;
      state.pdfHash = hash;

      const jbox = $("#fpJobNumber");
      if (!jbox.value.trim() && state.parsedJob.ref) jbox.value = state.parsedJob.ref;

      const entries = parsePdf(pdfText);
      state.rows = buildRows(entries, state.itemsByCode);
      render();

      const t = tallyTotals();
      status(`Analysis ready — ${t.totalItems + t.unresolved} items in the PDF, ${t.unresolved} need decisions.`);
    } catch (err) {
      console.error(err);
      status("Could not analyse the PDF: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  /* --------------------------- Reset / status ---------------- */

  function resetAll() {
    state.pdfFile = null;
    state.pdfHash = state.parsedJob = state.rows = state.itemsByCode = null;
    $("#fpPdf").value = "";
    $("#fpPdfName").textContent = "Click or drop the PDF file here";
    $("#fpDrop").classList.remove("ready");
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
      if (kind === "pdf") { state.pdfFile = f; $("#fpPdfName").textContent = f.name; }
      dropEl.classList.add("ready");
      $("#fpExtract").disabled = !state.pdfFile;
    });
  }

  /* --------------------------- Check-in ------------------------ */
  // Mirrors the Check-out workflow above (upload -> analyse -> preview ->
  // confirm), but adds stock instead of subtracting it, and reads a supplier
  // Commercial Invoice / delivery note instead of an FP Pro PDF. Matching
  // against the Master Inventory reuses loadInventoryItems()/pickInventoryRow
  // from the Check-out code above -- both workflows look up the same table
  // the same way.

  const CHECKIN_FN_URL = window.ORYX_CONFIG.supabaseUrl + "/functions/v1/checkin";

  const ciState = {
    pdfFile: null,
    pdfHash: null,
    header: null, // {supplier, invoiceNumber, poNumber, isoDate}
    rows: null,
    itemsByCode: null,
    currency: "AED",
    exchangeRate: 1, // to AED; null when no rate is available yet (API + cache both empty)
    rateDate: null, // the date the fetched rate is "as of" (API's own date, not the invoice date)
    rateSource: "n/a", // 'api-dated' | 'api-latest' | 'api-latest-fallback' | 'cache-fallback' | 'manual' | 'unavailable' | 'n/a'
    ratesByCurrency: null,
  };

  // Currencies this reader looks for on a supplier document. Detection just
  // counts which of these codes appears most often in the text -- good
  // enough for a one-currency invoice, and the user can see (and would
  // notice) if it picked the wrong one since it's shown plainly in the
  // preview before anything is confirmed.
  const SUPPORTED_CURRENCIES = ["AED", "AUD", "USD", "EUR", "GBP", "SAR", "QAR", "KWD", "OMR", "BHD"];
  function detectDocumentCurrency(text) {
    const re = new RegExp(`\\b(${SUPPORTED_CURRENCIES.join("|")})\\b`, "g");
    const counts = {};
    let m;
    while ((m = re.exec(text)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
    let best = "AED", bestCount = 0;
    for (const [cur, n] of Object.entries(counts)) {
      if (n > bestCount) { best = cur; bestCount = n; }
    }
    return best;
  }

  // exchange_rates is a resilience cache, not the source of truth: it's
  // updated automatically after every successful Check-in (see
  // checkin_transaction()) with whatever rate was actually used -- API or
  // manual -- so if the live API is briefly unreachable there's a last-known
  // value to offer instead of leaving the user with nothing. It is never
  // the first place we look.
  async function loadExchangeRates() {
    const { data, error } = await sb.from("exchange_rates").select("*");
    if (error) throw new Error("Could not load exchange rates: " + error.message);
    const map = new Map();
    for (const row of data) map.set(row.currency, { rate: Number(row.rate_to_aed), asOf: row.updated_at });
    return map;
  }

  // https://github.com/fawazahmed0/exchange-api -- free, no API key. Each
  // release is tagged by date, so requesting a specific date's version
  // gives that date's historical rate; "latest" gives today's. No rate is
  // ever hard-coded here -- if both the dated and latest requests fail (or
  // the currency isn't in the response), this returns null and the caller
  // must flag the transaction rather than invent a number.
  async function fetchRateFromApi(currencyCode, version) {
    const cur = currencyCode.toLowerCase();
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/${cur}.json`;
    let res;
    try {
      res = await fetch(url);
    } catch {
      return null; // network failure -- not the same as "currency doesn't exist", but treated the same: don't guess
    }
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch { return null; }
    const rate = data && data[cur] && typeof data[cur].aed === "number" ? data[cur].aed : null;
    if (rate == null) return null;
    return { rate, rateDate: data.date || null };
  }

  // Tries the invoice's own document date first (per spec: use the
  // date-specific rate for historical invoices, not today's), falls back to
  // "latest" only if that specific date isn't published, and reports which
  // path was actually taken so the preview can say so plainly.
  async function fetchCheckinExchangeRate(currencyCode, isoDocDate) {
    if (isoDocDate) {
      const dated = await fetchRateFromApi(currencyCode, isoDocDate);
      if (dated) return { ...dated, source: "api-dated" };
    }
    const latest = await fetchRateFromApi(currencyCode, "latest");
    if (latest) return { ...latest, source: isoDocDate ? "api-latest-fallback" : "api-latest" };
    return null;
  }

  const RATE_SOURCE_LABEL = {
    "api-dated": "currency-api",
    "api-latest": "currency-api (latest)",
    "api-latest-fallback": "currency-api (latest — historical rate for the invoice date wasn't available)",
    "cache-fallback": "last rate on file — the currency API was unavailable",
    "manual": "entered manually",
    "unavailable": "unavailable",
    "n/a": "n/a",
  };

  function genericMoney(n, code) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return `${code} ` + fmt(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Matches the numbered line-item rows of a Commercial Invoice table, e.g.
  // "6 230034 Each 200 0.58 0.00 116.00 392530" -> Ln, Part Number, Units,
  // Qty, Price, GST, Total, HS Code. Verified against the supplied sample
  // (Freedom Screens commercial invoice format).
  const CI_LINE_RE = /^(\d+)\s+([A-Za-z0-9-]+)\s+(\S+)\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{5,8})$/;

  function parseCommercialInvoiceLines(text) {
    const out = [];
    for (const raw of text.split("\n")) {
      const m = raw.trim().match(CI_LINE_RE);
      if (!m) continue;
      out.push({
        code: m[2],
        unit: m[3],
        qty: parseInt(m[4], 10),
        unitCost: parseFloat(m[5].replace(/,/g, "")),
        total: parseFloat(m[7].replace(/,/g, "")),
      });
    }
    // Same code+unit can appear twice on one invoice -- sum rather than
    // overwrite, same defensive aggregation as the Check-out PDF parser.
    const byKey = new Map();
    for (const l of out) {
      const key = `${l.code}|${l.unit}`;
      const cur = byKey.get(key);
      if (cur) { cur.qty += l.qty; cur.total += l.total; }
      else byKey.set(key, { ...l });
    }
    return [...byKey.values()];
  }

  // Best-effort only: description text sits in a separate block of the PDF's
  // text layer, disconnected from its numeric row. Used purely as a display
  // hint (mainly for unmatched rows) -- matched rows always show the Master
  // Inventory's own description instead, so a wrong guess here never affects
  // what gets checked in.
  //
  // Critically, this only starts collecting *after* the last numbered
  // line-item row: header/address text above the table (e.g. "13 Blue Rock
  // Drive", the "Ln Part Number Units..." column header) is free text that
  // doesn't match any skip pattern, and starting collection too early was
  // found (via the supplied sample invoice) to silently shift every
  // description out of alignment with its line -- exactly the kind of wrong
  // guess this feature must not produce.
  const CI_SKIP_LINE_RE = /^(sub ?total|total|invoice|goods made|product of|components for|reference|bill to|att:|tel:|abn:|page \d|commercial invoice|freedom|luscombe|australia|dubai|unit \d|al quoz|oryx door systems|description|\d{1,2}\/\d{1,2}\/\d{4}$|[\d,]+\.\d{2}$|-$)/i;
  function parseCommercialInvoiceDescriptions(text, count) {
    const lines = text.split("\n");
    let lastLineItemIdx = -1;
    lines.forEach((raw, i) => { if (CI_LINE_RE.test(raw.trim())) lastLineItemIdx = i; });
    if (lastLineItemIdx === -1) return [];

    const out = [];
    for (const raw of lines.slice(lastLineItemIdx + 1)) {
      if (out.length >= count) break;
      const l = raw.trim();
      if (!l || l.length < 3 || l.length > 70) continue;
      if (CI_SKIP_LINE_RE.test(l)) continue;
      out.push(l);
    }
    return out;
  }

  function parseCheckinHeader(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const supplier = lines.find((l) => /pty ltd|llc|inc\.?$|company|screens|trading|industries/i.test(l)) || "";
    // SQ- covers Quotes/Order Approvals (Quote Number), alongside the
    // existing Commercial Invoice / delivery note prefixes.
    const invoiceNumber = (text.match(/\b(?:SI|SO|SQ|INV|DN)-\d+\b/i) || [])[0] || "";
    const poNumber = (text.match(/\bPO-[\w-]+\b/i) || [])[0] || "";
    const dm = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    const isoDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : "";
    return { supplier, invoiceNumber, poNumber, isoDate };
  }

  // --- Additional Check-in document layouts (Quotes, Order Approvals) ----
  //
  // Suppliers don't all use the Commercial Invoice's column order. The three
  // extra layouts below were reverse-engineered from real supplier PDFs and
  // share a structural quirk: their table is rendered in *reverse* column
  // order in the PDF's text layer (Total ... Code Ln instead of Ln ... Code
  // Total), even though the table reads left-to-right when the PDF is
  // viewed. Each format below is defined by a regex anchored at both ends of
  // the line -- the leading numeric/price fields and the trailing "<code>
  // <line number>" pair -- with the description captured in between. This
  // never invents a value: every field is read verbatim from the document;
  // an unrecognised layout simply produces zero matches for these formats,
  // same as it always has for the Commercial Invoice reader.
  //
  // "Ln" is deliberately kept small (1-3 digits) and "Code" is required to
  // look like a product code (3-15 letters/digits/hyphens, no spaces) --
  // narrow enough that ordinary prose elsewhere in the document (terms and
  // conditions, signature blocks, page numbers) doesn't accidentally match.
  const QUOTE_CODE_RE = "[A-Za-z0-9-]{3,15}";
  const QUOTE_LN_RE = "\\d{1,3}";

  const CHECKIN_FORMATS = [
    {
      // Existing Commercial Invoice reader -- untouched. Always tried
      // first, so this format's behaviour can never regress.
      id: "commercial-invoice",
      label: "Commercial Invoice",
      lineRe: CI_LINE_RE,
      extract: (m) => ({ ln: parseInt(m[1], 10), code: m[2], unit: m[3], qty: parseInt(m[4], 10), unitCost: parseFloat(m[5].replace(/,/g, "")) }),
    },
    {
      // "Total | Discounted Price | Discount % | Price | Qty | Description | Code | Ln"
      // e.g. "306.50 6.13 0% 6.13 50 ZLS1 End Cap 60 A WHT 3300 1"
      id: "quote-discount",
      label: "Quote (with Discount %)",
      lineRe: new RegExp(`^[\\d,]+\\.\\d{2}\\s+[\\d,]+\\.\\d{2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{2})\\s+(\\d{1,6})\\s+(.+?)\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unitCost: parseFloat(m[1].replace(/,/g, "")), qty: parseInt(m[2], 10), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
      // A wrapped description pushes the code/line number onto a later
      // physical line -- this matches just the numeric prefix, so the row
      // can still be recovered by stitching it to the terminal code/line
      // that follows (see stitchWrappedRows below), instead of being lost.
      orphanRe: new RegExp(`^([\\d,]+\\.\\d{2})\\s+[\\d,]+\\.\\d{2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{2})\\s+(\\d{1,6})$`),
      orphanExtract: (m) => ({ unitCost: parseFloat(m[2].replace(/,/g, "")), qty: parseInt(m[3], 10) }),
    },
    {
      // "Total | Tax % | Price | Qty | Description | Code | Ln"
      // e.g. "116.00 0% 0.58 200 SMB1 Slide Lock WHT 230034 1"
      id: "quote-tax",
      label: "Quote (with Tax %)",
      lineRe: new RegExp(`^[\\d,]+\\.\\d{2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{2})\\s+(\\d{1,6})\\s+(.+?)\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unitCost: parseFloat(m[1].replace(/,/g, "")), qty: parseInt(m[2], 10), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
      orphanRe: new RegExp(`^([\\d,]+\\.\\d{2})\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{2})\\s+(\\d{1,6})$`),
      orphanExtract: (m) => ({ unitCost: parseFloat(m[2].replace(/,/g, "")), qty: parseInt(m[3], 10) }),
    },
    {
      // "Units | Qty | Description | Code | Ln" -- no pricing at all (e.g. a
      // signed Order Approval). unitCost is left undefined; the preview
      // shows "—" for cost/value on these rows rather than a fabricated 0.
      id: "order-approval",
      label: "Order Approval (no pricing)",
      lineRe: new RegExp(`^(\\S+)\\s+(\\d{1,6})\\s+(.+?)\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unit: m[1], qty: parseInt(m[2], 10), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
    },
  ];

  // Recovers rows whose description wrapped across multiple physical lines,
  // splitting "<numbers> <description> <code> <ln>" into a numbers-only line
  // followed by one or more description lines and a final "<code> <ln>"
  // line. Only stitches when a clean terminal line is found within a few
  // lines -- if it can't confidently find where the row ends, it leaves
  // that row unextracted rather than guessing.
  function stitchWrappedRows(rawLines, format) {
    if (!format.orphanRe) return { rows: [], usedIdx: new Set() };
    const termRe = new RegExp(`^(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`);
    const rows = [];
    const usedIdx = new Set();
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i].trim();
      const om = raw.match(format.orphanRe);
      if (!om) continue;
      const descParts = [];
      let term = null;
      for (let j = i + 1; j < Math.min(i + 6, rawLines.length); j++) {
        const l2 = rawLines[j].trim();
        const tm = l2.match(termRe);
        if (tm) { term = { code: tm[1], ln: parseInt(tm[2], 10), endIdx: j }; break; }
        if (l2) descParts.push(l2);
      }
      if (!term) continue;
      usedIdx.add(i);
      for (let k = i + 1; k <= term.endIdx; k++) usedIdx.add(k);
      rows.push({ ...format.orphanExtract(om), description: descParts.join(" ").trim(), code: term.code, ln: term.ln });
    }
    return { rows, usedIdx };
  }

  // Tries every known Check-in document layout and uses whichever produces
  // the most matched rows -- this is the "recognise the document's actual
  // structure" step. Zero rows across every format means the document isn't
  // one this reader recognises; the caller must not fabricate anything from
  // that and must show a clear message instead.
  function parseCheckinDocument(text) {
    const rawLines = text.split("\n");
    let best = { formatId: null, formatLabel: null, entries: [] };
    for (const format of CHECKIN_FORMATS) {
      const entries = [];
      const usedIdx = new Set();
      rawLines.forEach((raw, i) => {
        const m = raw.trim().match(format.lineRe);
        if (!m) return;
        entries.push(format.extract(m));
        usedIdx.add(i);
      });
      const { rows: wrapped } = stitchWrappedRows(rawLines, format);
      entries.push(...wrapped);
      if (entries.length > best.entries.length) best = { formatId: format.id, formatLabel: format.label, entries };
    }
    if (!best.entries.length) return best;

    // The same genuine item can appear twice on one document -- sum rather
    // than overwrite. Description is included in the key deliberately: a
    // short/truncated code (see the Quote-with-Discount% sample) can be
    // shared by many genuinely different products, and merging purely by
    // code would silently blend their quantities into one fabricated total
    // under whichever description happened to be seen first -- exactly the
    // kind of wrong guess this reader must not produce. Requiring the
    // description to match too means only truly identical lines merge.
    const byKey = new Map();
    for (const e of best.entries) {
      const key = `${e.code}|${e.unit || ""}|${e.description || ""}`;
      const cur = byKey.get(key);
      if (cur) { cur.qty += e.qty; if (Number.isInteger(e.ln)) cur.lns.push(e.ln); }
      else byKey.set(key, { ...e, lns: Number.isInteger(e.ln) ? [e.ln] : [] });
    }
    best.entries = [...byKey.values()];

    // No silent gaps: if this format's rows carry a line number and the
    // sequence has a hole (e.g. Ln 1-19, 21-34 but no 20), that specific
    // line failed to parse -- usually because its own layout broke the
    // pattern in some unexpected way (a value wrapped mid-token, an extra
    // blank line). Rather than the row just quietly not existing, say so.
    // (Merged duplicate lines keep every one of their original Ln numbers
    // in `lns`, so a legitimate merge is never mistaken for a parse gap.)
    const lns = best.entries.flatMap((e) => e.lns);
    if (lns.length) {
      const seen = new Set(lns);
      const maxLn = Math.max(...lns);
      const missing = [];
      for (let n = 1; n <= maxLn; n++) if (!seen.has(n)) missing.push(n);
      best.missingLnNumbers = missing;
    } else {
      best.missingLnNumbers = [];
    }
    return best;
  }

  function buildCheckinRows(lines, descriptions, itemsByCode) {
    const rows = [];
    lines.forEach((l, i) => {
      const candidates = itemsByCode.get(l.code) || [];
      const item = pickInventoryRow({ kind: "checkin" }, candidates);
      // Description comes straight from the row parser when that format
      // captures it inline (every non-Commercial-Invoice format); only the
      // Commercial Invoice reader relies on the separate description block.
      const pdfDescription = l.description || (descriptions.length === lines.length ? descriptions[i] : "");
      // A very short code (<=4 chars) that still didn't match anything is
      // worth calling out explicitly -- real Master Inventory codes are
      // 5-6 digits, so this is a strong hint the source document truncated
      // its own Code column rather than this reader mis-parsing it.
      const truncatedHint = !item && l.code && l.code.length <= 4;
      if (!item) {
        rows.push({
          code: l.code, description: pdfDescription, unit: l.unit || "", qty: l.qty,
          invoiceUnitCost: l.unitCost,
          current: null, newQty: null,
          status: "unmatched", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint,
        });
        return;
      }
      rows.push({
        code: l.code, description: item.description || pdfDescription, unit: l.unit || "", qty: l.qty,
        invoiceUnitCost: l.unitCost,
        current: item.current_qty, newQty: item.current_qty + l.qty,
        status: "ok", action: "add", decided: true,
        itemId: item.id, editing: false, truncatedHint: false,
      });
    });
    return rows;
  }

  function recomputeCiRowAfterEdit(row, newCode, newDescription, newQty, newUnit) {
    row.code = newCode; row.description = newDescription; row.qty = newQty; row.unit = newUnit;
    const candidates = ciState.itemsByCode.get(newCode) || [];
    const item = pickInventoryRow({ kind: "checkin" }, candidates);
    if (!item) {
      row.current = null; row.newQty = null;
      row.status = "unmatched"; row.action = "pending"; row.decided = false;
      row.itemId = null;
      return;
    }
    row.description = item.description || newDescription;
    row.current = item.current_qty;
    row.newQty = item.current_qty + newQty;
    row.status = "ok"; row.action = "add"; row.decided = true;
    row.itemId = item.id;
  }

  function ciRate() {
    return ciState.currency === "AED" ? 1 : (ciState.exchangeRate || null);
  }

  function ciTally() {
    const active = ciState.rows.filter((r) => r.action === "add");
    const rate = ciRate();
    const totalValueOriginal = active.reduce((s, r) => s + r.qty * (r.invoiceUnitCost || 0), 0);
    return {
      totalItems: active.length,
      totalValueOriginal,
      totalValueAed: rate ? totalValueOriginal * rate : null,
      unresolved: ciState.rows.filter((r) => !r.decided).length,
      skipped: ciState.rows.filter((r) => r.decided && r.action === "skip").length,
    };
  }

  function ciRenderRowActionButtons(idx, row) {
    const on = (yes) => yes ? "on" : "";
    const editBtn = `<button data-act="edit" data-i="${idx}">Edit</button>`;
    if (row.status === "ok") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.action === "skip")}">Skip</button>
        ${row.action === "skip" ? `<button data-act="add" data-i="${idx}">Undo</button>` : ""}
        ${editBtn}
      </div>`;
    }
    return `<div class="fp-row-actions">
      <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Acknowledge</button>
      ${editBtn}
    </div>`;
  }

  function applyCiRowAction(idx, act) {
    if (act === "skip-all-unmatched") {
      ciState.rows.forEach((rr) => {
        if (rr.decided) return;
        if (rr.status === "unmatched") { rr.action = "skip"; rr.decided = true; }
      });
      ciRender();
      return;
    }
    const r = ciState.rows[idx];
    if (!r) return;
    if (act === "skip") { r.action = "skip"; r.decided = true; }
    else if (act === "add") { r.action = "add"; r.decided = true; }
    else if (act === "edit") { r.editing = true; }
    else if (act === "cancel-edit") { r.editing = false; }
    else if (act === "save-edit") {
      // The code can only ever be a value the dropdown picker committed
      // (ciEditCodeValue) -- never free-typed text -- so a save can never
      // resolve to anything but an existing Master Inventory record.
      const codeValueEl = document.getElementById(`ciEditCodeValue${idx}`);
      const qtyEl = document.getElementById(`ciEditQty${idx}`);
      const unitEl = document.getElementById(`ciEditUnit${idx}`);
      const newCode = codeValueEl ? codeValueEl.value.trim() : "";
      const newQty = parseFloat(qtyEl.value);
      if (!newCode) {
        ciStatus("Select an item from the Master Inventory list before saving.", "err");
        return;
      }
      if (!isFinite(newQty) || newQty <= 0) {
        ciStatus("Enter a quantity greater than zero.", "err");
        return;
      }
      recomputeCiRowAfterEdit(r, newCode, "", newQty, unitEl.value.trim() || r.unit);
      r.editing = false;
    }
    ciRender();
  }

  // Renders the Master Inventory code picker for an editing row: a search
  // box plus a click-to-select results list. The committed code only ever
  // changes via a click on a real Master Inventory entry -- there is no way
  // to save free-typed text, so a Check-in edit can never point at (or
  // implicitly create) anything that isn't an existing item.
  // Shared by both Check-out's Allocation Preview and Check-in's Preview:
  // a search box plus a click-to-select results list, backed by whichever
  // itemsByCode map the caller passes in. The committed code only ever
  // changes via a click on a real Master Inventory entry -- there's no way
  // to save free-typed text -- so an edit can never point at (or implicitly
  // create) anything that isn't an existing item.
  function wireCodePicker(prefix, itemsByCode, i) {
    const searchEl = document.getElementById(`${prefix}CodeSearch${i}`);
    const valueEl = document.getElementById(`${prefix}CodeValue${i}`);
    const resultsEl = document.getElementById(`${prefix}CodeResults${i}`);
    const descEl = document.getElementById(`${prefix}Desc${i}`);
    if (!searchEl) return;

    const allCodes = [...itemsByCode.keys()].sort();
    function renderResults(query) {
      const q = query.trim().toLowerCase();
      const matches = allCodes.filter((code) => {
        if (!q) return true;
        if (code.toLowerCase().includes(q)) return true;
        const cand = itemsByCode.get(code)[0];
        return (cand.description || "").toLowerCase().includes(q);
      }).slice(0, 30);
      resultsEl.innerHTML = matches.length
        ? matches.map((code) => {
            const cand = itemsByCode.get(code)[0];
            return `<div class="fp-dropdown-option" data-code="${esc(code)}"><span class="code">${esc(code)}</span> — ${esc(cand.description || "")}</div>`;
          }).join("")
        : `<div class="fp-dropdown-empty">No matching Master Inventory item.</div>`;
      resultsEl.hidden = false;
    }

    searchEl.addEventListener("focus", () => renderResults(searchEl.value));
    searchEl.addEventListener("input", () => { valueEl.value = ""; renderResults(searchEl.value); });
    searchEl.addEventListener("blur", () => { setTimeout(() => { resultsEl.hidden = true; }, 150); });
    // mousedown (not click) so it fires before the search box's blur closes the list.
    resultsEl.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".fp-dropdown-option");
      if (!opt) return;
      const code = opt.dataset.code;
      const cand = itemsByCode.get(code)[0];
      valueEl.value = code;
      searchEl.value = `${code} — ${cand.description || ""}`;
      descEl.value = cand.description || "";
      resultsEl.hidden = true;
    });
  }

  function ciRender() {
    const t = ciTally();
    const rate = ciRate();
    const unmatched = ciState.rows.filter((r) => !r.decided && r.status === "unmatched").length;
    const cur = ciState.currency;

    const rowsHtml = ciState.rows.map((r, i) => {
      if (r.editing) {
        // For an already-matched row, prefill with its own code so re-opening
        // Edit shows where it stands. For an unmatched/short-code row, prefill
        // with the extracted description instead -- the search box already
        // matches on description as well as code (wireCodePicker's
        // renderResults), so this surfaces likely Master Inventory matches
        // immediately on focus without any new matching logic. Either way
        // the hidden value only ever commits from a clicked suggestion.
        const codeLabel = r.itemId
          ? `${esc(r.code)} — ${esc(r.description)}`
          : esc(r.description || r.code);
        return `<tr class="fp-editing">
          <td class="fp-code-picker">
            <input class="fp-inline-input" id="ciEditCodeSearch${i}" type="text" value="${codeLabel}"
              placeholder="Type to search Master Inventory" autocomplete="off">
            <input type="hidden" id="ciEditCodeValue${i}" value="${r.itemId ? esc(r.code) : ""}">
            <div class="fp-dropdown-results" id="ciEditCodeResults${i}" hidden></div>
            ${!r.itemId ? `<div class="small muted" style="margin-top:2px">Extracted code: <code>${esc(r.code)}</code> — search below to find the right Master Inventory item.</div>` : ""}
          </td>
          <td><input class="fp-inline-input" id="ciEditDesc${i}" type="text" value="${esc(r.description)}" readonly></td>
          <td class="num">${r.current != null ? fmt(r.current) : "—"}</td>
          <td class="num">
            <input class="fp-inline-input fp-inline-input-num" id="ciEditQty${i}" type="number" step="any" min="0" value="${r.qty}">
            <input class="fp-inline-input fp-inline-input-unit" id="ciEditUnit${i}" type="text" value="${esc(r.unit)}">
          </td>
          <td class="num">—</td>
          <td class="num">${genericMoney(r.invoiceUnitCost, cur)}</td>
          <td class="num">—</td>
          <td class="small muted">Editing…</td>
          <td><div class="fp-row-actions">
            <button data-act="save-edit" data-i="${i}" class="on">Save</button>
            <button data-act="cancel-edit" data-i="${i}">Cancel</button>
          </div></td>
        </tr>`;
      }
      const rowClass = r.decided && r.action === "skip" ? "fp-skipped" : "";
      const displayStatus = r.decided && r.action === "skip" ? "skipped" : r.status;
      const aedValue = rate && r.invoiceUnitCost != null ? r.qty * r.invoiceUnitCost * rate : null;
      // Short-code warning now lives as a small badge next to the Code cell
      // instead of a bold paragraph under the Description -- same signal
      // (code may be truncated, never guessed/auto-completed), just less
      // alarming to read. Clicking it opens the same Edit row as the Edit
      // button (data-act/data-i match applyCiRowAction's existing handling).
      const reviewFlag = r.truncatedHint && r.status === "unmatched"
        ? `<button type="button" class="fp-code-review-flag" data-act="edit" data-i="${i}"
             title="Code may be incomplete. Please verify the correct item before confirming.">⚠ Review</button>`
        : "";
      return `<tr class="${rowClass}">
        <td class="code">${esc(r.code)}${reviewFlag}</td>
        <td>${esc(r.description)}</td>
        <td class="num">${r.current != null ? fmt(r.current) : "—"}</td>
        <td class="num" style="color:var(--brand); font-weight:600">+${fmt(r.qty)} ${esc(r.unit)}</td>
        <td class="num">${r.newQty != null ? fmt(r.newQty) : "—"}</td>
        <td class="num">${genericMoney(r.invoiceUnitCost, cur)}</td>
        <td class="num">${aedValue != null ? money(aedValue) : "—"}</td>
        <td>${ciStatusChip(r, displayStatus)}</td>
        <td>${ciRenderRowActionButtons(i, r)}</td>
      </tr>`;
    }).join("");

    const warnBox = unmatched > 0 ? `<div class="fp-warn">
      <h4>${unmatched} item${unmatched === 1 ? "" : "s"} need${unmatched === 1 ? "s" : ""} a decision</h4>
      <ul>
        <li><b>${unmatched} unmatched item${unmatched === 1 ? "" : "s"}</b> — code not in the Master Inventory.
          Not checked in; click Edit and pick the correct item from the Master Inventory list, or Acknowledge
          to confirm you've seen it. A new Master Inventory item is never created from here.
          <span class="fp-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>
      </ul>
    </div>` : "";

    const rateDateNote = ciState.rateDate ? ` (rate date ${esc(ciState.rateDate)})` : "";
    const sourceLabel = RATE_SOURCE_LABEL[ciState.rateSource] || ciState.rateSource;
    const currencyCard = cur === "AED"
      ? `<div class="fp-currency-card"><div class="fp-currency-note">Document is already in AED — no conversion needed.</div></div>`
      : `<div class="fp-currency-card">
          <div><label class="field-label">Original currency</label><strong>${esc(cur)}</strong></div>
          <div><label class="field-label">Original amount</label><strong>${genericMoney(t.totalValueOriginal, cur)}</strong></div>
          <div>
            <label class="field-label" for="ciRateInput">Exchange rate (1 ${esc(cur)} = ? AED)</label>
            <input id="ciRateInput" type="number" step="any" min="0" value="${rate != null ? rate : ""}" placeholder="e.g. 2.45">
          </div>
          <div><label class="field-label">AED amount</label><strong>${t.totalValueAed != null ? money(t.totalValueAed) : "—"}</strong></div>
          <div class="fp-currency-note">${
            ciState.rateSource === "unavailable"
              ? `Could not retrieve an exchange rate for ${esc(cur)} from the currency API, and none is on file — flagged for review. Enter the current rate to continue.`
              : `Rate source: ${esc(sourceLabel)}${rateDateNote}. ${ciState.rateSource === "cache-fallback" || ciState.rateSource === "api-latest-fallback" ? "Check it's still current before confirming." : ""}`
          }</div>
        </div>`;

    $("#ciOut").innerHTML = `
      ${currencyCard}
      <div class="fp-tally">
        <div class="fp-tally-item"><strong>${t.totalItems}</strong><span>Items to check in</span></div>
        <div class="fp-tally-item"><strong>${t.totalValueAed != null ? money(t.totalValueAed) : "—"}</strong><span>AED inventory value</span></div>
        <div class="fp-tally-item"><strong>${t.skipped}</strong><span>Skipped</span></div>
        <div class="fp-tally-item"><strong>${t.unresolved}</strong><span>Unresolved</span></div>
      </div>
      ${warnBox}
      <div class="fp-section-h">Check-in preview</div>
      <div class="fp-scroll">
        <table class="fp-table">
          <thead><tr>
            <th>Code</th><th>Description</th>
            <th class="num">Current stock</th>
            <th class="num">Check-in qty</th>
            <th class="num">New stock</th>
            <th class="num">Unit cost (${esc(cur)})</th>
            <th class="num">Value (AED)</th>
            <th>Status</th><th>Action</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:var(--space-3)">Nothing has been added yet.
      The confirm button unlocks once every unmatched row has been edited or acknowledged${cur !== "AED" ? " and the exchange rate is entered" : ""}.</p>
    `;

    const canConfirm =
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !ciState.rows.some((r) => r.editing) &&
      !!rate &&
      !!$("#ciSupplier").value.trim() &&
      !!$("#ciInvoiceNumber").value.trim();
    $("#ciConfirmSummary").textContent =
      `${t.totalItems} items · ${t.totalValueAed != null ? money(t.totalValueAed) : "—"}` + (t.skipped ? ` · ${t.skipped} skipped` : "");
    $("#ciConfirmBar").hidden = false;
    $("#ciConfirm").disabled = !canConfirm;

    document.querySelectorAll("#ciOut .fp-row-actions button, #ciOut .fp-batch-actions button, #ciOut .fp-code-review-flag").forEach((b) => {
      b.addEventListener("click", () => applyCiRowAction(+b.dataset.i, b.dataset.act));
    });
    ciState.rows.forEach((r, i) => { if (r.editing) wireCodePicker("ciEdit", ciState.itemsByCode, i); });
    const rateInput = document.getElementById("ciRateInput");
    if (rateInput) {
      rateInput.addEventListener("change", () => {
        const v = parseFloat(rateInput.value);
        ciState.exchangeRate = isFinite(v) && v > 0 ? v : null;
        ciState.rateSource = "manual";
        ciState.rateDate = null;
        ciRender();
      });
    }
  }

  async function ciConfirm() {
    const supplier = $("#ciSupplier").value.trim();
    const invoiceNumber = $("#ciInvoiceNumber").value.trim();
    const poNumber = $("#ciPoNumber").value.trim();
    const docDate = $("#ciDocDate").value || null;
    const rate = ciRate();
    if (ciState.currency !== "AED" && !(rate > 0)) {
      throw new Error("Enter the exchange rate before confirming.");
    }
    const lines = ciState.rows
      .filter((r) => r.action === "add" && r.itemId)
      .map((r) => ({
        item_id: r.itemId, quantity: r.qty, unit: r.unit,
        // No document price (e.g. an Order Approval) -- send null, not a
        // fabricated 0, so checkin_transaction() falls back to the Master
        // Inventory's own unit_cost instead of recording a false free cost.
        unit_cost: r.invoiceUnitCost != null ? r.invoiceUnitCost * rate : null,
        original_unit_cost: r.invoiceUnitCost != null ? r.invoiceUnitCost : null,
      }));

    const res = await fetch(CHECKIN_FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + window.ORYX_CONFIG.supabaseKey,
        "apikey": window.ORYX_CONFIG.supabaseKey,
      },
      body: JSON.stringify({
        supplier, invoice_number: invoiceNumber, po_number: poNumber, document_date: docDate,
        pdf_hash: ciState.pdfHash,
        source_document_name: ciState.pdfFile ? ciState.pdfFile.name : null,
        currency: ciState.currency, exchange_rate: rate,
        rate_date: ciState.rateDate, rate_source: ciState.rateSource,
        lines,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      if (data.error === "duplicate_document") {
        throw new Error("This document has already been checked in — re-processing it would double-count the stock.");
      }
      throw new Error(data.detail || data.error || "The Check-in was not applied.");
    }

    $("#ciConfirmBar").hidden = true;
    const currencyNote = ciState.currency !== "AED"
      ? ` Converted from ${esc(ciState.currency)} at a rate of 1 ${esc(ciState.currency)} = ${rate} AED (${esc(RATE_SOURCE_LABEL[ciState.rateSource] || ciState.rateSource)}${ciState.rateDate ? `, rate date ${esc(ciState.rateDate)}` : ""}).`
      : "";
    $("#ciDone").innerHTML = `
      <div class="fp-done">
        <h3>Check-in confirmed — ${data.lines.length} item${data.lines.length === 1 ? "" : "s"} added</h3>
        <p class="small">Invoice <code>${esc(invoiceNumber || "—")}</code> from <b>${esc(supplier || "—")}</b>. The Master
        Inventory and the Transaction History now reflect this. A permanent Check-in transaction has been recorded for each item.${currencyNote}</p>
        <div class="fp-done-actions">
          <button class="ghost" id="ciNew">Start another Check-in</button>
        </div>
      </div>`;
    $("#ciNew").addEventListener("click", ciResetAll);
  }

  async function ciAnalyse() {
    if (!ciState.pdfFile) return;
    const btn = $("#ciExtract");
    btn.disabled = true;
    ciStatus("Reading the document and matching items against the Master Inventory…");
    try {
      const [pdfText, itemsByCode, hash, ratesByCurrency] = await Promise.all([
        extractPdfText(ciState.pdfFile),
        loadInventoryItems(),
        pdfFingerprint(ciState.pdfFile),
        loadExchangeRates(),
      ]);
      ciState.itemsByCode = itemsByCode;
      ciState.pdfHash = hash;
      ciState.header = parseCheckinHeader(pdfText);
      ciState.ratesByCurrency = ratesByCurrency;
      ciState.currency = detectDocumentCurrency(pdfText);

      const sEl = $("#ciSupplier"), iEl = $("#ciInvoiceNumber"), pEl = $("#ciPoNumber"), dEl = $("#ciDocDate");
      if (!sEl.value.trim() && ciState.header.supplier) sEl.value = ciState.header.supplier;
      if (!iEl.value.trim() && ciState.header.invoiceNumber) iEl.value = ciState.header.invoiceNumber;
      if (!pEl.value.trim() && ciState.header.poNumber) pEl.value = ciState.header.poNumber;
      if (!dEl.value && ciState.header.isoDate) dEl.value = ciState.header.isoDate;

      // Tries every known layout (Commercial Invoice, Quote variants, Order
      // Approval) and reads whichever one actually matches -- see
      // parseCheckinDocument() above. Checked before touching the currency
      // API: an unrecognised document should fail fast with a clear message,
      // not spend a network round-trip first.
      const doc = parseCheckinDocument(pdfText);
      if (!doc.entries.length) {
        ciStatus("This document isn't in a layout this reader recognises yet — no line items were found, so nothing can be checked in. The Master Inventory has not been changed.", "err");
        return;
      }

      if (ciState.currency === "AED") {
        ciState.exchangeRate = 1; ciState.rateDate = null; ciState.rateSource = "n/a";
      } else {
        ciStatus(`Reading the document and fetching the ${ciState.currency}→AED exchange rate…`);
        const fetched = await fetchCheckinExchangeRate(ciState.currency, dEl.value || null);
        if (fetched) {
          ciState.exchangeRate = fetched.rate;
          ciState.rateDate = fetched.rateDate;
          ciState.rateSource = fetched.source;
        } else {
          const cached = ratesByCurrency.get(ciState.currency);
          if (cached) {
            ciState.exchangeRate = cached.rate;
            ciState.rateDate = cached.asOf ? String(cached.asOf).slice(0, 10) : null;
            ciState.rateSource = "cache-fallback";
          } else {
            ciState.exchangeRate = null; ciState.rateDate = null; ciState.rateSource = "unavailable";
          }
        }
      }

      // Commercial Invoice descriptions live in a separate block of the PDF
      // (see parseCommercialInvoiceDescriptions above); every other format
      // captures its description inline, directly on each entry already.
      const descriptions = doc.formatId === "commercial-invoice"
        ? parseCommercialInvoiceDescriptions(pdfText, doc.entries.length)
        : [];
      ciState.rows = buildCheckinRows(doc.entries, descriptions, itemsByCode);
      ciRender();

      const t = ciTally();
      const rateNote = ciState.currency !== "AED"
        ? (ciState.exchangeRate ? ` Exchange rate sourced from ${RATE_SOURCE_LABEL[ciState.rateSource]}.` : " Exchange rate unavailable — flagged for review.")
        : "";
      const gapNote = doc.missingLnNumbers && doc.missingLnNumbers.length
        ? ` Could not reliably read line${doc.missingLnNumbers.length === 1 ? "" : "s"} ${doc.missingLnNumbers.join(", ")} from the document — check it manually; nothing was guessed for ${doc.missingLnNumbers.length === 1 ? "it" : "them"}.`
        : "";
      ciStatus(`Analysis ready — read as ${doc.formatLabel}, ${doc.entries.length} line${doc.entries.length === 1 ? "" : "s"} found in ${ciState.currency}, ${t.unresolved} need decisions.${rateNote}${gapNote}`);
    } catch (err) {
      console.error(err);
      ciStatus("Could not analyse the document: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function ciResetAll() {
    ciState.pdfFile = null;
    ciState.pdfHash = ciState.header = ciState.rows = ciState.itemsByCode = null;
    ciState.currency = "AED"; ciState.exchangeRate = 1; ciState.ratesByCurrency = null;
    ciState.rateDate = null; ciState.rateSource = "n/a";
    $("#ciPdf").value = "";
    $("#ciPdfName").textContent = "Click or drop the PDF file here";
    $("#ciDrop").classList.remove("ready");
    $("#ciSupplier").value = ""; $("#ciInvoiceNumber").value = "";
    $("#ciPoNumber").value = ""; $("#ciDocDate").value = "";
    $("#ciOut").innerHTML = "";
    $("#ciDone").innerHTML = "";
    $("#ciConfirmBar").hidden = true;
    $("#ciExtract").disabled = true;
    ciStatus("");
  }

  function ciStatus(text, kind) {
    const el = $("#ciStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  function wireCiDrop(dropEl, inputEl) {
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
      ciState.pdfFile = f;
      $("#ciPdfName").textContent = f.name;
      dropEl.classList.add("ready");
      $("#ciExtract").disabled = false;
    });
  }

  /* --------------------------- Master Inventory view ---------- */

  async function loadMasterInventoryView() {
    $("#miItemsBody").innerHTML = `<tr><td colspan="6" class="small muted">Loading…</td></tr>`;
    $("#miTxBody").innerHTML = `<tr><td colspan="7" class="small muted">Loading…</td></tr>`;
    try {
      const [itemsRes, txRes] = await Promise.all([
        sb.from("inventory_items").select("*").order("item_code"),
        // Fetched at line-item grain, then grouped back into one Check-out
        // per (job, client, timestamp) below -- Postgres's now() returns the
        // same value for every row inserted inside one checkout_transaction()
        // call, so that triple is a reliable grouping key.
        sb.from("inventory_transactions").select("*").order("created_at", { ascending: false }).limit(500),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (txRes.error) throw txRes.error;
      renderMasterInventoryView(itemsRes.data, txRes.data);
    } catch (err) {
      console.error(err);
      $("#miItemsBody").innerHTML = `<tr><td colspan="6" class="small" style="color:var(--danger)">Could not load: ${esc(err.message)}</td></tr>`;
      $("#miTxBody").innerHTML = "";
    }
  }

  function renderMasterInventoryView(items, txs) {
    const totalValue = items.reduce((s, it) => s + (it.current_value || 0), 0);
    const lowStock = items.filter((it) => it.buffer_level != null && it.current_qty <= it.buffer_level);
    $("#miTally").innerHTML = `
      <div class="fp-tally-item"><strong>${items.length}</strong><span>Items</span></div>
      <div class="fp-tally-item"><strong>${money(totalValue)}</strong><span>Total value (Freedom)</span></div>
      <div class="fp-tally-item"><strong>${lowStock.length}</strong><span>Low stock</span></div>
    `;

    const PAGE_SIZE = 25;
    let page = 0;

    function draw() {
      const q = ($("#miSearch").value || "").trim().toLowerCase();
      const onlyLow = $("#miFilter").value === "low";
      const filtered = items.filter((it) => {
        if (onlyLow && !(it.buffer_level != null && it.current_qty <= it.buffer_level)) return false;
        if (!q) return true;
        return it.item_code.toLowerCase().includes(q) || (it.description || "").toLowerCase().includes(q);
      });

      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      page = Math.min(page, pageCount - 1);
      const start = page * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      $("#miItemsBody").innerHTML = pageItems.map((it) => {
        const low = it.buffer_level != null && it.current_qty <= it.buffer_level;
        return `<tr>
          <td class="code">${esc(it.item_code)}</td>
          <td>${esc(it.description)}${it.bar_length_mm ? `<div class="small muted">${esc(it.bar_length_mm)} mm</div>` : ""}</td>
          <td class="num">${fmt(it.current_qty)}</td>
          <td class="num">${money(it.unit_cost)}</td>
          <td class="num">${money(it.current_value)}</td>
          <td>${low ? `<span class="fp-status-short">Low</span>` : it.current_qty <= 0 ? `<span class="fp-status-unmatched">Out</span>` : `<span class="fp-status-ok">OK</span>`}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="6" class="small muted">No items match.</td></tr>`;

      $("#miItemsPagerInfo").textContent = filtered.length
        ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`
        : "No items match.";
      $("#miItemsPageLabel").textContent = `Page ${page + 1} of ${pageCount}`;
      $("#miItemsPrev").disabled = page === 0;
      $("#miItemsNext").disabled = page >= pageCount - 1;
    }
    draw();
    $("#miSearch").oninput = () => { page = 0; draw(); };
    $("#miFilter").onchange = () => { page = 0; draw(); };
    $("#miItemsPrev").onclick = () => { page = Math.max(0, page - 1); draw(); };
    $("#miItemsNext").onclick = () => { page = page + 1; draw(); };

    renderTransactionHistory(txs);
  }

  // One row per transaction event (Check-out job or Check-in document), not
  // per line item — expandable to see the individual items that moved.
  // Check-out groups by (job, client, timestamp); Check-in groups by
  // (invoice/PO, supplier, timestamp) -- both rely on the same fact: every
  // line inserted by one checkout_transaction()/checkin_transaction() call
  // shares one Postgres now() value.
  function renderTransactionHistory(txs) {
    const groups = new Map();
    for (const tx of txs) {
      const isCheckin = tx.type === "check_in";
      const reference = isCheckin ? (tx.invoice_number || tx.po_number || "") : tx.job_number;
      const party = isCheckin ? tx.supplier : tx.client;
      const key = `${tx.type}|${reference}|${party}|${tx.created_at}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, type: tx.type, created_at: tx.created_at, reference, party, lines: [], totalValue: 0 };
        groups.set(key, g);
      }
      g.lines.push(tx);
      g.totalValue += tx.value || 0;
    }
    const groupList = [...groups.values()].slice(0, 20);

    $("#miTxBody").innerHTML = groupList.map((g) => `
      <tr class="fp-tx-group" data-key="${esc(g.key)}">
        <td><button class="fp-tx-toggle" data-key="${esc(g.key)}" aria-label="Show items">▸</button></td>
        <td>${esc(String(g.created_at).slice(0, 16).replace("T", " "))}</td>
        <td>${g.type === "check_in" ? `<span class="fp-status-ok">Check-in</span>` : `<span class="fp-status-unmatched">Check-out</span>`}</td>
        <td class="code">${esc(g.reference || "—")}</td>
        <td>${esc(g.party || "—")}</td>
        <td class="num">${g.lines.length}</td>
        <td class="num">${money(g.totalValue)}</td>
      </tr>
      <tr class="fp-tx-detail" data-detail-for="${esc(g.key)}" hidden>
        <td></td>
        <td colspan="6">
          <table class="fp-table fp-tx-detail-table">
            <thead><tr><th>Code</th><th>Description</th><th class="num">Qty</th><th class="num">Value</th></tr></thead>
            <tbody>
              ${g.lines.map((tx) => `<tr>
                <td class="code">${esc(tx.item_code)}</td>
                <td>${esc(tx.description)}</td>
                <td class="num">${fmt(tx.quantity)} ${esc(tx.unit)}</td>
                <td class="num">${money(tx.value)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="7" class="small muted">No transactions recorded yet.</td></tr>`;

    document.querySelectorAll(".fp-tx-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const detail = document.querySelector(`.fp-tx-detail[data-detail-for="${CSS.escape(key)}"]`);
        const open = !detail.hidden;
        detail.hidden = open;
        btn.textContent = open ? "▸" : "▾";
      });
    });
  }

  /* --------------------------- Check-out report export --------- */

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function fetchAllTransactions() {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("inventory_transactions")
        .select("*")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  // Groups line-item transactions back into one Check-out/Check-in event
  // per (reference, party, timestamp) -- same key as the Transaction History
  // view, since Postgres's now() returns one timestamp per
  // checkout_transaction()/checkin_transaction() call.
  function groupTransactions(txs) {
    const map = new Map();
    for (const tx of txs) {
      const isCheckin = tx.type === "check_in";
      const reference = isCheckin ? (tx.invoice_number || tx.po_number || "") : tx.job_number;
      const party = isCheckin ? tx.supplier : tx.client;
      const key = `${tx.type}|${reference}|${party}|${tx.created_at}`;
      let g = map.get(key);
      if (!g) {
        g = { created_at: tx.created_at, type: tx.type, reference, party, lines: [], totalValue: 0 };
        map.set(key, g);
      }
      g.lines.push(tx);
      g.totalValue += tx.value || 0;
    }
    return [...map.values()];
  }

  const REPORT_COLS = 6; // Code, Description, Qty, Unit, Unit Cost, Value

  // Oryx brand palette (per the account brief): blue is the primary colour,
  // used sparingly -- one banner, not a colour on every row.
  const ORYX_BLUE = "022A3A";
  const ORYX_SILVER = "A9A9A9";
  const STYLE_TITLE = {
    fill: { fgColor: { rgb: ORYX_BLUE } },
    font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } },
    alignment: { horizontal: "center", vertical: "center" },
  };
  const STYLE_LABEL = { font: { bold: true } };
  const STYLE_HEADER = {
    fill: { fgColor: { rgb: ORYX_SILVER } },
    font: { bold: true, color: { rgb: "FFFFFF" } },
  };

  function buildReportSheet(groups) {
    const aoa = [];
    const merges = [];
    const styledCells = []; // [row, col, style]
    const currencyCells = []; // [row, col] pairs to format as AED after the fact

    aoa.push(["Oryx Doors & Windows — Inventory Transaction Report"]);
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: REPORT_COLS - 1 } });
    styledCells.push([0, 0, STYLE_TITLE]);
    aoa.push([]);

    // Newest transaction first, matching the Transaction History view.
    for (const g of [...groups].reverse()) {
      const dateStr = String(g.created_at).slice(0, 16).replace("T", " ");
      const isCheckin = g.type === "check_in";

      const partyRow = aoa.length;
      aoa.push([`${isCheckin ? "Supplier" : "Client"}: ${g.party || "—"}`]);
      styledCells.push([partyRow, 0, STYLE_LABEL]);

      const refRow = aoa.length;
      aoa.push([`${isCheckin ? "Check-in" : "Job"} ${g.reference || "—"}`]);
      styledCells.push([refRow, 0, STYLE_LABEL]);

      const summaryRow = aoa.length;
      aoa.push([
        `Generated ${todayISO()}`, "", "", "",
        `${g.lines.length} item${g.lines.length === 1 ? "" : "s"}`,
        `Total AED ${g.totalValue.toFixed(2)}`,
      ]);
      styledCells.push([summaryRow, 4, { font: { italic: true } }], [summaryRow, 5, { font: { bold: true } }]);

      const headerRow = aoa.length;
      aoa.push(["Code", "Description", "Qty", "Unit", "Unit Cost", "Value"]);
      for (let c = 0; c < REPORT_COLS; c++) styledCells.push([headerRow, c, STYLE_HEADER]);

      for (const tx of g.lines) {
        const r = aoa.length;
        aoa.push([tx.item_code, tx.description, tx.quantity, tx.unit, tx.unit_cost_used, tx.value]);
        currencyCells.push([r, 4], [r, 5]);
      }
      aoa.push([]);
    }

    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = merges;
    ws["!cols"] = [{ wch: 12 }, { wch: 42 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 18 }];
    ws["!rows"] = [{ hpt: 22 }];
    for (const [r, c] of currencyCells) {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].z = '"AED" #,##0.00';
    }
    for (const [r, c, style] of styledCells) {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      ws[addr].s = style;
    }
    return ws;
  }

  async function exportCheckoutReport() {
    const btn = $("#miExportBtn");
    const setStatus = (text, kind) => {
      const el = $("#miExportStatus");
      el.textContent = text || "";
      el.style.color = kind === "err" ? "var(--danger)" : "";
    };
    btn.disabled = true;
    setStatus("Fetching every Check-out and Check-in transaction…");
    try {
      const [txs] = await Promise.all([fetchAllTransactions(), loadXlsxLib()]);
      if (!txs.length) {
        setStatus("No transactions recorded yet — nothing to export.");
        return;
      }
      const groups = groupTransactions(txs);
      const ws = buildReportSheet(groups);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Transactions");
      const outName = `Oryx Transaction Report - ${todayISO()}.xlsx`;
      window.XLSX.writeFile(wb, outName);
      setStatus(`Exported ${groups.length} transaction${groups.length === 1 ? "" : "s"} (${txs.length} items) as ${outName}.`);
    } catch (err) {
      console.error(err);
      setStatus("Could not export: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function init() {
    if (!$("#fpExtract")) { setTimeout(init, 50); return; }
    wireDrop($("#fpDrop"), $("#fpPdf"), "pdf");
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

    const miNavBtn = document.querySelector('nav button[data-v="master-inventory"]');
    if (miNavBtn) miNavBtn.addEventListener("click", loadMasterInventoryView);
    const exportBtn = $("#miExportBtn");
    if (exportBtn) exportBtn.addEventListener("click", exportCheckoutReport);

    wireCiDrop($("#ciDrop"), $("#ciPdf"));
    $("#ciExtract").addEventListener("click", ciAnalyse);
    $("#ciReset").addEventListener("click", ciResetAll);
    $("#ciConfirm").addEventListener("click", async () => {
      const btn = $("#ciConfirm");
      btn.disabled = true;
      try { await ciConfirm(); }
      catch (err) { console.error(err); ciStatus("Could not confirm: " + err.message, "err"); btn.disabled = false; }
    });
    ["ciSupplier", "ciInvoiceNumber", "ciPoNumber", "ciDocDate"].forEach((id) => {
      $("#" + id).addEventListener("input", () => { if (ciState.rows) ciRender(); });
    });
  }

  init();
})();
