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
          kind: e.kind, code: e.code,
          description: e.description, pdfDetail,
          requiredQty, unit,
          available: null, remaining: null,
          costPerUnit: 0, estValue: 0,
          status: "unmatched", baseStatus: "unmatched",
          action: "pending", decided: false,
          itemId: null, hasVariants: false,
        });
        continue;
      }
      const remaining = item.current_qty - requiredQty;
      const status = remaining < 0 ? "shortage" : "ok";
      rows.push({
        kind: e.kind, code: e.code,
        description: item.description || e.description, pdfDetail,
        requiredQty, unit,
        available: item.current_qty, remaining,
        costPerUnit: item.unit_cost || 0,
        estValue: requiredQty * (item.unit_cost || 0),
        status, baseStatus: status,
        action: status === "ok" ? "deduct" : "pending",
        decided: status === "ok",
        itemId: item.id,
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
        <button data-act="skip" data-i="${idx}" class="${on(row.decided && row.action === "skip")}">Skip (acknowledge)</button>
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
    if (act === "skip-all-shortage" || act === "skip-all-unmatched") {
      state.rows.forEach((rr) => {
        if (rr.decided) return;
        if (act === "skip-all-shortage" && rr.baseStatus === "shortage") { rr.action = "skip"; rr.decided = true; }
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

    const rowsHtml = state.rows.map((r, i) => {
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
        ${u.shortage ? `<li><b>${u.shortage} shortage${u.shortage === 1 ? "" : "s"}</b> — required qty exceeds available.
          This Phase 1 build blocks shortages rather than allowing negative stock; skip to acknowledge and leave
          this item out of the Check-out.
          <span class="fp-batch-actions">
            <button data-act="skip-all-shortage" data-i="-1">Skip all shortages</button>
          </span></li>` : ""}
        ${u.unmatched ? `<li><b>${u.unmatched} unmatched item${u.unmatched === 1 ? "" : "s"}</b> — code not in the Master Inventory. Not deducted; click Acknowledge to confirm you've seen them.
          <span class="fp-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>` : ""}
      </ul>
    </div>` : "";

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
      The confirm button unlocks once every row shows OK or Skipped.</p>
    `;

    const canConfirm =
      t.unresolved === 0 &&
      t.totalItems > 0 &&
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

  /* --------------------------- Master Inventory view ---------- */

  async function loadMasterInventoryView() {
    $("#miItemsBody").innerHTML = `<tr><td colspan="6" class="small muted">Loading…</td></tr>`;
    $("#miTxBody").innerHTML = `<tr><td colspan="6" class="small muted">Loading…</td></tr>`;
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

    renderCheckoutHistory(txs);
  }

  // One row per Check-out (job + client + timestamp), not per line item —
  // expandable to see the individual items that were deducted.
  function renderCheckoutHistory(txs) {
    const groups = new Map();
    for (const tx of txs) {
      const key = `${tx.job_number}|${tx.client}|${tx.created_at}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, created_at: tx.created_at, job_number: tx.job_number, client: tx.client, lines: [], totalValue: 0 };
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
        <td class="code">${esc(g.job_number)}</td>
        <td>${esc(g.client)}</td>
        <td class="num">${g.lines.length}</td>
        <td class="num">${money(g.totalValue)}</td>
      </tr>
      <tr class="fp-tx-detail" data-detail-for="${esc(g.key)}" hidden>
        <td></td>
        <td colspan="5">
          <table class="fp-table fp-tx-detail-table">
            <thead><tr><th>Code</th><th class="num">Qty</th><th class="num">Value</th></tr></thead>
            <tbody>
              ${g.lines.map((tx) => `<tr>
                <td class="code">${esc(tx.item_code)}</td>
                <td class="num">${fmt(tx.quantity)} ${esc(tx.unit)}</td>
                <td class="num">${money(tx.value)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="6" class="small muted">No Check-outs recorded yet.</td></tr>`;

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
  }

  init();
})();
