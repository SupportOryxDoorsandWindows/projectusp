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

  // Returns one text-layer string per page (1-indexed via array position),
  // not just one string for the whole document -- the Check-in reader needs
  // to judge (and, if needed, OCR) each page's usability separately, since a
  // mixed document (a normal typed header page, a scanned/photographed
  // item-table page) is otherwise judged "usable" overall from its good
  // page and the actually-unreadable page never gets OCR'd.
  async function extractPdfTextPerPage(file) {
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
    return pages;
  }

  async function extractPdfText(file) {
    return (await extractPdfTextPerPage(file)).join("\n\n");
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

  // Exact-code lookup, tolerant of case differences between how a supplier
  // document prints a code and how Master Inventory stores it (e.g. a real
  // invoice printed "30016r" in lowercase where Master Inventory has
  // "30016R") -- a plain Map.get() is case-sensitive and was silently
  // treating that as "code not found" even though it's the exact same item.
  // Confirmed against the live Master Inventory that no two distinct codes
  // collide when case-normalised, so this can never blend two different
  // products together. Falls back to the map's own casing first so this
  // never changes behaviour for the (overwhelming) common case where the
  // casing already matches.
  function lookupExactCode(itemsByCode, code) {
    if (!code) return [];
    const direct = itemsByCode.get(code);
    if (direct) return direct;
    const upper = code.toUpperCase();
    for (const [k, v] of itemsByCode) {
      if (k.toUpperCase() === upper) return v;
    }
    return [];
  }

  // Pulls a "<number>m" pack-size token out of free text ("300m", "(200m)")
  // -- the only place either an invoice line or a Master Inventory
  // description ever states a roll/length size. Returns null when there's
  // no such token, so a plain "Each"/"pcs" label (the common case) is never
  // treated as if it claimed a length.
  function parseLengthToken(text) {
    const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*m\b/i);
    return m ? parseFloat(m[1]) : null;
  }

  // Master Inventory only ever states a genuine roll/bundle length inside
  // parentheses -- "(200m)", "(300m Roll)" -- so this deliberately only
  // looks inside parenthesised groups, unlike parseLengthToken's whole-
  // string search. That distinction matters for descriptions like "Patio
  // Mesh 2.7m (30M)", where "2.7m" is the roll's WIDTH (stated outside the
  // parentheses) and "30M" inside them is the actual roll length -- reusing
  // parseLengthToken there would silently grab the width instead and divide
  // the roll's price by 2.7 instead of 30.
  function parseBundleLengthM(description) {
    const groups = String(description || "").match(/\(([^()]*)\)/g);
    if (!groups) return null;
    for (const g of groups) {
      const m = g.match(/(\d+(?:\.\d+)?)\s*m\b/i);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  // Detects a stated pack size in free text: either an "<n> per <container>"
  // count ("108 per sheet") or an "<n>m" roll/length token ("200m"). Returns
  // { type, qtyPerPackage, unit } or null if neither pattern is present --
  // an ordinary "Each"/"pcs" line matches nothing and is entirely
  // unaffected by any of the packaging logic below. This never guesses
  // WHICH interpretation is correct for the invoice's own quantity number
  // (that's still decided by the caller); it only extracts what the text
  // literally states.
  function parsePackaging(text) {
    const t = String(text || "");
    const perM = t.match(/(\d+(?:\.\d+)?)\s*(?:pcs?|pieces?)?\s*per\s*(sheet|box|pack|carton|roll)/i);
    if (perM) {
      const noun = perM[2].toLowerCase();
      return { type: noun.charAt(0).toUpperCase() + noun.slice(1), qtyPerPackage: parseFloat(perM[1]), unit: "pcs" };
    }
    const lenM = t.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    if (lenM) {
      return { type: /roll|coil|reel/i.test(t) ? "Roll" : "Length", qtyPerPackage: parseFloat(lenM[1]), unit: "m" };
    }
    return null;
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
      const candidates = lookupExactCode(itemsByCode, e.code);
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
    if (displayStatus === "new") return `<span class="fp-status-new">${dot}New item</span>`;
    // Deliberately reuses the same amber "Review" treatment as a truncated
    // code -- both mean "a match exists to consider, not a dead end" -- but
    // with its own label so the two situations are never mistaken for the
    // same thing when read from the Status column alone.
    if (displayStatus === "exact-diff") return `<span class="fp-status-review">${dot}Exact match — review</span>`;
    if (displayStatus === "pack-review") return `<span class="fp-status-review">${dot}Pack size — review</span>`;
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

  // Bumped whenever a new file is selected (see wireCiDrop) or a new
  // analysis starts (see ciAnalyse) -- an in-flight ciAnalyse() checks this
  // after every await and abandons its results if it no longer matches,
  // so a slow OCR run for a file the user has since replaced can never
  // overwrite the newer selection's state.
  let ciAnalyseToken = 0;

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
    missingLnNumbers: [], // line numbers detected in the raw text but not readable into a row
    missingLnAcknowledged: false,
    // Landed Cost: total shipping/freight/packing charge, in the document's
    // own currency (ciState.currency) -- null means "no such charge applies",
    // which leaves every existing calculation untouched. Set from
    // detectShippingCharge() on Analyse, but always user-editable in the
    // preview before Confirm; never written anywhere without being visible
    // there first.
    shippingAmountOriginal: null,
    shippingNote: "",
    shippingNeedsReview: false,
    // Set when the text layer had nothing usable and this document was
    // instead read via OCR (see ocrPdfPages below) -- OCR can misread a
    // character rather than simply fail to find one, so Confirm stays
    // gated behind an explicit acknowledgement, same as missingLnNumbers.
    usedOcr: false,
    ocrAcknowledged: false,
    // 1-indexed page numbers that stayed unreadable even after OCR --
    // their text is left out of parsing entirely (see ciAnalyse) rather
    // than risk feeding garbage into a format's regex.
    ocrStillUnreadablePages: [],
    // Set when no known document layout matched at all and this document
    // was instead read via the last-resort greedy token matcher (see
    // parseGreedyTokenDocument below) -- same reasoning as usedOcr.
    lowConfidenceFallback: false,
    lowConfidenceAcknowledged: false,
  };

  // --- OCR fallback (scanned pages / no usable text layer) -----------------
  //
  // pdf.js's text layer is empty for a genuinely scanned page, and -- verified
  // against a real supplier PDF -- comes back as meaningless glyph IDs
  // ("(cid:N)" tokens under pdfplumber; pdf.js has no more information to
  // recover the real characters from either) for a document whose font
  // carries no ToUnicode mapping. Neither case is "hard to parse" -- there is
  // no correct text to extract, only an image to read -- so both fall back to
  // rendering each page as a bitmap and reading it with OCR instead. This
  // never overrides a working text layer; see textLayerLooksUsable() below.
  const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  let tesseractLibPromise = null;
  function loadTesseractLib() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLibPromise) return tesseractLibPromise;
    tesseractLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_SRC;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the OCR library from CDN."));
      document.head.appendChild(s);
    // A failed CDN load (a transient network blip, an ad blocker) must not
    // permanently disable OCR for the rest of the session -- clearing the
    // cached promise on rejection lets the next attempt actually retry
    // instead of replaying the same failure forever.
    }).catch((err) => { tesseractLibPromise = null; throw err; });
    return tesseractLibPromise;
  }

  // A usable text layer has real words in it, not just a handful of stray
  // characters -- fewer than 20 non-space characters is treated the same as
  // "no text at all" (a mostly-blank scanned page can still carry a faint
  // header/footer). Fewer than 3 recognisable 3+ letter words despite that
  // much text is the signature of the missing-ToUnicode case: plenty of
  // "characters" come out, but none of them spell anything, because they
  // were never mapped to real letters to begin with.
  //
  // A missing character mapping doesn't always come back as unprintable
  // junk, though -- verified against a real supplier PDF that a text
  // extractor can instead fall back to a literal "(cid:123)" placeholder
  // per glyph, which is ordinary printable ASCII and reads as plenty of
  // "words" (CID_TOKEN_RE) to the checks above. A document made of more
  // than a handful of these is checked for explicitly, on top of the
  // ratio/word checks, since it would otherwise pass them by accident.
  const CID_TOKEN_RE = /\(cid:\d+\)/g;
  function textLayerLooksUsable(text) {
    const dense = (text || "").replace(/\s+/g, "");
    if (dense.length < 20) return false;
    if ((text.match(CID_TOKEN_RE) || []).length > 5) return false;
    const words = (text || "").match(/[A-Za-z]{3,}/g) || [];
    if (words.length < 3) return false;
    const printable = dense.replace(/[^\x20-\x7E]/g, "").length;
    return printable / dense.length > 0.6;
  }

  // Renders every page to a bitmap via pdf.js (already loaded for the normal
  // text path) and reads each one with Tesseract.js. Far slower than the
  // text layer -- only ever tried after that path has already failed -- and,
  // unlike the text layer, can misread a character rather than simply fail
  // to find one, which is why the caller surfaces this to the user as
  // something to double-check, never as a plain, silent success.
  // OCRs just the given 1-indexed page numbers (default: every page) and
  // returns a Map<pageNumber, text> -- the caller decides per page whether
  // the text layer was usable (see textLayerLooksUsable), so only the pages
  // that actually need it pay OCR's cost, and a page with a good text layer
  // is never re-read as a lossier image for no reason.
  async function ocrPdfPages(file, onProgress, pageNumbers) {
    await Promise.all([loadLibs(), loadTesseractLib()]);
    const buf = await file.arrayBuffer();
    const pdf = await window.__pdfjs.getDocument({ data: buf }).promise;
    const targets = pageNumbers && pageNumbers.length
      ? pageNumbers
      : Array.from({ length: pdf.numPages }, (_, k) => k + 1);
    const worker = await Tesseract.createWorker("eng");
    try {
      const results = new Map();
      let done = 0;
      for (const i of targets) {
        done++;
        if (onProgress) onProgress(done, targets.length, i);
        const page = await pdf.getPage(i);
        // 2x scale -- pdf.js's default viewport is 72dpi equivalent, well
        // below what OCR needs; this brings it to roughly 144dpi. Not
        // independently verified against a real scanned document (no
        // browser in this environment) -- if OCR accuracy on small codes/
        // decimals turns out to be poor in practice, raise this before
        // reworking anything else.
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const { data } = await worker.recognize(canvas);
        results.set(i, data.text);
      }
      return results;
    } finally {
      // Swallowed deliberately -- a termination failure here must never
      // mask a real error from the recognition loop above (or silently
      // replace a clean return with an unhandled rejection).
      await worker.terminate().catch((termErr) => console.error("OCR worker termination failed:", termErr));
    }
  }

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

  // --- Landed Cost: shipping/freight/packing detection --------------------
  //
  // Only ever a convenience prefill for the editable Shipping / Freight /
  // Packing field in the Check-in preview -- never applied silently. A
  // genuine charge label ("Freight", "Shipping Cost", "Delivery Charge",
  // "Additional Packing Charges"...) paired with a money amount on the same
  // line, or on the very next line when the label stands completely alone.
  // Tax/VAT/GST/discount/subtotal/grand-total lines are excluded outright,
  // and a line that merely mentions one of these words as part of a wider
  // column-header row (e.g. Freedom Screens Australia's boilerplate "Tax Rat
  // Price Freight" header, which never carries a value of its own) is
  // deliberately NOT treated as a standalone label -- only a short, bare
  // label line qualifies for the look-at-the-next-line fallback, so a header
  // row can never be mistaken for a charge and pull in an unrelated total
  // sitting below it.
  //
  // Packing/crating charges were added on top of the original shipping/
  // freight set after a real supplier document (Freedom Screens India, a
  // Proforma Invoice) turned out to bill "Additional Packing charges (in
  // crate)" as its own line -- the same kind of per-shipment fee as
  // freight, just labelled differently, and one this reader should split
  // across the shipment's items the same way.
  const SHIPPING_TERM_RE = /\b(shipping(?:\s*(?:&|and)\s*handling)?(?:\s+cost)?|freight(?:\s*(?:&|and)\s*insurance)?(?:\s+charge)?|delivery\s+charge|transport(?:ation)?|handling\s+charge|(?:additional\s+)?packing(?:\s*(?:&|and)\s*crating)?(?:\s+charges?|\s+fee)|crating(?:\s+charges?|\s+fee))\b/i;
  const NOT_SHIPPING_RE = /\b(tax|vat|gst|discount|sub\s*-?\s*total|grand\s*total)\b/i;
  // A genuine freight/shipping summary charge is a standalone label+amount
  // near the totals -- not a fully-structured priced row with its own
  // qty/unit/tax columns. A real supplier document had a "Shipping Crate"
  // *product* line (a packing crate sold as a line item, in the same
  // Qty/Unit/Price/Tax%/Total shape as every other item on the invoice) --
  // its own tax-rate token ("0% EXEMPT") is what distinguishes it from an
  // actual freight charge line, so a line carrying one is never a candidate.
  const ITEM_ROW_SHAPE_RE = /\d+(?:\.\d+)?\s*%/;
  const MONEY_TOKEN_RE = /([\d,]+\.\d{1,4})/;
  // A DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY date reads as a valid (wrong)
  // money token to MONEY_TOKEN_RE (e.g. "07.11.2025" contains "07.11") --
  // strip full date-shaped tokens out of a line before searching it for an
  // amount, so a document date sitting next to the word "Freight" (e.g. a
  // shipment-method line like "07.11.2025 SEA FREIGHT") is never misread as
  // a freight cost of 7.11.
  const DATE_TOKEN_RE = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/g;
  function stripDates(line) {
    return line.replace(DATE_TOKEN_RE, " ");
  }

  // The *last* money-shaped token on a line, not the first. A bare "label:
  // amount" line only ever has one, so this changes nothing for the
  // shipping/freight case this was originally built for -- but a genuine
  // priced table row (the Freedom Screens India "Additional Packing
  // charges" sample: SI No / Description / HSN / Qty / Rate / Amount, e.g.
  // "1 Additional Packing charges (in crate) 998540 1.00 59.00 No 59.00")
  // has several, and the Amount is always the rightmost one -- the first
  // would instead grab the Qty column ("1.00") as if that were the charge.
  function lastMoneyMatch(s) {
    const matches = [...s.matchAll(new RegExp(MONEY_TOKEN_RE, "g"))];
    return matches.length ? matches[matches.length - 1] : null;
  }

  function detectShippingCharge(text) {
    const rawLines = text.split("\n");
    const candidates = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line || !SHIPPING_TERM_RE.test(line) || NOT_SHIPPING_RE.test(line) || ITEM_ROW_SHAPE_RE.test(line)) continue;
      const onLine = lastMoneyMatch(stripDates(line));
      if (onLine) {
        const amt = parseFloat(onLine[1].replace(/,/g, ""));
        if (amt > 0) candidates.push({ label: line, amount: amt });
        continue;
      }
      // A bare label line (just the word itself, not a multi-column header)
      // -- look at the very next non-blank line for its value only.
      const isBareLabel = line.split(/\s+/).length <= 3 && /^[A-Za-z][A-Za-z\s&]*$/.test(line);
      if (!isBareLabel) continue;
      const next = (rawLines[i + 1] || "").trim();
      if (!next || NOT_SHIPPING_RE.test(next) || ITEM_ROW_SHAPE_RE.test(next)) continue;
      const nm = lastMoneyMatch(stripDates(next));
      if (nm) {
        const amt = parseFloat(nm[1].replace(/,/g, ""));
        if (amt > 0) candidates.push({ label: `${line} / ${next}`, amount: amt });
      }
    }
    const seen = new Set();
    const uniq = candidates.filter((c) => {
      const k = c.label + "|" + c.amount;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!uniq.length) {
      return { amount: null, note: "No shipping/freight/packing charge detected in this document.", needsReview: false };
    }
    const distinctAmounts = new Set(uniq.map((c) => c.amount));
    if (distinctAmounts.size > 1) {
      return {
        amount: null,
        needsReview: true,
        note: `Found ${uniq.length} possible shipping/freight/packing amounts (${uniq.map((c) => c.amount).join(", ")}) — couldn't tell which one is correct. Enter the confirmed amount manually, or leave blank if there's no such charge.`,
      };
    }
    return { amount: uniq[0].amount, needsReview: false, label: uniq[0].label.trim(), note: `Detected from "${uniq[0].label.trim()}" — review before confirming.` };
  }

  function genericMoney(n, code) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return `${code} ` + fmt(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Matches the numbered line-item rows of a Commercial Invoice table, e.g.
  // "6 230034 Each 200 0.58 0.00 116.00 392530" -> Ln, Part Number, Units,
  // Qty, Price, GST, Total, HS Code. Verified against the supplied sample
  // (Freedom Screens commercial invoice format).
  // Unit is normally present ("Each", "Sheet", "200m"...) but some suppliers
  // leave it genuinely blank on certain rows (e.g. a miscellaneous item with
  // no standard unit) -- the source document itself has one fewer token on
  // that row, not a text-extraction glitch. Making the Unit group optional,
  // distinguished from Qty by requiring a letter (Qty is always pure
  // digits), means a blank-Unit row still matches instead of the whole line
  // silently failing to parse. Real invoices with this exact gap (blank
  // Units column on an otherwise normal row) surfaced this.
  const CI_LINE_RE = /^(\d+)\s+([A-Za-z0-9-]+)\s+(?:(\S*[A-Za-z]\S*)\s+)?(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{5,8})$/;

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

  // The document's own title doesn't gate whether it can be read (per the
  // universal-reader requirement) -- but it's still useful, purely as
  // information shown back to the user, to say what kind of document this
  // looks like. First label found wins; an unrecognised title still reads
  // fine, it's just labelled generically.
  const DOC_TYPE_PATTERNS = [
    { type: "Commercial Invoice", re: /commercial\s+invoice/i },
    { type: "Pro-Forma Invoice", re: /pro-?forma\s+invoice/i },
    { type: "Tax Invoice", re: /tax\s+invoice/i },
    { type: "Supplier Invoice", re: /supplier\s+invoice/i },
    { type: "Delivery Note", re: /delivery\s+note/i },
    { type: "Purchase Order", re: /purchase\s+order/i },
    { type: "Quotation", re: /quotation/i },
    { type: "Quote", re: /\bquote\b/i },
    { type: "Invoice", re: /\binvoice\b/i },
  ];
  function detectDocumentType(text) {
    for (const p of DOC_TYPE_PATTERNS) if (p.re.test(text)) return p.type;
    return "Supplier document";
  }

  function parseCheckinHeader(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    // "Oryx" is always the recipient in these documents, never the supplier
    // -- excluding it stops the (usually earlier, on-page) "ORYX DOOR
    // SYSTEMS L.L.C" letterhead line from being picked up ahead of the
    // actual supplier's own name lower down the page. Email lines are
    // excluded too -- a salesperson's address (e.g.
    // "exports@freedomscreens.com") often contains the same keyword
    // ("screens") as the real company-name line and would otherwise win by
    // appearing first. Same reasoning for a bank-details line ("Bank Name:
    // SBI ... For Freedom Screens India LLP") -- it names the account
    // holder, not the letterhead, but shares the same keyword.
    const supplier = lines.find((l) => !/\boryx\b/i.test(l) && !/@/.test(l) && !/\bbank\b/i.test(l) && /pty ltd|llc|\bltd\b|co\.,?\s*ltd|inc\.?$|company|screens|trading|industries/i.test(l)) || "";
    // SQ- covers Quotes/Order Approvals (Quote Number), alongside the
    // existing Commercial Invoice / delivery note prefixes. Falls back to a
    // labelled document number ("Pro-Forma Invoice # \n S00055") for
    // suppliers whose own numbering doesn't use one of those prefixes --
    // the captured token must contain at least one digit so a plain label
    // word ("Date") is never mistaken for the number itself.
    // "FSI/25-26/Pi25" (Freedom Screens India's own PI numbering) is its own
    // fallback: their "PI NO" / "DATE" header sits on its own line with the
    // actual values on the next line, too far from the label for the
    // generic labelled-number pattern below to bridge safely -- but the
    // "FSI/" prefix itself is distinctive enough to match directly.
    const invoiceNumber = (text.match(/\b(?:SI|SO|SQ|INV|DN)-\d+\b/i) || [])[0]
      || (text.match(/\bFSI\/[^\s,;]+/i) || [])[0]
      || (text.match(/(?:pro-?forma\s+invoice|commercial\s+invoice|tax\s+invoice|supplier\s+invoice|invoice|quotation|quote|delivery\s+note)\s*#?\s*:?\s*\n?\s*([A-Za-z]{0,4}\d[A-Za-z0-9-]{0,19})\b/i) || [])[1]
      || "";
    // Strict "PO-1234" first (existing behaviour, unchanged), then a
    // labelled "Your Reference" value, then a looser "PO 1234"/"PO26-1139"
    // mention -- in that order, so a stricter/more-certain match always
    // wins over a broader guess.
    const poNumber = (text.match(/\bPO-[\w-]+\b/i) || [])[0]
      || ((text.match(/your\s+reference\s*\n?\s*([^\n]{2,40})/i) || [])[1] || "").trim()
      || (text.match(/\bPO[\s-][A-Za-z0-9-]{2,20}\b/i) || [])[0]
      || "";
    // Prefer a date sitting right next to an explicit "Issued/Invoice/
    // Document Date" label; fall back to the first date-shaped token found
    // anywhere. Accepts either "/" or "-" as the separator -- both appear
    // across real supplier documents (17/02/2026 vs 25-02-2026) -- while
    // still assuming DD-MM-YYYY field order throughout, consistent with
    // every document seen so far.
    const dm = text.match(/(?:issued|invoice|document)\s+date\s*\n?\s*(\d{2})[\/-](\d{2})[\/-](\d{4})/i)
      || text.match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/);
    const isoDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : "";
    const docType = detectDocumentType(text);
    return { supplier, invoiceNumber, poNumber, isoDate, docType };
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
  // A genuine product description always has at least one letter in it --
  // this lookahead (zero-width, doesn't change capture-group numbering)
  // stops these loose "numbers ... description ... numbers" patterns from
  // matching unrelated all-digit boilerplate elsewhere in a document (an
  // ABN/registration number, a bank account number). Found via a real
  // supplier document whose "ABN 27 093 847 388" line satisfied every other
  // constraint in the Order Approval pattern and was wrongly read as a line
  // item ("093" as the description) before this was added.
  const QUOTE_DESC_RE = "(?=.*[A-Za-z]).+?";

  const CHECKIN_FORMATS = [
    {
      // Existing Commercial Invoice reader. Always tried first, so a
      // well-formed row's behaviour never regresses. m[3] (Unit) can be
      // undefined when the source row has a genuinely blank Units field.
      id: "commercial-invoice",
      label: "Commercial Invoice",
      lineRe: CI_LINE_RE,
      extract: (m) => ({ ln: parseInt(m[1], 10), code: m[2], unit: m[3] || "", qty: parseInt(m[4], 10), unitCost: parseFloat(m[5].replace(/,/g, "")) }),
    },
    {
      // "Total | Discounted Price | Discount % | Price | Qty | Description | Code | Ln"
      // e.g. "306.50 6.13 0% 6.13 50 ZLS1 End Cap 60 A WHT 3300 1"
      id: "quote-discount",
      label: "Quote (with Discount %)",
      // The leading Total and Discounted-Price amounts are display-only
      // (never captured) but still have to match -- a supplier that drops a
      // trailing zero ("1,805.0" instead of "1,805.00") must not fail the
      // whole row just because these two unused fields expect exactly 2
      // decimals.
      lineRe: new RegExp(`^[\\d,]+\\.\\d{1,2}\\s+[\\d,]+\\.\\d{1,2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{1,2})\\s+(\\d{1,6}(?:\\.\\d+)?)\\s+(${QUOTE_DESC_RE})\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unitCost: parseFloat(m[1].replace(/,/g, "")), qty: parseFloat(m[2]), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
      // A wrapped description pushes the code/line number onto a later
      // physical line -- this matches just the numeric prefix, so the row
      // can still be recovered by stitching it to the terminal code/line
      // that follows (see stitchWrappedRows below), instead of being lost.
      orphanRe: new RegExp(`^([\\d,]+\\.\\d{1,2})\\s+[\\d,]+\\.\\d{1,2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{1,2})\\s+(\\d{1,6}(?:\\.\\d+)?)$`),
      orphanExtract: (m) => ({ unitCost: parseFloat(m[2].replace(/,/g, "")), qty: parseFloat(m[3]) }),
    },
    {
      // "Total | Tax % | Price | Qty | Description | Code | Ln"
      // e.g. "116.00 0% 0.58 200 SMB1 Slide Lock WHT 230034 1"
      id: "quote-tax",
      label: "Quote (with Tax %)",
      lineRe: new RegExp(`^[\\d,]+\\.\\d{1,2}\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{1,2})\\s+(\\d{1,6}(?:\\.\\d+)?)\\s+(${QUOTE_DESC_RE})\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unitCost: parseFloat(m[1].replace(/,/g, "")), qty: parseFloat(m[2]), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
      orphanRe: new RegExp(`^([\\d,]+\\.\\d{1,2})\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{1,2})\\s+(\\d{1,6}(?:\\.\\d+)?)$`),
      orphanExtract: (m) => ({ unitCost: parseFloat(m[2].replace(/,/g, "")), qty: parseFloat(m[3]) }),
    },
    {
      // "Ln | Code | Description | Qty | Price | Tax % | Total" -- forward
      // (left-to-right) column order, the OPPOSITE of "quote-tax" above.
      // Seen specifically on Freedom Screens Australia's own Quote template
      // when it has to be read via OCR: this template's PDF has a broken
      // internal font/character mapping (a real document, "Quote_SQ-
      // 00000268", visually normal but every character in its native text
      // layer decodes to a garbled control character) -- but OCR reads the
      // rendered page in true left-to-right visual order, which turns out
      // to be the reverse of what quote-tax's own native-text-layer
      // extraction produces for the same supplier's other documents. e.g.
      // "1 910002 Patio Mesh 2.7m PH 15.00 493.99 0% 7,409.85".
      id: "quote-forward-tax",
      label: "Quote, forward column order (OCR)",
      lineRe: new RegExp(`^(${QUOTE_LN_RE})\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_DESC_RE})\\s+(\\d{1,6}(?:\\.\\d+)?)\\s+([\\d,]+\\.\\d{1,2})\\s+\\d+(?:\\.\\d+)?%\\s+([\\d,]+\\.\\d{1,2})$`),
      extract: (m) => ({ ln: parseInt(m[1], 10), code: m[2], description: m[3].trim(), qty: parseFloat(m[4]), unitCost: parseFloat(m[5].replace(/,/g, "")) }),
    },
    {
      // "Units | Qty | Description | Code | Ln" -- no pricing at all (e.g. a
      // signed Order Approval). unitCost is left undefined; the preview
      // shows "—" for cost/value on these rows rather than a fabricated 0.
      id: "order-approval",
      label: "Order Approval (no pricing)",
      lineRe: new RegExp(`^(\\S+)\\s+(\\d{1,6}(?:\\.\\d+)?)\\s+(${QUOTE_DESC_RE})\\s+(${QUOTE_CODE_RE})\\s+(${QUOTE_LN_RE})$`),
      extract: (m) => ({ unit: m[1], qty: parseFloat(m[2]), description: m[3].trim(), code: m[4], ln: parseInt(m[5], 10) }),
    },
    {
      // "Sl No | Particulars | Qty | Rate | Amount" -- forward (left-to-right)
      // column order, seen on Freedom Screens India's own Proforma Invoice
      // template, e.g. "1 ZLS1-Infinity 60mm-IS( 2.9m)Mill 25 11.50 287.50".
      // No item code column at all -- every row comes through with code=""
      // so it reaches the Preview needing a manual Master Inventory pick,
      // exactly as rule 10 requires when there's no code to match by. Sl No
      // is deliberately NOT read as `ln` for gap-detection: real documents
      // of this kind have genuine unexplained gaps in their own numbering
      // (e.g. row 13 simply absent), which is not the same thing as this
      // reader failing to parse a row.
      id: "sl-no-table",
      label: "Sl No / Particulars table (no item code)",
      lineRe: new RegExp(`^(\\d{1,3})\\s+(${QUOTE_DESC_RE})\\s+(\\d+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+\\.\\d{1,2})\\s*$`),
      extract: (m) => ({ code: "", description: m[2].trim(), qty: parseFloat(m[3]), unitCost: parseFloat(m[4].replace(/,/g, "")) }),
    },
    {
      // Same Freedom Screens India template, with two extra columns
      // inserted between Particulars and Qty -- Cut Length (metres) and an
      // HSN/HS code -- for extrusion items sold by cut length, e.g.
      // "1 ZLS1-Track-01(3.682kgs) 5.1 76101000 200 38.000 7600.000". HSN is
      // required to be 6-8 digits (a real HS/HSN code) so this format can't
      // be confused with the plainer 5-field "sl-no-table" above.
      id: "sl-no-table-cutlength",
      label: "Sl No / Particulars table with cut length + HSN (no item code)",
      lineRe: new RegExp(`^(\\d{1,3})\\s+(${QUOTE_DESC_RE})\\s+\\d+(?:\\.\\d+)?\\s+\\d{6,8}\\s+(\\d+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+\\.\\d{1,3})\\s*$`),
      extract: (m) => ({ code: "", description: m[2].trim(), qty: parseFloat(m[3]), unitCost: parseFloat(m[4].replace(/,/g, "")) }),
    },
    {
      // ORYX's own "Zipline/Components Order Form" template (a single fixed
      // form, not a repeating table -- these documents carry exactly one
      // filled-in item row). Its labelled boxes (Description, Unit of
      // Measure, Material, Price, Qty, Sub Total, Comments) all sit on the
      // same text baseline as the Code, so pdf.js's y-grouping reads them as
      // one squashed line, e.g.
      // "910005R  Pet Mesh 3m wide  3m x 30m Roll  Plastic  902.50  2  1,805.00  1,805.00  Airfreight"
      // or, when the form has no Material column filled in,
      // "30001R  Bug Fur 12mm (100m Roll)  100m  285.67  3  857.01". The
      // description/unit/material text in between Code and Price is read as
      // one combined description rather than split into separate fields --
      // there's no reliable delimiter between them -- and the Sub Total may
      // repeat once (a duplicate Sub Total box) followed by an optional
      // one-word shipping comment; both are optional so either layout matches.
      id: "single-item-order-form",
      label: "Single-item order form (Code / Description / Price / Qty / Sub Total)",
      lineRe: new RegExp(`^(\\d{3,7}[A-Z]?)\\s+(${QUOTE_DESC_RE})\\s+([\\d,]+\\.\\d{1,2})\\s+(\\d{1,6}(?:\\.\\d+)?)\\s+(?:[\\d,]+\\s+)?[\\d,]+\\.\\d{1,2}(?:\\s+(?:[\\d,]+\\s+)?[\\d,]+\\.\\d{1,2})?(?:\\s+[A-Za-z]+)?\\s*$`),
      extract: (m) => ({ code: m[1], description: m[2].trim(), unitCost: parseFloat(m[3].replace(/,/g, "")), qty: parseFloat(m[4]) }),
    },
  ];

  // Freedom Retractable Screens approval/order tables. These supplier PDFs
  // render several product sections with similar right-hand quantity columns:
  // "<code> <description...> USD <unit price> <section qty...> USD <line total>".
  // The PDF text layer sometimes splits large numbers across tokens
  // ("9 85.74", "2 ,957.22"), so this parser reads only the fields needed
  // for stock: code, description, unit price and the final quantity before
  // the line-total currency. It deliberately ignores subtotal/total rows.
  function parseFreedomApprovalOrder(text) {
    const entries = [];
    const moneyToken = /^[\d,]+(?:\.\d+)?$/;
    const codeRe = /^\d{5,6}R?$/i;

    function num(token) {
      const n = parseFloat(String(token || "").replace(/,/g, ""));
      return isFinite(n) ? n : null;
    }

    function priceFrom(tokens) {
      if (!tokens.length) return null;
      if (/^\d{1,3}$/.test(tokens[0] || "") && /^\d{1,3}\.\d{1,2}$/.test(tokens[1] || "")) {
        return num(tokens[0] + tokens[1]);
      }
      return num(tokens[0]);
    }

    for (const raw of text.split("\n")) {
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length || !codeRe.test(tokens[0])) continue;

      const firstUsd = tokens.findIndex((t, i) => i > 0 && /^USD$/i.test(t));
      if (firstUsd < 2) continue;
      const secondUsd = tokens.findIndex((t, i) => i > firstUsd && /^USD$/i.test(t));
      if (secondUsd === -1) continue;

      const mid = tokens.slice(firstUsd + 1, secondUsd).filter((t) => moneyToken.test(t));
      if (mid.length < 2) continue;
      const unitCost = priceFrom(mid);
      const qty = num(mid[mid.length - 1]);
      if (!(unitCost > 0) || !(qty > 0)) continue;

      entries.push({
        code: tokens[0],
        description: tokens.slice(1, firstUsd).join(" ").replace(/\s+/g, " ").trim(),
        qty,
        unitCost,
      });
    }
    return entries;
  }

  // --- General "line-item block" layout -----------------------------------
  // Some suppliers' PDF export tools (seen in Freedom Screens' Pro-Forma
  // Invoice / Quotation templates) group each row's own text by its Y
  // position on the page rather than emitting one row per physical text
  // line, producing a repeating block like:
  //   [190022] ASSEM Spring S35 SWP 1600mm (Left
  //   Black)
  //   METAL - HS CODE: 732090
  //   50.00  Units  USD  20.60  0% EXEMPT  USD  1,030.00
  // -- code+description on their own line(s), an optional material/HS-code
  // line, then the whole numeric run (qty, unit, price, optional tax,
  // amount) together on one line. Some rows compress further, with the
  // code+description AND the numeric run sharing one line
  // ("[230027] SMB1 Sill Cap BLK  75.00  Units  USD  1.62  ..."), and some
  // items carry no code at all ("Shipping Crate  1.00  Units  ..."). None of
  // the single-line CHECKIN_FORMATS regexes above can match any of this (no
  // fixed column order or position), so this is a structurally different
  // reading strategy, tried alongside the others in parseCheckinDocument --
  // not a per-document special case. Item code is optional by design: a
  // no-code row still comes through with code="" so it reaches the Preview
  // as unmatched/needs-review rather than disappearing.
  const BLOCK_CODE_DESC_RE = /^\[([A-Za-z0-9][A-Za-z0-9-]{1,19})\]\s*(.*)$/;
  const BLOCK_HS_LINE_RE = /\bHS\s*CODE\b/i;
  const BLOCK_UNIT_WORD = "(?:units?|pcs?|pieces?|each|box(?:es)?|set|sheets?|rolls?|meters?|metres?|kgs?|ltrs?|litres?)";
  const BLOCK_CUR = SUPPORTED_CURRENCIES.join("|");
  const BLOCK_TAX = "(?:\\d+(?:\\.\\d+)?%\\s*(?:exempt|vat|gst|tax)?|vat\\s*\\d+(?:\\.\\d+)?%|gst\\s*\\d+(?:\\.\\d+)?%|exempt|n\\/a)";
  // Captures: 1=qty 2=unit(optional) 3=currency-before-price(optional)
  // 4=price 5=currency-before-amount 6=amount. Not anchored at the start,
  // only at the end ($) -- so it matches wherever this numeric run appears
  // on the line, leaving anything before it (a code+description prefix, or
  // nothing at all) as the description. The currency right before Price is
  // optional -- some suppliers state it there twice (once per money value,
  // "USD 20.60 ... USD 1,030.00"), others only once, right before Amount
  // ("20.600000 ... USD 1,030.00") -- and Price's own decimal precision is
  // left open (some of the same documents print 6 decimal places on unit
  // price, e.g. "2.480000", not the usual 2) since it's read verbatim
  // either way, never rounded or reformatted by this reader.
  const BLOCK_ANCHOR_RE = new RegExp(
    `([\\d,]+(?:\\.\\d+)?)\\s+(${BLOCK_UNIT_WORD})?\\s*(?:(${BLOCK_CUR})\\s+)?([\\d,]+\\.\\d+)\\s*(?:${BLOCK_TAX}\\s*)?(${BLOCK_CUR})\\s+([\\d,]+\\.\\d{1,2})\\s*$`,
    "i"
  );
  // A qty (+ optional unit), and nothing else on the line -- the only shape
  // a priceless Delivery Note row can take here. Only ever tried once an
  // actual `[CODE]` bracket has just been seen for this item (see
  // parseBlockDocument) -- not merely "some description text was seen" --
  // so an unrelated document full of bare numbers (e.g. a drawing's
  // dimensions) can never be misread as a wall of priceless line items.
  const BLOCK_QTY_ONLY_RE = new RegExp(`^([\\d,]+(?:\\.\\d+)?)\\s*(${BLOCK_UNIT_WORD})?\\s*$`, "i");
  // Page/letterhead furniture -- never treated as a code, an anchor, or
  // meaningful description text, regardless of where it happens to fall.
  const BLOCK_SKIP_LINE_RE = /^(tax id|swift|bic|account number|recipient|intermediary|international payments|untaxed amount|grand total|amount due|balance due|vat\s*\d|^total$|^subtotal$|freedom screens|head office|subdistrict|province|thailand$|oryx door systems|wh no\.|industrial area|united arab emirates|gst id|dubai du|page\s|revolut)/i;

  function parseBlockDocument(text) {
    const rawLines = text.split("\n");
    const entries = [];
    let pendingCode = "";
    let pendingDesc = [];
    for (const raw of rawLines) {
      const line = raw.trim();
      if (!line || BLOCK_SKIP_LINE_RE.test(line) || BLOCK_HS_LINE_RE.test(line)) continue;

      const anchorMatch = line.match(BLOCK_ANCHOR_RE);
      if (anchorMatch) {
        const prefix = line.slice(0, anchorMatch.index).trim();
        let code = pendingCode;
        let descParts = pendingDesc;
        if (prefix) {
          const codeMatch = prefix.match(BLOCK_CODE_DESC_RE);
          if (codeMatch) { code = codeMatch[1]; descParts = codeMatch[2] ? [codeMatch[2]] : []; }
          else descParts = [...descParts, prefix];
        }
        entries.push({
          code,
          description: descParts.join(" ").replace(/\s+/g, " ").trim(),
          unit: anchorMatch[2] || "",
          qty: parseFloat(anchorMatch[1].replace(/,/g, "")),
          unitCost: parseFloat(anchorMatch[4].replace(/,/g, "")),
        });
        pendingCode = "";
        pendingDesc = [];
        continue;
      }

      const codeMatch = line.match(BLOCK_CODE_DESC_RE);
      if (codeMatch) {
        pendingCode = codeMatch[1];
        pendingDesc = codeMatch[2] ? [codeMatch[2]] : [];
        continue;
      }

      // Gated on an actual `[CODE]` bracket having just been seen -- not
      // merely "some description text" -- otherwise any ordinary document
      // full of bare numbers (a drawing's dimensions, a spec sheet's
      // measurements) would be misread as a wall of priceless line items.
      // A real Delivery Note row without pricing still satisfies this,
      // since it has its own item code.
      const qtyOnly = pendingCode && line.match(BLOCK_QTY_ONLY_RE);
      if (qtyOnly) {
        entries.push({
          code: pendingCode,
          description: pendingDesc.join(" ").replace(/\s+/g, " ").trim(),
          unit: qtyOnly[2] || "",
          qty: parseFloat(qtyOnly[1].replace(/,/g, "")),
          unitCost: null,
        });
        pendingCode = "";
        pendingDesc = [];
        continue;
      }

      // Ordinary text -- either a continuation of the current item's
      // description (this is how a wrapped line, e.g. "(Left" / "Black)",
      // gets stitched back into one string) or otherwise-harmless filler
      // that gets discarded the moment the next real item/code resets it.
      if (line.length <= 90) pendingDesc.push(line);
    }
    return entries;
  }

  // --- Last-resort "greedy token" reader ------------------------------
  //
  // Tried only when every fixed-layout format above AND parseBlockDocument
  // both find nothing at all -- a genuinely last-resort, wider-net pass for
  // a document whose row data is scattered across more physical lines than
  // parseBlockDocument's own state machine expects: a long description that
  // wraps *around* the numeric run instead of only before it, or a single
  // field (e.g. a discount percentage) landing on its own line because the
  // PDF's layout engine wrapped it away from the rest of its row -- both
  // seen on real supplier Quotes. It reuses the same anchor/code/skip
  // patterns as parseBlockDocument, just tolerant of the numeric run being
  // split across up to GREEDY_MERGE_WINDOW physical lines, and of one short
  // fragment line immediately after it still belonging to the description.
  //
  // Every entry this produces is tagged lowConfidence: true -- the caller
  // must surface that plainly and require the user to check the document by
  // hand (same as the missing-line-number gap check above), because a wider
  // net is also more likely to glue two unrelated fragments together.
  const GREEDY_MERGE_WINDOW = 3;

  function parseGreedyTokenDocument(text) {
    const rawLines = text.split("\n").map((l) => l.trim());
    const entries = [];
    let pendingCode = "";
    let pendingDesc = [];
    const consumed = new Set();

    for (let i = 0; i < rawLines.length; i++) {
      if (consumed.has(i)) continue;
      const line = rawLines[i];
      if (!line || BLOCK_SKIP_LINE_RE.test(line) || BLOCK_HS_LINE_RE.test(line)) continue;

      // Try the anchor on this line alone, then merged with up to
      // GREEDY_MERGE_WINDOW physical lines in total -- a merge only ever
      // pulls in lines that didn't match anything else on their own.
      // Letterhead/boilerplate lines (BLOCK_SKIP_LINE_RE/BLOCK_HS_LINE_RE)
      // are dropped from the merge candidate itself, not just skipped when
      // encountered on their own -- otherwise a stray "HS CODE: ..." line
      // sitting inside the window would get glued into the description
      // instead of being ignored, same as parseBlockDocument's own
      // line-by-line skip already ensures. Growing the window stops dead
      // the moment a *later* line itself opens a new `[CODE]` block --
      // without this, a merge could reach past an unrelated/incomplete
      // item straight into the next item's own numeric row, fabricating a
      // record that mixes one item's code with another's quantity/price
      // (confirmed with a real repro during review: an unclosed "[A100]
      // ..." item followed by "[B200] ... <numbers>" produced a single
      // fake A100/B200 hybrid row instead of correctly leaving A100
      // unrecovered and reading B200 on its own).
      let anchorMatch = null, mergedThrough = i, mergedLine = line;
      {
        const collected = [];
        for (let end = i; end < Math.min(i + GREEDY_MERGE_WINDOW, rawLines.length); end++) {
          const l = rawLines[end];
          if (end > i && BLOCK_CODE_DESC_RE.test(l)) break;
          if (l && !BLOCK_SKIP_LINE_RE.test(l) && !BLOCK_HS_LINE_RE.test(l)) collected.push(l);
          const merged = collected.join(" ");
          const m = merged.match(BLOCK_ANCHOR_RE);
          if (m) { anchorMatch = m; mergedThrough = end; mergedLine = merged; break; }
        }
      }

      if (anchorMatch) {
        const prefix = mergedLine.slice(0, anchorMatch.index).trim();
        let code = pendingCode;
        let descParts = pendingDesc;
        if (prefix) {
          const codeMatch = prefix.match(BLOCK_CODE_DESC_RE);
          // A bracketed code found inside the merge prefix unambiguously
          // starts a new item -- any pendingCode/pendingDesc carried over
          // from stray text before it (page preamble, or a previous
          // incomplete block that never found its own numeric row) belongs
          // to a different row, or no row at all, and must not leak into
          // this one (confirmed with a real repro: loose preamble text
          // before a "[CODE] ..." line was otherwise prepended to that
          // line's own description).
          if (codeMatch) { code = codeMatch[1]; descParts = codeMatch[2] ? [codeMatch[2]] : []; }
          else descParts = [...descParts, prefix];
        }
        // A short, bare continuation line immediately after the anchor (a
        // closing "Roll)" that wrapped past the numeric run) belongs to
        // this row's description -- but only a short, clearly-fragment
        // line qualifies, never a full sentence, another row's own
        // code/anchor line, or boilerplate.
        const after = rawLines[mergedThrough + 1] || "";
        let trailingConsumed = -1;
        if (after && after.length <= 40 && !BLOCK_CODE_DESC_RE.test(after) && !BLOCK_ANCHOR_RE.test(after)
            && !BLOCK_SKIP_LINE_RE.test(after) && !BLOCK_HS_LINE_RE.test(after)) {
          descParts = [...descParts, after];
          trailingConsumed = mergedThrough + 1;
        }

        entries.push({
          code,
          description: descParts.join(" ").replace(/\s+/g, " ").trim(),
          unit: anchorMatch[2] || "",
          qty: parseFloat(anchorMatch[1].replace(/,/g, "")),
          unitCost: parseFloat(anchorMatch[4].replace(/,/g, "")),
          lowConfidence: true,
        });
        for (let k = i; k <= mergedThrough; k++) consumed.add(k);
        if (trailingConsumed !== -1) consumed.add(trailingConsumed);
        pendingCode = "";
        pendingDesc = [];
        continue;
      }

      const codeMatch = line.match(BLOCK_CODE_DESC_RE);
      if (codeMatch) {
        pendingCode = codeMatch[1];
        pendingDesc = codeMatch[2] ? [codeMatch[2]] : [];
        continue;
      }

      const qtyOnly = pendingCode && line.match(BLOCK_QTY_ONLY_RE);
      if (qtyOnly) {
        entries.push({
          code: pendingCode,
          description: pendingDesc.join(" ").replace(/\s+/g, " ").trim(),
          unit: qtyOnly[2] || "",
          qty: parseFloat(qtyOnly[1].replace(/,/g, "")),
          unitCost: null,
          lowConfidence: true,
        });
        pendingCode = "";
        pendingDesc = [];
        continue;
      }

      if (line.length <= 90) pendingDesc.push(line);
    }
    return entries;
  }

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

  // The "single-item-order-form" format above assumes Description, Unit of
  // Measure, Material, Price, Qty and Sub Total all land on the same
  // physical line as the Code -- true on some real ORYX order forms, but a
  // real one (INTERNATIONAL COMPONENT ZIPLINE ORDER FORM, Pet Mesh 3m) was
  // found to split its own Unit of Measure text across three separate
  // lines ("3m x" / "30m" / "Roll") instead, so the single-line match never
  // fires at all. This has no orphanRe of its own (stitchWrappedRows above
  // only recovers rows via a numeric-only opening line before a terminal
  // "<code> <ln>" pair, which doesn't fit this format's shape), so it's
  // joined here instead: starting from any code-shaped opening line, add
  // one physical line at a time and re-test the format's own lineRe after
  // each addition, stopping at the FIRST match -- never growing the join
  // past the fewest lines needed, so trailing unrelated page content
  // (titles, dates, signatures) below the real row can never be absorbed
  // into it.
  function stitchSingleItemOrderFormRows(rawLines, format) {
    const startRe = /^\d{3,7}[A-Z]?\s+\S/;
    const rows = [];
    const usedIdx = new Set();
    for (let i = 0; i < rawLines.length; i++) {
      if (usedIdx.has(i)) continue;
      const first = rawLines[i].trim();
      if (!startRe.test(first)) continue;
      if (first.match(format.lineRe)) continue;
      let joined = first;
      for (let j = i + 1; j < Math.min(i + 9, rawLines.length); j++) {
        const next = rawLines[j].trim();
        if (!next) continue;
        joined += " " + next;
        const m = joined.match(format.lineRe);
        if (m) {
          rows.push(format.extract(m));
          for (let k = i; k <= j; k++) usedIdx.add(k);
          break;
        }
      }
    }
    return { rows, usedIdx };
  }

  // The existing gap check below only finds a HOLE below the highest parsed
  // line number -- it has no way to notice a row missing from the very end
  // of the document, because there's no later successfully-parsed row to
  // reveal the gap. That's exactly how a real invoice's last line (a blank
  // Units field breaking the fixed 8-token Commercial Invoice pattern) went
  // missing without any warning. This probes the raw text directly for
  // "the next sequential line number" wherever this format's own line
  // number normally sits (leading token for Commercial Invoice, trailing
  // token for the reverse-order Quote/Order Approval formats) -- if it's
  // there, a row structurally exists that this format's strict pattern
  // couldn't read, and it must be surfaced rather than silently dropped.
  // Bounded so a corrupt document can't spin this forever.
  function probeTrailingMissingLines(rawLines, format, maxLn) {
    const lnAtStart = format.id === "commercial-invoice";
    const missing = [];
    let n = maxLn + 1;
    while (missing.length < 50) {
      const re = lnAtStart ? new RegExp(`^${n}\\b`) : new RegExp(`\\b${n}$`);
      // A pagination footer ("Page 1 of 2") legitimately ends with a small
      // number that has nothing to do with a line item -- skip those lines
      // so "of 2" doesn't get mistaken for evidence of a missing Ln 2.
      const found = rawLines.some((raw) => {
        const l = raw.trim();
        return !/^page\s+\d+\s+of\s+\d+$/i.test(l) && re.test(l);
      });
      if (!found) break;
      missing.push(n);
      n++;
    }
    return missing;
  }

  // Freedom Screens India's "PROFORMA INVOICE Revised" template (seen on
  // FSI/24-25/Pi15R) wraps each Sl No table row across three separate
  // physical lines instead of one -- the Sl No alone, then the Particulars
  // text alone, then "Qty Rate Amount" alone, e.g.
  //   1
  //   SMB1 Track Retainer-01 (5.4m)
  //   60  8.0  480.0
  // rather than the single-line "1 <desc> 60 8.0 480.0" the sl-no-table
  // format expects. Rejoining that exact three-line shape back into one
  // line lets sl-no-table match it without a second parallel format to
  // maintain. A bare "Packing" charge line (no leading Sl No) is correctly
  // left untouched here -- it never matches this shape.
  function mergeWrappedSlNoRows(rawLines) {
    const lnOnlyRe = /^(\d{1,3})\s*$/;
    const numTripleRe = /^(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{1,3})\s*$/;
    const out = [];
    let i = 0;
    while (i < rawLines.length) {
      const m0 = rawLines[i].trim().match(lnOnlyRe);
      const l1 = (rawLines[i + 1] || "").trim();
      const l2 = (rawLines[i + 2] || "").trim();
      if (m0 && l1 && /[A-Za-z]/.test(l1) && !numTripleRe.test(l1)) {
        const m2 = l2.match(numTripleRe);
        if (m2) {
          out.push(`${m0[1]} ${l1} ${m2[1]} ${m2[2]} ${m2[3]}`);
          i += 3;
          continue;
        }
      }
      out.push(rawLines[i]);
      i++;
    }
    return out;
  }

  // Tries every known Check-in document layout and uses whichever produces
  // the most matched rows -- this is the "recognise the document's actual
  // structure" step. Zero rows across every format means the document isn't
  // one this reader recognises; the caller must not fabricate anything from
  // that and must show a clear message instead.
  function parseCheckinDocument(text) {
    const rawLines = mergeWrappedSlNoRows(text.split("\n"));
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
      if (format.id === "single-item-order-form") {
        const { rows: stitched } = stitchSingleItemOrderFormRows(rawLines, format);
        entries.push(...stitched);
      }
      if (entries.length > best.entries.length) best = { formatId: format.id, formatLabel: format.label, entries };
    }
    // The block layout (one field per line -- see parseBlockDocument above)
    // is structurally different from every regex-per-line format above, so
    // it's tried as its own candidate and only wins if it actually reads
    // more rows than every fixed-layout format did.
    const blockEntries = parseBlockDocument(text);
    if (blockEntries.length > best.entries.length) {
      best = { formatId: "block-lines", formatLabel: "Line-item blocks (one field per line)", entries: blockEntries };
    }
    const freedomApprovalEntries = parseFreedomApprovalOrder(text);
    if (freedomApprovalEntries.length > best.entries.length) {
      best = {
        formatId: "freedom-approval-order",
        formatLabel: "Freedom approval/order tables",
        entries: freedomApprovalEntries,
      };
    }
    // Absolute last resort: only tried when nothing above -- not even the
    // block-layout reader -- found a single row. Never allowed to outrank a
    // real structured match just by finding more raw entries, since it's
    // inherently more error-prone (see parseGreedyTokenDocument above).
    if (!best.entries.length) {
      const greedyEntries = parseGreedyTokenDocument(text);
      if (greedyEntries.length) {
        best = { formatId: "greedy-tokens", formatLabel: "Greedy token matching (low-confidence fallback)", entries: greedyEntries };
      }
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
      // Sanity check on the Ln numbers themselves: if nearly everything
      // between 1 and the highest Ln seen is "missing", that's a sign this
      // format matched one stray line with an unrelated large Ln (e.g. a
      // registration/account number elsewhere in the document) rather than
      // dozens of genuinely unparseable rows -- surfacing hundreds of fake
      // "missing line" numbers would bury real gap warnings in noise, so
      // this format's Ln sequence is treated as not trustworthy instead.
      if (missing.length > Math.max(50, best.entries.length * 5)) {
        best.missingLnNumbers = [];
      } else {
        // A hole below maxLn is caught above, but nothing above can ever
        // reveal a row missing from the very end of the document -- probe
        // the raw text directly for it (see probeTrailingMissingLines).
        const winningFormat = CHECKIN_FORMATS.find((f) => f.id === best.formatId);
        if (winningFormat) missing.push(...probeTrailingMissingLines(rawLines, winningFormat, maxLn));
        best.missingLnNumbers = missing;
      }
    } else {
      best.missingLnNumbers = [];
    }
    return best;
  }

  function buildCheckinRows(lines, descriptions, itemsByCode) {
    const rows = [];
    lines.forEach((l, i) => {
      const candidates = lookupExactCode(itemsByCode, l.code);
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
          lowConfidence: !!l.lowConfidence,
        });
        return;
      }
      // The exact item code exists -- check for a genuine pack-size claim
      // mismatch. Master Inventory's own unit_of_measure is a fixed
      // internal accounting unit ("pcs" on nearly every item, verified
      // against the live data) and was never meant to be compared word-
      // for-word against the invoice's presentational Unit text ("Each",
      // "Sheet", etc.) -- doing that flagged almost every ordinary row as
      // "different" and was wrong. The only place either side actually
      // states a pack size is a "<number>m" token: the invoice's Unit
      // field sometimes carries one ("300m"), and Master Inventory's own
      // description sometimes carries one in parentheses ("...(200m)").
      // Only flag when BOTH sides state one and they disagree -- this
      // can't misfire on the common case where neither side claims a
      // length at all.
      const invoiceLen = parseLengthToken(l.unit);
      const masterLen = parseBundleLengthM(item.description);
      if (invoiceLen != null && masterLen != null && invoiceLen !== masterLen) {
        rows.push({
          code: l.code, description: pdfDescription, unit: l.unit || "", qty: l.qty,
          invoiceUnitCost: l.unitCost,
          current: item.current_qty, newQty: null,
          status: "exact-diff", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          exactMatchItem: {
            id: item.id, code: item.item_code, description: item.description,
            unit: item.unit_of_measure || "",
            packSize: `${masterLen}m`, invoicePackSize: `${invoiceLen}m`,
            current_qty: item.current_qty,
          },
        });
        return;
      }
      // Roll/bundle auto-conversion. Master Inventory states this item's
      // own roll length in its description ("...(300m Roll)") and the
      // invoice does NOT restate that length itself -- meaning the
      // invoice's quantity number is a roll/bundle COUNT ("1", "4"), not a
      // metre count. Master Inventory already tracks stock and unit cost
      // for these items in metres (confirmed against real records: e.g.
      // 30003R's current_qty and unit_cost are both metre-based, not
      // roll-based), so the roll count is expanded to metres and the roll
      // price is divided down to a per-metre cost automatically -- the
      // same way every other matched row here checks in without a manual
      // review step. The roll count itself is kept (packageInfo.rollCount)
      // purely so the Qty column can still show "+1 (300 m)" instead of
      // the less readable "+300 m", and so the original per-roll price is
      // preserved for the audit trail at Confirm.
      if (masterLen != null && invoiceLen == null) {
        const rollCount = l.qty;
        const qtyMetres = rollCount * masterLen;
        const perMetreCost = l.unitCost != null ? l.unitCost / masterLen : null;
        const bundleType = /roll|coil|reel/i.test(item.description) ? "Roll" : "Length";
        rows.push({
          code: l.code, description: item.description || pdfDescription, unit: l.unit || "", qty: qtyMetres,
          invoiceUnitCost: perMetreCost,
          current: item.current_qty, newQty: item.current_qty + qtyMetres,
          status: "ok", action: "add", decided: true,
          itemId: item.id, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          packageInfo: { type: bundleType, qtyPerPackage: masterLen, unit: "m", rollCount, rollUnitCost: l.unitCost },
        });
        return;
      }
      // Bundled/packaged item check. The invoice's own quantity number
      // (e.g. "4") is a *package* count, not automatically the final
      // inventory quantity -- but Master Inventory's own unit_of_measure
      // is "pcs" (counting packages/rolls, not the contents) for every
      // item checked so far, so today's simple "add the invoice qty
      // as-is" is actually still correct. This only reclassifies the row
      // when the invoice's packaging claim and Master Inventory's own
      // description *disagree on what kind of package this even is*
      // (e.g. the invoice's Unit says "200m" but the item's own
      // description says "108 per sheet") -- that's a real inconsistency
      // in the source data, not something to silently pick a side on.
      // Package facts are recorded either way, purely for audit, and
      // never change the quantity/cost actually written.
      const invoicePkg = parsePackaging(`${l.unit || ""} ${pdfDescription || ""}`);
      const masterPkg = parsePackaging(item.description);
      if (invoicePkg && masterPkg && masterPkg.type !== invoicePkg.type) {
        rows.push({
          code: l.code, description: item.description || pdfDescription, unit: l.unit || "", qty: l.qty,
          invoiceUnitCost: l.unitCost,
          current: item.current_qty, newQty: null,
          status: "pack-review", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          packMismatch: {
            itemId: item.id, itemDescription: item.description, itemCurrentQty: item.current_qty,
            itemUnit: item.unit_of_measure || "",
            invoicePkg: { ...invoicePkg, sourceQty: l.qty }, masterPkg,
          },
        });
        return;
      }
      rows.push({
        code: l.code, description: item.description || pdfDescription, unit: l.unit || "", qty: l.qty,
        invoiceUnitCost: l.unitCost,
        current: item.current_qty, newQty: item.current_qty + l.qty,
        status: "ok", action: "add", decided: true,
        itemId: item.id, editing: false, truncatedHint: false,
        lowConfidence: !!l.lowConfidence,
        packageInfo: invoicePkg ? { type: invoicePkg.type, qtyPerPackage: invoicePkg.qtyPerPackage, unit: invoicePkg.unit } : null,
      });
    });
    return rows;
  }

  function recomputeCiRowAfterEdit(row, newCode, newDescription, newQty, newUnit) {
    // The typed qty is still the invoice's own number (e.g. "1" roll) --
    // captured before row.qty is overwritten below, so the roll/bundle
    // check further down still has the pre-edit invoice quantity to expand,
    // exactly like the initial-parse path in buildCheckinRows.
    const invoiceQty = newQty;
    row.code = newCode; row.description = newDescription; row.qty = newQty; row.unit = newUnit;
    // A manual edit means the human is now stating the final code/quantity
    // directly -- any auto-detected roll/bundle packaging from the original
    // parse no longer applies (it would still reference the pre-edit
    // item's roll length and count) and would misreport at Confirm and
    // misdivide shipping in ciLandedUnitCost() if left in place. Recomputed
    // fresh below if the newly-picked item turns out to be a roll/bundle
    // item too.
    row.packageInfo = null;
    const candidates = ciState.itemsByCode.get(newCode) || [];
    const item = pickInventoryRow({ kind: "checkin" }, candidates);
    if (!item) {
      row.current = null; row.newQty = null;
      row.status = "unmatched"; row.action = "pending"; row.decided = false;
      row.itemId = null;
      return;
    }
    // Most Edit corrections are exactly this: the invoice's own Code
    // column was wrong, incomplete, or (as with some suppliers' Quote
    // templates) simply never carried Oryx's full Master Inventory code at
    // all -- so this is often the FIRST point a roll/bundle item's real
    // Master Inventory record is known. Without this check, an item fixed
    // via Edit would silently skip the same auto-conversion a correctly-
    // coded row on the same document already gets, checking in "+1" (a
    // roll) instead of the roll's real length in metres.
    const bundleLenM = parseBundleLengthM(item.description);
    if (bundleLenM != null && parseLengthToken(newUnit) == null) {
      const rollCount = invoiceQty;
      const qtyMetres = rollCount * bundleLenM;
      const rollUnitCost = row.invoiceUnitCost; // original per-roll price, before conversion
      const perMetreCost = rollUnitCost != null ? rollUnitCost / bundleLenM : null;
      const bundleType = /roll|coil|reel/i.test(item.description) ? "Roll" : "Length";
      row.qty = qtyMetres;
      row.invoiceUnitCost = perMetreCost;
      row.current = item.current_qty;
      row.newQty = item.current_qty + qtyMetres;
      row.status = "ok"; row.action = "add"; row.decided = true;
      row.itemId = item.id;
      row.description = item.description || newDescription;
      row.packageInfo = { type: bundleType, qtyPerPackage: bundleLenM, unit: "m", rollCount, rollUnitCost };
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

  // Landed Cost: splits ciState.shippingAmountOriginal equally across every
  // *inventory line item* currently checking in (action "add" or
  // "create-new" -- exactly the same set ciTally() already counts; a
  // skipped, unmatched-pending, or otherwise undecided row is never counted
  // as a line item, per spec). Deliberately divides by the number of LINES,
  // not by total quantity -- a document with Qty 100 / Qty 2 / Qty 50 still
  // gets an even 3-way split. Recomputed fresh from the current row list on
  // every call (render, tally, confirm) rather than cached, so it always
  // reflects whatever the user has skipped/acknowledged so far.
  //
  // Cent-based integer arithmetic so the allocations always sum back to
  // exactly the original amount -- e.g. USD 100 / 3 lines never becomes
  // 33.33 + 33.33 + 33.33 = 99.99. Any leftover cent from the division goes
  // entirely to the last line item, per spec ("apply the difference to the
  // final valid inventory line").
  function ciShippingAllocation() {
    const alloc = new Map(); // row index -> allocated amount, original currency
    const total = ciState.shippingAmountOriginal;
    if (!ciState.rows || !(total > 0)) return alloc;
    const activeIdx = [];
    ciState.rows.forEach((r, i) => { if (r.action === "add" || r.action === "create-new") activeIdx.push(i); });
    if (!activeIdx.length) return alloc;
    const totalCents = Math.round(total * 100);
    const base = Math.floor(totalCents / activeIdx.length);
    const remainder = totalCents - base * activeIdx.length;
    activeIdx.forEach((rowIdx, pos) => {
      const cents = base + (pos === activeIdx.length - 1 ? remainder : 0);
      alloc.set(rowIdx, cents / 100);
    });
    return alloc;
  }

  // The landed unit cost for one row: its own invoice unit cost plus this
  // row's share of shipping. Left as null (never a fabricated number) when
  // the document itself gave no unit cost for this line (e.g. a no-pricing
  // Order Approval) -- the shipping allocation still exists and is still
  // shown, but it can't be added to an unknown base cost.
  //
  // A roll/bundle row (packageInfo.unit === "m") already carries a
  // PER-METRE unit cost, but shipAlloc is a flat dollar amount for the
  // whole line (split by line count, not quantity, per spec) -- adding it
  // straight to a per-metre cost would treat the whole shipping share as
  // if it applied to a single metre. It's spread across this row's own
  // metres (r.qty) first, so multiplying back out (qty × landed) still
  // reconstructs exactly the line's original cost plus its shipping share.
  function ciLandedUnitCost(rowIdx, shipAlloc) {
    const r = ciState.rows[rowIdx];
    if (r.invoiceUnitCost == null) return null;
    const shipForRow = shipAlloc.get(rowIdx) || 0;
    if (r.packageInfo && r.packageInfo.unit === "m" && r.packageInfo.rollCount != null && r.qty > 0) {
      return r.invoiceUnitCost + (shipForRow / r.qty);
    }
    return r.invoiceUnitCost + shipForRow;
  }

  function ciTally() {
    // A confirmed new-item row ("create-new") checks in and adds value just
    // like a matched row -- it counts alongside "add" in every total below.
    const shipAlloc = ciShippingAllocation();
    const rate = ciRate();
    let totalItems = 0;
    let totalValueOriginal = 0;
    ciState.rows.forEach((r, i) => {
      if (r.action !== "add" && r.action !== "create-new") return;
      totalItems++;
      // Falls back to the plain invoice unit cost when there's no shipping
      // to allocate (shipAlloc empty) -- identical to the pre-Landed-Cost
      // calculation, so a document with no shipping charge is completely
      // unaffected.
      const landed = ciLandedUnitCost(i, shipAlloc);
      totalValueOriginal += r.qty * (landed != null ? landed : (r.invoiceUnitCost || 0));
    });
    return {
      totalItems,
      totalValueOriginal,
      totalValueAed: rate ? totalValueOriginal * rate : null,
      unresolved: ciState.rows.filter((r) => !r.decided).length,
      skipped: ciState.rows.filter((r) => r.decided && r.action === "skip").length,
    };
  }

  // Finds existing Master Inventory items that might already be this "new"
  // item under a different code -- purely advisory (a soft warning the user
  // must acknowledge before creating a duplicate), never auto-selected and
  // never blocking on its own. Reuses the same substring-on-description idea
  // as the search dropdown (wireCodePicker), plus a shared-code-prefix check
  // for cases like a truncated code that still didn't resolve via Edit.
  function findSimilarMasterInventoryItems(row, itemsByCode) {
    const codePrefix = (row.code || "").slice(0, 4).toLowerCase();
    const words = (row.description || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const out = [];
    for (const [code, candidates] of itemsByCode) {
      const item = candidates[0];
      const desc = (item.description || "").toLowerCase();
      const codeMatch = codePrefix.length >= 4 && code.toLowerCase().startsWith(codePrefix);
      const wordMatch = words.some((w) => desc.includes(w));
      if (codeMatch || wordMatch) {
        out.push({ code, description: item.description || "" });
        if (out.length >= 5) break;
      }
    }
    return out;
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
    if (row.status === "new") {
      return `<div class="fp-row-actions">
        <button data-act="undo-new" data-i="${idx}">Undo</button>
        ${editBtn}
      </div>`;
    }
    if (row.status === "exact-diff") {
      // No "+ New item" here on purpose -- the code already exists, so
      // creating another record under it would just be rejected as a
      // duplicate at Confirm. The real choices are: accept the existing
      // record as-is, pick a different one manually, or skip the line.
      return `<div class="fp-row-actions">
        <button data-act="use-existing" data-i="${idx}" class="on">Use Existing Item</button>
        ${editBtn}
        <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Acknowledge</button>
      </div>`;
    }
    if (row.status === "pack-review") {
      // The actual "confirm quantity" control lives inline in the
      // Description cell (it needs an input, not just a button) --
      // these are just the fallbacks: manually pick a different item, or
      // skip the line entirely without checking it in.
      return `<div class="fp-row-actions">
        ${editBtn}
        <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Acknowledge</button>
      </div>`;
    }
    return `<div class="fp-row-actions">
      <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Acknowledge</button>
      ${editBtn}
      <button data-act="new-item" data-i="${idx}">+ New item</button>
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
    else if (act === "use-existing") {
      // Explicit human confirmation that the exact-code match is correct
      // despite the flagged difference. Resolves exactly like any other
      // matched row -- same quantity, same unit, no conversion applied --
      // the flag was informational, not something this action "fixes".
      const item = r.exactMatchItem;
      if (!item) return;
      r.itemId = item.id;
      r.description = item.description || r.description;
      r.current = item.current_qty;
      r.newQty = item.current_qty + r.qty;
      r.status = "ok"; r.action = "add"; r.decided = true;
      r.usedDespiteDifference = { code: item.code, masterPackSize: item.packSize, invoicePackSize: item.invoicePackSize };
    }
    else if (act === "confirm-pack") {
      // Human-confirmed quantity for a bundled item whose packaging claim
      // didn't match Master Inventory's own description closely enough to
      // resolve on its own. Whatever number is in the input becomes the
      // quantity checked in -- default is the safe, unconverted package
      // count, but the user can type the expanded total instead if they
      // know that's correct. Package facts are still recorded for audit.
      const qtyEl = document.getElementById(`ciPackQty${idx}`);
      const newQty = qtyEl ? parseFloat(qtyEl.value) : NaN;
      if (!isFinite(newQty) || newQty <= 0) {
        ciStatus("Enter a quantity greater than zero before confirming.", "err");
        return;
      }
      const m = r.packMismatch;
      if (!m) return;
      r.qty = newQty;
      r.itemId = m.itemId;
      r.description = m.itemDescription || r.description;
      r.current = m.itemCurrentQty;
      r.newQty = m.itemCurrentQty + newQty;
      r.status = "ok"; r.action = "add"; r.decided = true;
      // Only keep the "N Rolls × Xm" phrasing if the confirmed number is
      // still literally the package count the invoice stated -- once the
      // user types a different number (e.g. the expanded total), that
      // phrasing would misdescribe what the number actually means, so it
      // falls back to a plain quantity instead.
      const acceptedDefault = newQty === m.invoicePkg.sourceQty;
      r.packageInfo = acceptedDefault
        ? { type: m.invoicePkg.type, qtyPerPackage: m.invoicePkg.qtyPerPackage, unit: m.invoicePkg.unit }
        : null;
      // The invoice's original Unit text ("200m") described the package,
      // not this now-different confirmed quantity -- keep showing it only
      // when it's still accurate (the accepted-default case); otherwise
      // fall back to Master Inventory's own unit so the row doesn't imply
      // "3240 of 200m each".
      if (!acceptedDefault) r.unit = m.itemUnit;
    }
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
    else if (act === "new-item") { r.creatingNew = true; }
    else if (act === "cancel-new") { r.creatingNew = false; }
    else if (act === "undo-new") {
      // Back to an ordinary unmatched row -- nothing was ever written for
      // it (Confirm Check-in is still the only thing that writes), so this
      // is just clearing the decision, same as any other row reset.
      r.status = "unmatched"; r.action = "pending"; r.decided = false;
      r.current = null; r.newQty = null; r.newItemData = null;
    }
    else if (act === "save-new") {
      const descEl = document.getElementById(`ciNewDesc${idx}`);
      const catEl = document.getElementById(`ciNewCategory${idx}`);
      const unitEl = document.getElementById(`ciNewUnit${idx}`);
      const costEl = document.getElementById(`ciNewCost${idx}`);
      const bufferEl = document.getElementById(`ciNewBuffer${idx}`);
      const approverEl = document.getElementById(`ciNewApprover${idx}`);
      const ackEl = document.getElementById(`ciNewAck${idx}`);

      const description = descEl.value.trim();
      const category = catEl.value;
      const unit = unitEl.value.trim();
      const cost = parseFloat(costEl.value);
      const buffer = bufferEl.value.trim() ? parseFloat(bufferEl.value) : null;
      const approver = approverEl.value.trim();

      if (!description) { ciStatus("Enter a description before adding this item.", "err"); return; }
      if (!unit) { ciStatus("Enter a unit of measure before adding this item.", "err"); return; }
      if (!isFinite(cost) || cost <= 0) {
        ciStatus("Enter a unit cost greater than zero -- it's never guessed for a new item.", "err");
        return;
      }
      if (buffer != null && (!isFinite(buffer) || buffer < 0)) {
        ciStatus("Buffer level must be a positive number, or left blank.", "err");
        return;
      }
      if (!approver) { ciStatus("Enter the name of the person approving this new item.", "err"); return; }
      if (ackEl && !ackEl.checked) {
        ciStatus("Confirm none of the possible matches above are this item before adding it.", "err");
        return;
      }

      r.description = description;
      r.unit = unit;
      r.invoiceUnitCost = cost;
      r.current = null;
      r.newQty = r.qty;
      r.status = "new";
      r.action = "create-new";
      r.decided = true;
      r.creatingNew = false;
      r.newItemData = { code: r.code, description, category: category || null, unit, bufferLevel: buffer, approvedBy: approver };
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

  // Single source of truth for whether Confirm may actually run -- used both
  // to enable/disable the button in ciRender() and, defensively, inside
  // ciConfirm() itself. The button's disabled state alone isn't trustworthy:
  // a stale render, or a race with re-selecting a file mid-analysis, could
  // in principle leave it enabled when one of these conditions no longer
  // holds, and this is the actual gate on whether anything gets written to
  // Supabase, not just whether the button looked clickable.
  function ciCanConfirm() {
    if (!ciState.rows || !ciState.rows.length) return false;
    const t = ciTally();
    const rate = ciRate();
    return (
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !ciState.rows.some((r) => r.editing || r.creatingNew) &&
      (!ciState.missingLnNumbers.length || ciState.missingLnAcknowledged) &&
      (!ciState.usedOcr || ciState.ocrAcknowledged) &&
      (!ciState.lowConfidenceFallback || ciState.lowConfidenceAcknowledged) &&
      !!rate &&
      !!$("#ciSupplier").value.trim() &&
      !!$("#ciInvoiceNumber").value.trim()
    );
  }

  function ciRender() {
    const t = ciTally();
    const rate = ciRate();
    const unmatched = ciState.rows.filter((r) => !r.decided && r.status === "unmatched").length;
    const cur = ciState.currency;
    const shipAlloc = ciShippingAllocation();
    const shippingActiveCount = ciState.rows.filter((r) => r.action === "add" || r.action === "create-new").length;
    const shippingPerItem = ciState.shippingAmountOriginal > 0 && shippingActiveCount > 0
      ? ciState.shippingAmountOriginal / shippingActiveCount
      : null;

    const rowsHtml = ciState.rows.map((r, i) => {
      if (r.creatingNew) {
        const suggestions = findSimilarMasterInventoryItems(r, ciState.itemsByCode);
        const warn = suggestions.length ? `
          <div class="fp-newitem-warn">
            <strong>Possible existing matches — check before creating a new item:</strong>
            <ul>${suggestions.map((s) => `<li><span class="code">${esc(s.code)}</span> — ${esc(s.description)}</li>`).join("")}</ul>
            <label class="fp-newitem-ack"><input type="checkbox" id="ciNewAck${i}"> None of these match — this is genuinely a new item.</label>
          </div>` : "";
        return `<tr class="fp-editing">
          <td colspan="11">
            <div class="fp-newitem-panel">
              <div class="fp-newitem-tag">Will create a new Master Inventory record</div>
              <h4>${esc(r.code)} — ${esc(r.description)}</h4>
              <p class="small muted">This code was searched against the Master Inventory and no match was found.
                Fill in the fields below to add it as a new item. Nothing is written until <b>Confirm Check-in</b>.</p>
              ${warn}
              <div class="fp-newitem-grid">
                <div class="field"><label>Item code</label><input value="${esc(r.code)}" readonly>
                  <span class="hint">As read from the document — not editable here.</span></div>
                <div class="field"><label>Description</label><input id="ciNewDesc${i}" value="${esc(r.description)}"></div>
                <div class="field"><label>Category</label>
                  <select id="ciNewCategory${i}"><option value="">Select…</option><option>Accessory</option><option>Profile</option><option>Hardware</option></select>
                </div>
                <div class="field"><label>Unit of measure</label><input id="ciNewUnit${i}" value="${esc(r.unit || "pcs")}"></div>
                <div class="field"><label>Opening quantity</label><input value="${fmt(r.qty)}" readonly>
                  <span class="hint">= the Check-in quantity for this line.</span></div>
                <div class="field"><label>Unit cost (${esc(cur)})</label>
                  <input id="ciNewCost${i}" type="number" step="any" min="0" value="${r.invoiceUnitCost != null ? r.invoiceUnitCost : ""}" placeholder="e.g. 4.80">
                  <span class="hint">Required — never guessed for a new item.</span></div>
                <div class="field full"><label>Buffer / low-stock level <span class="opt">(optional)</span></label>
                  <input id="ciNewBuffer${i}" type="number" step="any" min="0" placeholder="e.g. 10 — leave blank to set later"></div>
                <div class="field full"><label>Approved by</label>
                  <input id="ciNewApprover${i}" placeholder="Full name of the person confirming this is a new item"></div>
              </div>
              <div class="fp-newitem-actions">
                <span class="small muted">A named approver must confirm this is genuinely new before it's added.</span>
                <div class="fp-row-actions">
                  <button data-act="cancel-new" data-i="${i}">Cancel</button>
                  <button data-act="save-new" data-i="${i}" class="on">Add to Master Inventory + Check in</button>
                </div>
              </div>
            </div>
          </td>
        </tr>`;
      }
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
      const displayStatus = r.decided && r.action === "skip" ? "skipped" : r.status;
      // Landed Cost: this row's share of shipping (0 for a skipped/pending
      // row -- shipAlloc only ever has entries for "add"/"create-new" rows)
      // and its landed unit cost (original unit cost + that share). Value
      // (AED) below is based on the landed figure once shipping applies --
      // with no shipping charge entered, shipAlloc is empty, landedUnitCost
      // falls back to the plain invoiceUnitCost, and this is byte-for-byte
      // the same number the pre-Landed-Cost calculation produced.
      const shipAllocForRow = shipAlloc.get(i) || 0;
      const landedUnitCost = ciLandedUnitCost(i, shipAlloc);
      const aedValue = rate && landedUnitCost != null ? r.qty * landedUnitCost * rate : null;
      // Short-code warning now lives as a small badge next to the Code cell
      // instead of a bold paragraph under the Description -- same signal
      // (code may be truncated, never guessed/auto-completed), just less
      // alarming to read. Clicking it opens the same Edit row as the Edit
      // button (data-act/data-i match applyCiRowAction's existing handling).
      const reviewFlag = r.truncatedHint && r.status === "unmatched"
        ? `<button type="button" class="fp-code-review-flag" data-act="edit" data-i="${i}"
             title="Code may be incomplete. Please verify the correct item before confirming.">⚠ Review</button>`
        : "";
      // Plain (non-interactive) badge -- this row's code/qty/price came from
      // OCR or the greedy fallback matcher rather than a normal text-layer
      // read, so it's more likely than usual to contain a misread value.
      // Deliberately not a .fp-code-review-flag button: that class is wired
      // to applyCiRowAction(i, act) via data-i/data-act, which this badge
      // doesn't set.
      const lowConfBadge = r.lowConfidence
        ? `<span title="Read via the greedy token-matching fallback (no known document layout matched) -- verify this row against the original document." style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:600;background:#fff3cd;color:#7a5b00;border:1px solid #f0d78c;white-space:nowrap">⚠ low-confidence</span>`
        : "";
      // The exact code exists in Master Inventory, but the invoice's own
      // Unit text doesn't match what's on file for it -- shown side by
      // side so the difference is visible before anyone decides anything,
      // exactly as it was found (no conversion, no guessed value).
      const exactDiffNote = r.status === "exact-diff" ? `<div class="fp-exactdiff">
          <div class="fp-exactdiff-h">Exact Item Code found in Master Inventory</div>
          <div><span class="lbl">Master Inventory:</span> <span class="code">${esc(r.exactMatchItem.code)}</span> — ${esc(r.exactMatchItem.description)} · Unit: <b>${esc(r.exactMatchItem.unit || "—")}</b></div>
          <div><span class="lbl">Supplier Invoice:</span> <span class="code">${esc(r.code)}</span> — ${esc(r.description || "—")} · Unit: <b>${esc(r.unit || "—")}</b></div>
          <div class="fp-exactdiff-warn">⚠ Unit/pack size differs — review before using. No conversion is applied automatically.</div>
        </div>` : "";
      const usedDiffNote = r.usedDespiteDifference ? `<div class="small muted" style="margin-top:2px">
          Used despite a pack-size difference (invoice: ${esc(r.usedDespiteDifference.invoicePackSize || "—")}, Master Inventory: ${esc(r.usedDespiteDifference.masterPackSize || "—")}) — confirmed by the user.
        </div>` : "";
      // The invoice's own packaging claim doesn't match the kind of
      // packaging Master Inventory's description states for this item
      // (e.g. invoice says "200m", item's own record says "108 per
      // sheet") -- shown side by side with an editable quantity so the
      // human decides, rather than the system silently picking a side.
      const packReviewNote = r.status === "pack-review" ? `<div class="fp-exactdiff">
          <div class="fp-exactdiff-h">Pack size / unit requires review</div>
          <div><span class="lbl">Invoice states:</span> ${fmt(r.qty)} × ${esc(r.packMismatch.invoicePkg.qtyPerPackage)}${esc(r.packMismatch.invoicePkg.unit)} (${esc(r.packMismatch.invoicePkg.type)})</div>
          <div><span class="lbl">Master Inventory description states:</span> ${esc(r.packMismatch.masterPkg.qtyPerPackage)} per ${esc(r.packMismatch.masterPkg.type)}</div>
          <div class="fp-exactdiff-warn">⚠ These don't describe the same kind of packaging — no conversion has been applied. Confirm the correct quantity to check in.</div>
          <div style="margin-top:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap">
            <label style="font-weight:600; font-size:12px">Quantity to check in:</label>
            <input type="number" step="any" min="0" id="ciPackQty${i}" value="${r.qty}" class="fp-inline-input fp-inline-input-num" style="width:90px">
            <button type="button" data-act="confirm-pack" data-i="${i}" class="fp-code-review-flag" style="font-size:12.5px">Confirm quantity →</button>
          </div>
        </div>` : "";
      // A bundled item shows its packaging plainly ("4 Rolls × 200m")
      // instead of the misleading "+4 200m" that read as if 200m were the
      // quantity itself -- true both once resolved (packageInfo) and while
      // still pending review (packMismatch), so the confusing format never
      // appears at any stage.
      // r.packMismatch is deliberately never deleted once resolved (kept
      // for reference), so this must check current status, not just
      // whether packMismatch exists -- otherwise a resolved row that
      // cleared packageInfo (see "confirm-pack" above) would fall back to
      // the stale pre-resolution packaging phrase.
      const pkgForDisplay = r.packageInfo || (r.status === "pack-review" ? r.packMismatch.invoicePkg : null);
      // An auto-converted roll/bundle row carries its own roll count
      // (pkgForDisplay.rollCount) separately from r.qty, which here holds
      // the expanded METRE total actually being written to stock -- shown
      // as "+1 Roll (300 m)" so staff can see both the roll count they
      // recognise from the invoice and the real inventory quantity, rather
      // than "300 Rolls × 300m" (wrong) or a bare "+300 m" (no longer
      // recognisable as "1 roll").
      const qtyDisplay = pkgForDisplay && pkgForDisplay.rollCount != null
        ? `+${fmt(pkgForDisplay.rollCount)} ${esc(pkgForDisplay.type)}${pkgForDisplay.rollCount === 1 ? "" : "s"}
           <div class="small muted">(${fmt(r.qty)} ${esc(pkgForDisplay.unit)})</div>`
        : pkgForDisplay
        ? `${fmt(r.qty)} ${esc(pkgForDisplay.type)}${r.qty === 1 ? "" : "s"} × ${esc(pkgForDisplay.qtyPerPackage)}${esc(pkgForDisplay.unit)}`
        : `+${fmt(r.qty)} ${esc(r.unit)}`;
      return `<tr class="${rowClass}">
        <td class="code">${esc(r.code)}${reviewFlag}${lowConfBadge}</td>
        <td>${esc(r.description)}${exactDiffNote}${packReviewNote}${usedDiffNote}</td>
        <td class="num">${r.current != null ? fmt(r.current) : "—"}</td>
        <td class="num" style="color:var(--brand); font-weight:600">${qtyDisplay}</td>
        <td class="num">${r.newQty != null ? fmt(r.newQty) : "—"}</td>
        <td class="num">${genericMoney(r.invoiceUnitCost, cur)}</td>
        <td class="num">${shipAllocForRow > 0 ? genericMoney(shipAllocForRow, cur) : "—"}</td>
        <td class="num">${landedUnitCost != null ? genericMoney(landedUnitCost, cur) : "—"}</td>
        <td class="num">${aedValue != null ? money(aedValue) : "—"}</td>
        <td>${ciStatusChip(r, displayStatus)}</td>
        <td>${ciRenderRowActionButtons(i, r)}</td>
      </tr>`;
    }).join("");

    const exactDiffCount = ciState.rows.filter((r) => !r.decided && r.status === "exact-diff").length;
    const packReviewCount = ciState.rows.filter((r) => !r.decided && r.status === "pack-review").length;
    const needDecisionTotal = unmatched + exactDiffCount + packReviewCount;
    const warnBox = needDecisionTotal > 0 ? `<div class="fp-warn">
      <h4>${needDecisionTotal} item${needDecisionTotal === 1 ? "" : "s"} need${needDecisionTotal === 1 ? "s" : ""} a decision</h4>
      <ul>
        ${unmatched > 0 ? `<li><b>${unmatched} unmatched item${unmatched === 1 ? "" : "s"}</b> — code not in the Master Inventory.
          Not checked in; click Edit and pick the correct item from the Master Inventory list, or Acknowledge
          to confirm you've seen it. A new Master Inventory item is never created from here.
          <span class="fp-batch-actions">
            <button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button>
          </span></li>` : ""}
        ${exactDiffCount > 0 ? `<li><b>${exactDiffCount} item${exactDiffCount === 1 ? "" : "s"} with an exact code match, but a detail differs</b> —
          the item code already exists in the Master Inventory, but the invoice's unit doesn't match what's on file.
          Review the comparison shown under each of these rows, then click Use Existing Item once you've confirmed it,
          or Edit to pick a different item instead.</li>` : ""}
        ${packReviewCount > 0 ? `<li><b>${packReviewCount} item${packReviewCount === 1 ? "" : "s"} with a pack-size mismatch</b> —
          the invoice's packaging doesn't match how Master Inventory describes this item. Review the comparison shown
          under each of these rows, then confirm the correct quantity to check in.</li>` : ""}
      </ul>
    </div>` : "";

    // A totally-unreadable line never becomes a row at all, so it can't
    // trip the "every row decided" gate above -- this is the reconciliation
    // check surfaced as an explicit, must-acknowledge banner instead, so a
    // dropped invoice line can never silently make it through Confirm.
    const missingLnBox = ciState.missingLnNumbers.length ? `<div class="fp-warn">
      <h4>${ciState.missingLnNumbers.length} line${ciState.missingLnNumbers.length === 1 ? "" : "s"} could not be read from the document</h4>
      <p class="small" style="margin:0 0 var(--space-2)">Line${ciState.missingLnNumbers.length === 1 ? "" : "s"}
        <b>${ciState.missingLnNumbers.join(", ")}</b> ${ciState.missingLnNumbers.length === 1 ? "exists" : "exist"} in the
        document but couldn't be reliably parsed into a row — nothing was guessed. Check the original document for
        ${ciState.missingLnNumbers.length === 1 ? "this line" : "these lines"} and add it manually if needed before confirming.</p>
      <label style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12.5px">
        <input type="checkbox" id="ciMissingLnAck" ${ciState.missingLnAcknowledged ? "checked" : ""}>
        I've checked the original document for the line${ciState.missingLnNumbers.length === 1 ? "" : "s"} above.
      </label>
    </div>` : "";

    // OCR can misread a character (0/O, 1/I, 5/S...) rather than simply fail
    // to find one -- unlike a normal text-layer read, so Confirm stays gated
    // behind an explicit acknowledgement here too.
    const ocrStillBadNote = ciState.ocrStillUnreadablePages.length
      ? ` Page${ciState.ocrStillUnreadablePages.length === 1 ? "" : "s"} <b>${ciState.ocrStillUnreadablePages.join(", ")}</b> could not be read even with OCR and ${ciState.ocrStillUnreadablePages.length === 1 ? "was" : "were"} left out entirely — check ${ciState.ocrStillUnreadablePages.length === 1 ? "it" : "them"} manually for any items not shown below.`
      : "";
    const ocrBox = ciState.usedOcr ? `<div class="fp-warn">
      <h4>Part of this document was read using OCR</h4>
      <p class="small" style="margin:0 0 var(--space-2)">At least one page had no reliable text layer (a scanned page, or a
        font with no character mapping), so this reader fell back to reading it as an image. OCR can misread similar-looking
        characters — check every code, quantity and price below against the original document before confirming.${ocrStillBadNote}</p>
      <label style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12.5px">
        <input type="checkbox" id="ciOcrAck" ${ciState.ocrAcknowledged ? "checked" : ""}>
        I've checked the codes, quantities and prices below against the original document.
      </label>
    </div>` : "";

    const lowConfBox = ciState.lowConfidenceFallback ? `<div class="fp-warn">
      <h4>This document was read with a low-confidence fallback</h4>
      <p class="small" style="margin:0 0 var(--space-2)">No known document layout matched this file, so it was read with a
        best-effort matcher that pieces scattered fields back together. This is more likely to misread a code, quantity or
        price than the reader's normal formats — check every row below (marked ⚠ low-confidence) against the original
        document before confirming.</p>
      <label style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12.5px">
        <input type="checkbox" id="ciLowConfAck" ${ciState.lowConfidenceAcknowledged ? "checked" : ""}>
        I've checked every row below against the original document.
      </label>
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

    // Landed Cost: always shown once a document has been read, so shipping
    // can be added/corrected here even when detection found nothing --
    // never applied without being visible and editable first. Leaving it
    // blank/zero is exactly Case A (no shipping) and leaves every figure
    // above completely unchanged.
    //
    // The note text below is a staff-facing instruction, not just a status
    // report -- every branch tells the person what to actually do next
    // (enter it / check it / leave it blank), since this is a new step in
    // an existing workflow and the page itself is the only training most
    // people will get.
    let shippingGuidance;
    if (ciState.shippingNeedsReview) {
      shippingGuidance = `${ciState.shippingNote} Type the confirmed amount into the box above, or leave it blank if there's no shipping charge on this document.`;
    } else if (ciState.shippingAmountOriginal > 0) {
      shippingGuidance = `${ciState.shippingNote} Check this is the right amount before confirming — if not, correct it above.`;
    } else {
      shippingGuidance = "No shipping/freight/packing charge was found on this document. If the supplier billed shipping, freight or packing separately, type the amount into the box above and it'll be spread evenly across the items below. If not, leave this blank — nothing changes.";
    }
    const shippingCard = `<div class="fp-currency-card" id="fpShippingCard">
        <div><label class="field-label" for="ciShippingInput">Shipping / freight / packing cost (${esc(cur)})</label>
          <input id="ciShippingInput" type="number" step="any" min="0"
            value="${ciState.shippingAmountOriginal != null ? ciState.shippingAmountOriginal : ""}" placeholder="0.00"></div>
        <div><label class="field-label">Inventory line items</label><strong>${shippingActiveCount}</strong></div>
        <div><label class="field-label">Shipping per item</label><strong>${shippingPerItem != null ? genericMoney(shippingPerItem, cur) : "—"}</strong></div>
        <div class="fp-currency-note">${esc(shippingGuidance)}</div>
      </div>`;

    $("#ciOut").innerHTML = `
      ${currencyCard}
      ${shippingCard}
      <div class="fp-tally">
        <div class="fp-tally-item"><strong>${t.totalItems}</strong><span>Items to check in</span></div>
        <div class="fp-tally-item"><strong>${t.totalValueAed != null ? money(t.totalValueAed) : "—"}</strong><span>AED inventory value</span></div>
        <div class="fp-tally-item"><strong>${t.skipped}</strong><span>Skipped</span></div>
        <div class="fp-tally-item"><strong>${t.unresolved}</strong><span>Unresolved</span></div>
      </div>
      ${warnBox}
      ${missingLnBox}
      ${ocrBox}
      ${lowConfBox}
      <div class="fp-section-h">Check-in preview</div>
      <div class="fp-scroll">
        <table class="fp-table">
          <thead><tr>
            <th>Code</th><th>Description</th>
            <th class="num">Current stock</th>
            <th class="num">Check-in qty</th>
            <th class="num">New stock</th>
            <th class="num">Unit cost (${esc(cur)})</th>
            <th class="num">Shipping alloc. (${esc(cur)})</th>
            <th class="num">Landed unit cost (${esc(cur)})</th>
            <th class="num">Value (AED)${ciState.shippingAmountOriginal > 0 ? " incl. shipping" : ""}</th>
            <th>Status</th><th>Action</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:var(--space-3)">Nothing has been added yet.
      The confirm button unlocks once every unmatched row has been edited or acknowledged${cur !== "AED" ? " and the exchange rate is entered" : ""}.</p>
    `;

    const canConfirm = ciCanConfirm();
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
    const shippingInput = document.getElementById("ciShippingInput");
    if (shippingInput) {
      shippingInput.addEventListener("change", () => {
        const v = parseFloat(shippingInput.value);
        ciState.shippingAmountOriginal = isFinite(v) && v > 0 ? v : null;
        // The user has now explicitly set (or cleared) the amount -- the
        // "ambiguous, please confirm" flag no longer applies either way.
        ciState.shippingNeedsReview = false;
        ciState.shippingNote = ciState.shippingAmountOriginal != null
          ? "Entered manually."
          : "No shipping/freight/packing charge detected in this document.";
        ciRender();
      });
    }
    const missingLnAckEl = document.getElementById("ciMissingLnAck");
    if (missingLnAckEl) {
      missingLnAckEl.addEventListener("change", () => {
        ciState.missingLnAcknowledged = missingLnAckEl.checked;
        ciRender();
      });
    }
    const ocrAckEl = document.getElementById("ciOcrAck");
    if (ocrAckEl) {
      ocrAckEl.addEventListener("change", () => {
        ciState.ocrAcknowledged = ocrAckEl.checked;
        ciRender();
      });
    }
    const lowConfAckEl = document.getElementById("ciLowConfAck");
    if (lowConfAckEl) {
      lowConfAckEl.addEventListener("change", () => {
        ciState.lowConfidenceAcknowledged = lowConfAckEl.checked;
        ciRender();
      });
    }
  }

  async function ciConfirm() {
    // Re-check the real gate, not just the Confirm button's disabled
    // attribute -- see ciCanConfirm() for why that's not trustworthy on
    // its own.
    if (!ciCanConfirm()) {
      throw new Error("This Check-in can't be confirmed yet — an unresolved row, an unacknowledged warning, or a missing field needs attention. Please review the preview above.");
    }
    const supplier = $("#ciSupplier").value.trim();
    const invoiceNumber = $("#ciInvoiceNumber").value.trim();
    const poNumber = $("#ciPoNumber").value.trim();
    const docDate = $("#ciDocDate").value || null;
    const rate = ciRate();
    if (ciState.currency !== "AED" && !(rate > 0)) {
      throw new Error("Enter the exchange rate before confirming.");
    }
    // Computed once, fresh, from the current row list -- same allocation
    // ciRender() just showed. Kept keyed by row index (not by array position
    // after filtering) so each line's shipping share lines up with the exact
    // row it was shown against in the preview.
    const shipAlloc = ciShippingAllocation();
    const lines = ciState.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r.action === "add" && r.itemId) || (r.action === "create-new" && r.newItemData))
      .map(({ r, i }) => {
        const shipAllocForRow = shipAlloc.get(i) || 0;
        // Document-level total is repeated on every line (same pattern as
        // supplier/invoice_number/po_number below) -- purely for audit, so
        // each transaction row can show the whole shipping picture on its
        // own without needing to look up sibling rows from the same
        // document. Sent only when shipping actually applies to this line.
        const shippingCostTotal = shipAllocForRow > 0 ? ciState.shippingAmountOriginal : null;
        if (r.action === "create-new") {
          // A brand-new Master Inventory item -- item_id is null, and
          // checkin_transaction() creates the row itself from new_item.
          // Unlike an existing item, there's no Master Inventory unit_cost
          // to fall back on, so the front-end already required this to be
          // a positive number before the row could reach this state.
          const landedUnitCost = r.invoiceUnitCost + shipAllocForRow;
          return {
            item_id: null, quantity: r.qty, unit: r.unit,
            unit_cost: landedUnitCost * rate,
            original_unit_cost: r.invoiceUnitCost,
            shipping_cost_total: shippingCostTotal,
            shipping_allocated: shipAllocForRow > 0 ? shipAllocForRow : null,
            landed_unit_cost: landedUnitCost,
            new_item: {
              item_code: r.newItemData.code,
              description: r.newItemData.description,
              category: r.newItemData.category,
              unit_of_measure: r.newItemData.unit,
              buffer_level: r.newItemData.bufferLevel,
              approved_by: r.newItemData.approvedBy,
            },
          };
        }
        // No document price (e.g. an Order Approval) -- landed cost stays
        // null too, never guessed from an unknown base cost. Shipping is
        // still recorded for audit even though it can't be folded into a
        // unit cost that doesn't exist. Goes through the same
        // ciLandedUnitCost() the preview used (not a re-derived formula
        // here) so a roll/bundle row's shipping share is spread across its
        // metres exactly as shown on screen -- what was previewed is what
        // gets saved.
        const landedUnitCost = ciLandedUnitCost(i, shipAlloc);
        // A roll/bundle row's package_cost is the original PER-ROLL
        // invoice price, not r.invoiceUnitCost (which is per-metre for
        // these rows) -- rollUnitCost preserves that for audit; every
        // other packaged row falls back to invoiceUnitCost exactly as before.
        const auditUnitCost = r.packageInfo && r.packageInfo.rollUnitCost != null
          ? r.packageInfo.rollUnitCost
          : r.invoiceUnitCost;
        return {
          item_id: r.itemId, quantity: r.qty, unit: r.unit,
          // No document price (e.g. an Order Approval) -- send null, not a
          // fabricated 0, so checkin_transaction() falls back to the Master
          // Inventory's own unit_cost instead of recording a false free cost.
          unit_cost: landedUnitCost != null ? landedUnitCost * rate : null,
          original_unit_cost: r.invoiceUnitCost != null ? r.invoiceUnitCost : null,
          shipping_cost_total: shippingCostTotal,
          shipping_allocated: shipAllocForRow > 0 ? shipAllocForRow : null,
          landed_unit_cost: landedUnitCost,
          // Packaging facts, purely for audit -- quantity/unit_cost above
          // already reflect Master Inventory's own unit basis; these just
          // preserve what the supplier document actually said (e.g. "4
          // rolls of 200m at AED 331.65/roll") so it's never lost.
          package_type: r.packageInfo ? r.packageInfo.type : null,
          package_qty: r.packageInfo ? (r.packageInfo.rollCount != null ? r.packageInfo.rollCount : r.qty) : null,
          qty_per_package: r.packageInfo ? r.packageInfo.qtyPerPackage : null,
          package_unit: r.packageInfo ? r.packageInfo.unit : null,
          package_cost: r.packageInfo && auditUnitCost != null ? auditUnitCost * rate : null,
        };
      });

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
      if (data.error === "duplicate_code") {
        throw new Error(`Code ${data.item_code || ""} already exists in the Master Inventory — this can't be added as a new item. Use Edit to match it to the existing one instead.`);
      }
      if (data.error === "approver_required") {
        throw new Error("A named approver is required for every new Master Inventory item before Check-in can be confirmed.");
      }
      throw new Error(data.detail || data.error || "The Check-in was not applied.");
    }

    $("#ciConfirmBar").hidden = true;
    const currencyNote = ciState.currency !== "AED"
      ? ` Converted from ${esc(ciState.currency)} at a rate of 1 ${esc(ciState.currency)} = ${rate} AED (${esc(RATE_SOURCE_LABEL[ciState.rateSource] || ciState.rateSource)}${ciState.rateDate ? `, rate date ${esc(ciState.rateDate)}` : ""}).`
      : "";
    const shippingNote = ciState.shippingAmountOriginal > 0
      ? ` Shipping/freight/packing cost of ${esc(genericMoney(ciState.shippingAmountOriginal, ciState.currency))} was split equally across ${lines.length} line item${lines.length === 1 ? "" : "s"} and folded into each item's landed cost.`
      : "";
    $("#ciDone").innerHTML = `
      <div class="fp-done">
        <h3>Check-in confirmed — ${data.lines.length} item${data.lines.length === 1 ? "" : "s"} added</h3>
        <p class="small">Invoice <code>${esc(invoiceNumber || "—")}</code> from <b>${esc(supplier || "—")}</b>. The Master
        Inventory and the Transaction History now reflect this. A permanent Check-in transaction has been recorded for each item.${currencyNote}${shippingNote}</p>
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
    // This run's own generation number -- OCR in particular can leave this
    // in flight for several seconds. If the user selects a different file
    // (bumping ciAnalyseToken -- see wireCiDrop) or starts a fresh Analyse
    // before this one finishes, isStale() goes true and this run abandons
    // its results instead of overwriting the newer selection's state.
    const myToken = ++ciAnalyseToken;
    const isStale = () => myToken !== ciAnalyseToken;
    ciStatus("Reading the document and matching items against the Master Inventory…");
    try {
      let [pages, itemsByCode, hash, ratesByCurrency] = await Promise.all([
        extractPdfTextPerPage(ciState.pdfFile),
        loadInventoryItems(),
        pdfFingerprint(ciState.pdfFile),
        loadExchangeRates(),
      ]);

      ciState.usedOcr = false;
      ciState.ocrAcknowledged = false;
      ciState.lowConfidenceFallback = false;
      ciState.lowConfidenceAcknowledged = false;
      // Checked per page, not on the whole joined document -- a normal
      // typed header page must never make an actually-scanned item-table
      // page look "usable" just because the document as a whole reads fine
      // on average.
      const badPageNumbers = pages
        .map((t, idx) => (textLayerLooksUsable(t) ? null : idx + 1))
        .filter((n) => n !== null);
      if (badPageNumbers.length) {
        const pageWord = badPageNumbers.length === 1 ? `page ${badPageNumbers[0]}` : `pages ${badPageNumbers.join(", ")}`;
        ciStatus(`No usable text layer on ${pageWord} (likely a scanned page, or a font with no character mapping) — running OCR on ${badPageNumbers.length === 1 ? "it" : "them"} instead. This can take a little longer…`);
        let ocrResults;
        try {
          ocrResults = await ocrPdfPages(ciState.pdfFile, (done, total) => {
            ciStatus(`Running OCR on page ${done} of ${total}…`);
          }, badPageNumbers);
        } catch (ocrErr) {
          console.error(ocrErr);
          if (!isStale()) {
            ciState.rows = null;
            $("#ciConfirmBar").hidden = true;
            $("#ciDone").innerHTML = "";
            ciStatus("This document has pages with no usable text layer, and OCR failed to run (" + ocrErr.message + "). Nothing was changed.", "err");
          }
          return;
        }
        if (isStale()) return;
        const stillBad = [];
        for (const n of badPageNumbers) {
          const ocrText = ocrResults.get(n) || "";
          if (textLayerLooksUsable(ocrText)) {
            pages[n - 1] = ocrText;
          } else {
            // Never let known-garbage text (still-unreadable even after
            // OCR) leak into parsing -- an empty page is a page this
            // reader plainly couldn't find any items on; garbage text
            // risks accidentally satisfying some format's regex and
            // fabricating a row from noise instead.
            pages[n - 1] = "";
            stillBad.push(n);
          }
        }
        if (stillBad.length === pages.length) {
          ciState.rows = null;
          $("#ciConfirmBar").hidden = true;
          $("#ciDone").innerHTML = "";
          ciStatus("This document appears to be entirely scanned images (or an unreadable font), and OCR could not extract usable text from it either. Please check the file manually — nothing was changed.", "err");
          return;
        }
        ciState.usedOcr = true;
        ciState.ocrStillUnreadablePages = stillBad;
      } else {
        ciState.ocrStillUnreadablePages = [];
      }
      // OCR's multi-second delay is exactly the window where the user could
      // have moved on to a different file -- never let a superseded run
      // write its (possibly OCR'd, possibly minutes-stale) results over
      // whatever the current selection's own analysis has already shown.
      if (isStale()) return;

      let pdfText = pages.join("\n\n");
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
      if (isStale()) return;
      const doc = parseCheckinDocument(pdfText);
      if (!doc.entries.length) {
        // A new file selection already clears any previous preview (see
        // wireCiDrop), but re-analysing the *same* selection after editing
        // a header field must never leave a still-enabled Confirm button
        // pointing at an earlier, unrelated successful analysis once this
        // run turns out to have nothing to check in.
        ciState.rows = null;
        $("#ciConfirmBar").hidden = true;
        $("#ciDone").innerHTML = "";
        // Zero goods rows isn't always this reader failing to recognise a
        // layout -- a document can genuinely carry no goods at all, e.g. a
        // supplier's stand-alone packing/freight charge invoice (the same
        // "Additional Packing charges (in crate)" real-world sample the
        // Landed Cost feature above was built from). Telling that apart
        // from an actually-unrecognised layout means a charge-only document
        // reads as "nothing to receive here" instead of looking like a
        // reader bug.
        const chargeOnly = detectShippingCharge(pdfText);
        if (chargeOnly.amount != null) {
          ciStatus(`This document has no goods to receive — it only contains a shipping/freight/packing charge of ${genericMoney(chargeOnly.amount, ciState.currency)} (from "${chargeOnly.label}"). Nothing can be checked in as stock from this document; the Master Inventory has not been changed. This charge still needs to be folded into the items it belongs to on their own invoice — that has to be done by hand for now.`, "err");
        } else {
          ciStatus("This document isn't in a layout this reader recognises yet — no line items were found, so nothing can be checked in. The Master Inventory has not been changed.", "err");
        }
        return;
      }
      ciState.missingLnNumbers = doc.missingLnNumbers || [];
      ciState.missingLnAcknowledged = false;
      ciState.lowConfidenceFallback = doc.formatId === "greedy-tokens";

      // Landed Cost: a convenience prefill only -- always shown editable in
      // the preview (see ciRender's shippingCard) before Confirm is ever
      // reachable, so an ambiguous or missed detection can always be
      // corrected by hand rather than silently applied or silently dropped.
      const shipping = detectShippingCharge(pdfText);
      ciState.shippingAmountOriginal = shipping.amount;
      ciState.shippingNote = shipping.note;
      ciState.shippingNeedsReview = shipping.needsReview;

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
      if (isStale()) return;
      ciState.rows = buildCheckinRows(doc.entries, descriptions, itemsByCode);
      ciRender();

      const t = ciTally();
      const rateNote = ciState.currency !== "AED"
        ? (ciState.exchangeRate ? ` Exchange rate sourced from ${RATE_SOURCE_LABEL[ciState.rateSource]}.` : " Exchange rate unavailable — flagged for review.")
        : "";
      // A reconciliation count, not just a note -- "N detected, M created"
      // makes a silent shortfall visible even at a glance, before anyone
      // reads the line-number detail after it.
      const totalDetected = doc.entries.length + (doc.missingLnNumbers ? doc.missingLnNumbers.length : 0);
      const gapNote = doc.missingLnNumbers && doc.missingLnNumbers.length
        ? ` Invoice lines detected: ${totalDetected}. Check-in rows created: ${doc.entries.length}. Line${doc.missingLnNumbers.length === 1 ? "" : "s"} ${doc.missingLnNumbers.join(", ")} could not be reliably read — review ${doc.missingLnNumbers.length === 1 ? "it" : "them"} manually before confirming; nothing was guessed.`
        : "";
      const stillBadNote = ciState.ocrStillUnreadablePages.length
        ? ` Page${ciState.ocrStillUnreadablePages.length === 1 ? "" : "s"} ${ciState.ocrStillUnreadablePages.join(", ")} could not be read even with OCR and ${ciState.ocrStillUnreadablePages.length === 1 ? "was" : "were"} skipped — check ${ciState.ocrStillUnreadablePages.length === 1 ? "it" : "them"} manually for any items not listed below.`
        : "";
      const ocrNote = ciState.usedOcr
        ? ` Part of this document had no usable text layer and was read using OCR instead — OCR can misread similar-looking characters, so check codes, quantities and prices carefully before confirming.${stillBadNote}`
        : "";
      const lowConfNote = ciState.lowConfidenceFallback
        ? " No known document layout matched this file, so it was read with a low-confidence, best-effort matcher — check every row against the original document before confirming."
        : "";
      ciStatus(`Analysis ready — ${ciState.header.docType || "document"} read via ${doc.formatLabel}, ${doc.entries.length} line${doc.entries.length === 1 ? "" : "s"} found in ${ciState.currency}, ${t.unresolved} need decisions.${rateNote}${gapNote}${ocrNote}${lowConfNote}`);
    } catch (err) {
      console.error(err);
      if (!isStale()) ciStatus("Could not analyse the document: " + err.message, "err");
    } finally {
      if (!isStale()) btn.disabled = false;
    }
  }

  function ciResetAll() {
    ciState.pdfFile = null;
    ciState.pdfHash = ciState.header = ciState.rows = ciState.itemsByCode = null;
    ciState.currency = "AED"; ciState.exchangeRate = 1; ciState.ratesByCurrency = null;
    ciState.rateDate = null; ciState.rateSource = "n/a";
    ciState.missingLnNumbers = []; ciState.missingLnAcknowledged = false;
    ciState.shippingAmountOriginal = null; ciState.shippingNote = ""; ciState.shippingNeedsReview = false;
    ciState.usedOcr = false; ciState.ocrAcknowledged = false; ciState.ocrStillUnreadablePages = [];
    ciState.lowConfidenceFallback = false; ciState.lowConfidenceAcknowledged = false;
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
      // Selecting a different file must never leave a stale, still-enabled
      // Confirm button (or stale rows) for the previously analysed document
      // on screen -- OCR in particular can leave Analyse running for several
      // seconds, long enough for someone to pick a different file and be
      // shown a Confirm button that would actually submit the old one.
      // ciAnalyseToken also invalidates any in-flight analysis of the
      // previous file (see ciAnalyse) so its results can never land here.
      ciAnalyseToken++;
      ciState.rows = null;
      ciState.header = null;
      ciState.missingLnNumbers = []; ciState.missingLnAcknowledged = false;
      ciState.shippingAmountOriginal = null; ciState.shippingNote = ""; ciState.shippingNeedsReview = false;
      ciState.usedOcr = false; ciState.ocrAcknowledged = false; ciState.ocrStillUnreadablePages = [];
      ciState.lowConfidenceFallback = false; ciState.lowConfidenceAcknowledged = false;
      $("#ciOut").innerHTML = "";
      $("#ciConfirmBar").hidden = true;
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

  function txTypeBadge(type) {
    if (type === "check_in") return `<span class="fp-status-ok">Check-in</span>`;
    if (type === "stock_adjustment") return `<span class="fp-status-review">Stock adjustment</span>`;
    return `<span class="fp-status-unmatched">Check-out</span>`;
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
        <td>${txTypeBadge(g.type)}</td>
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
                <td>${esc(tx.description)}${tx.shipping_allocated ? `<div class="small muted" style="margin-top:2px">Landed cost: includes ${esc(genericMoney(tx.shipping_allocated, tx.original_currency || ""))} shipping allocation (original cost ${esc(genericMoney(tx.original_unit_cost, tx.original_currency || ""))} + shipping = ${esc(genericMoney(tx.landed_unit_cost, tx.original_currency || ""))} landed).</div>` : ""}</td>
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
