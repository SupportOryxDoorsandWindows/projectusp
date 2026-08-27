/* Flyscreen inventory preview.
 *
 * Reads an FP Pro optimisation PDF and a Freedom item-list Excel file entirely
 * inside the browser — nothing is uploaded — and shows the exact rows and
 * quantities that would be deducted from stock if this job were run. No stock
 * is actually changed at this stage; wiring up the real deduction is a
 * follow-up step.
 *
 * PDF text is extracted with pdf.js. The item list is read with SheetJS. Both
 * libraries are pulled from a CDN the first time the Inventory tab is opened,
 * so the main app pays no cost when the tab is not used. */

(function () {
  const $ = (s) => document.querySelector(s);

  // pdf.js and SheetJS are ~1 MB combined. Only load them when needed.
  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

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

  /* --------------------------- state --------------------------- */
  const state = {
    pdfFile: null,
    xlsxFile: null,
    itemList: null,   // array of { code, description, category, cost, inventory, length }
    parsed: null,     // { job, fittings: [...], bars: [...] }
    matched: null,    // last preview result
  };

  /* --------------------------- PDF parsing ---------------------
   *
   * The FP Pro PDF has three section types: an Items list (which we ignore —
   * it describes the units being made, not the parts consumed), a Fittings
   * List (piece-based fittings and gaskets, matched by numeric code), and a
   * Bars Optimization Report (aluminium profiles consumed as N bars of a
   * given length). The text layer coming out of pdf.js is line-based but
   * with quirky wrapping — colour descriptors like "- MILL FINISH" split
   * across two lines, quantities on their own line — so we work on the
   * whole text blob and tokenise carefully.
   * ----------------------------------------------------------- */

  async function extractPdfText(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    const pdf = await window.__pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Preserve the original line breaks by joining with newlines when the
      // y-position changes, otherwise with spaces. pdf.js gives us items in
      // reading order but without newline hints on its own.
      let lastY = null;
      let pageText = "";
      for (const item of content.items) {
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          pageText += "\n";
        } else if (pageText && !pageText.endsWith(" ")) {
          pageText += " ";
        }
        pageText += item.str;
        lastY = y;
      }
      pages.push(pageText);
    }
    return pages.join("\n\n");
  }

  function parseJobHeader(text) {
    const job = {
      ref: (text.match(/Job\/Group:\s*(\S+)/) || [])[1] || "",
      user: (text.match(/User:\s*([^\n]+?)(?:\s{2,}|\n|$)/) || [])[1] || "",
      description: (text.match(/Description:\s*([^\n]+)/) || [])[1] || "",
      printedAt: (text.match(/Printout date\/time:\s*([^\n]+?)(?:Pagina|\n|$)/) || [])[1] || "",
    };
    return job;
  }

  // Split by top-level sections in reading order. Each section is returned
  // as { kind: "fittings" | "bars", text: "..." }.
  function splitSections(text) {
    const sections = [];
    // Fittings List spans one or more "(N of M)" pages. Its content is
    // between "Fittings List (1 of M)" and the first "Bars Optimization
    // Report" (or end of file). We capture everything between the header
    // line and the next Optimisation or Items-list header.
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

  // Fittings look like one of:
  //   ORYX <CODE>                                <QTY>[ m] <DESCRIPTION>
  //   ORYX <CODE> - <COLOUR line 1>              <QTY>[ m] <DESCRIPTION>
  //                <COLOUR line 2>
  // The code always starts with digits (optionally trailing "R") followed
  // by a hyphen and hyphenated word tokens. We split the fittings section
  // into per-entry text blocks by finding every "ORYX " and reading up to
  // (but not including) the next "ORYX " or the end of the section.
  const CODE_RE = /^([0-9]+R?)-/;
  function parseFittings(text) {
    const out = [];
    const entries = text.split(/\bORYX\b/).slice(1);
    for (const raw of entries) {
      // Skip header rows ("Class: ...", "Preview Brand Code ...") that may
      // be captured in the split — they won't contain a valid code.
      const cleaned = raw.replace(/\s+/g, " ").trim();
      // The token immediately after ORYX is the full code (until the first
      // space that is followed by a quantity number, a colour dash, or the
      // description).
      const codeMatch = cleaned.match(/^([\w-()]+)/);
      if (!codeMatch) continue;
      const fullCode = codeMatch[1];
      const codeM = fullCode.match(CODE_RE);
      if (!codeM) continue; // not a real fitting row
      const code = codeM[1];

      // Skip the code token; look for the quantity — the first standalone
      // number, optionally with " m" for metre-based items.
      const rest = cleaned.slice(fullCode.length).trim();
      const qtyMatch = rest.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(m\b)?\s+(.+)$/);
      if (!qtyMatch) continue;
      const qty = parseFloat(qtyMatch[1]);
      const unit = qtyMatch[2] ? "m" : "pcs";
      const description = qtyMatch[3].trim();

      out.push({ code, fullCode, qty, unit, description });
    }
    return out;
  }

  // Bars entries look like:
  //   Serie: FLYSCREEN Code: <SHORT> Bars: <N> x <L>
  //   Treatement: <maybe blank>
  //   Description: <CODE>[- ]<NAME>
  //   Total length: <TOT> m Total Weight: 0 kg
  //   Waste: 0 kg Stock Code:
  // We anchor on "Bars:" lines and read backwards/forwards to find the code.
  function parseBars(text) {
    const out = [];
    // Grab each "Bars: N x L" occurrence and its surrounding fields.
    const re = /Bars:\s*(\d+)\s*x\s*(\d+)[\s\S]*?Description:\s*([^\n]+?)\s*Total length:\s*([\d.]+)\s*m/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const bars = parseInt(m[1], 10);
      const barLen = parseInt(m[2], 10); // in mm
      const desc = m[3].trim();
      const totalLenM = parseFloat(m[4]);
      // Extract code from description — first token that starts with digits.
      const codeM = desc.match(/(\d+)\s*[-–]/);
      const code = codeM ? codeM[1] : "";
      out.push({
        code,
        description: desc,
        bars,
        barLenMm: barLen,
        totalLenM,
      });
    }
    return out;
  }

  function parsePdfText(text) {
    return {
      job: parseJobHeader(text),
      sections: splitSections(text).map((s) => ({
        kind: s.kind,
        entries: s.kind === "fittings" ? parseFittings(s.text) : parseBars(s.text),
      })),
    };
  }

  /* --------------------------- Item list parsing --------------- */

  async function loadItemList(file) {
    await loadLibs();
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    // Take the first sheet by default. The sample file has one sheet.
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    // Find the header row (contains "CODE" in the first column).
    let headerIdx = rows.findIndex((r) => /CODE/i.test(String(r[0] || "")));
    if (headerIdx === -1) headerIdx = 0;
    const header = rows[headerIdx].map((h) => String(h || "").trim().toUpperCase());
    const idx = (name) => header.indexOf(name);
    const iCode = idx("CODE");
    const iDesc = idx("DESCRIPTION");
    const iLen  = header.findIndex((h) => /LENGTH/i.test(h));
    const iCat  = idx("CATEGORY");
    const iInv  = idx("INVENTORY");
    const iCost = idx("COST");
    const iTot  = header.findIndex((h) => /TOTAL/i.test(h));
    const items = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const code = row[iCode];
      if (!code) continue;
      items.push({
        code: String(code).trim(),
        description: iDesc >= 0 ? String(row[iDesc] || "").trim() : "",
        length: iLen >= 0 ? row[iLen] : null,
        category: iCat >= 0 ? String(row[iCat] || "").trim() : "",
        inventory: Number(iInv >= 0 ? row[iInv] : 0) || 0,
        cost: Number(iCost >= 0 ? row[iCost] : 0) || 0,
        totalValue: Number(iTot >= 0 ? row[iTot] : 0) || 0,
      });
    }
    return items;
  }

  /* --------------------------- Matching ------------------------
   *
   * The PDF gives us numeric codes like "133004" or "30001R"; the item list
   * has "133004", "30001R", etc. as exact strings. Match on the numeric-part
   * key. If the item list has separate rows for the same code at different
   * bar lengths, prefer the one with a length that matches the bar length
   * declared in the PDF (converted to metres).
   * ------------------------------------------------------------ */

  function matchEntries(parsed, itemList) {
    const byCode = new Map();
    for (const it of itemList) {
      const arr = byCode.get(it.code) || [];
      arr.push(it);
      byCode.set(it.code, arr);
    }

    const matched = [];
    const unmatched = [];

    const pushMatched = (row) => matched.push(row);

    for (const section of parsed.sections) {
      if (section.kind === "fittings") {
        for (const e of section.entries) {
          const cands = byCode.get(e.code);
          if (!cands || !cands.length) {
            unmatched.push({ kind: "fitting", ...e });
            continue;
          }
          const item = cands[0];
          pushMatched({
            kind: "fitting",
            code: e.code,
            description: item.description || e.description,
            category: item.category,
            qty: e.qty,
            unit: e.unit,
            cost: item.cost,
            estValue: e.qty * item.cost,
            inventoryBefore: item.inventory,
            inventoryAfter: item.inventory - e.qty,
            pdfText: "",
          });
        }
      } else if (section.kind === "bars") {
        for (const e of section.entries) {
          const cands = byCode.get(e.code);
          if (!cands || !cands.length) {
            unmatched.push({ kind: "bar", ...e });
            continue;
          }
          // Prefer a candidate whose stored length matches the PDF bar length.
          const barLenM = e.barLenMm / 1000;
          let item = cands.find((c) => c.length && Math.abs(Number(c.length) - barLenM) < 0.05);
          if (!item) item = cands[0];

          // Aluminium profiles are always deducted per bar, never per metre —
          // stock rooms hold whole bars and cut from them. The metre total
          // stays visible in the PDF-text column so the user can sanity-check
          // what the optimisation actually asked for.
          const qty = e.bars;
          const unit = e.bars === 1 ? "bar" : "bars";
          pushMatched({
            kind: "bar",
            code: e.code,
            description: item.description || e.description,
            category: item.category,
            qty,
            unit,
            cost: item.cost,
            estValue: qty * item.cost,
            inventoryBefore: item.inventory,
            inventoryAfter: item.inventory - qty,
            pdfText: `${e.bars} × ${e.barLenMm} mm = ${e.totalLenM} m`,
          });
        }
      }
    }
    return { matched, unmatched };
  }

  /* --------------------------- Render ------------------------- */

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

  function render(job, result) {
    const totalItems = result.matched.length;
    const totalValue = result.matched.reduce((s, r) => s + (r.estValue || 0), 0);
    const totalUnmatched = result.unmatched.length;

    const rows = result.matched.map((r) => `
      <tr>
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.description)}
          ${r.pdfText ? `<div class="small muted">${esc(r.pdfText)}</div>` : ""}</td>
        <td><span class="inv-cat">${esc(r.category || "—")}</span></td>
        <td class="num">${fmt(r.qty)} ${esc(r.unit)}</td>
        <td class="num">${money(r.cost)}</td>
        <td class="num"><b>${money(r.estValue)}</b></td>
        <td class="num">${fmt(r.inventoryBefore)}</td>
        <td class="num" ${r.inventoryAfter < 0 ? 'style="color:var(--danger); font-weight:600"' : ""}>${fmt(r.inventoryAfter)}</td>
      </tr>`).join("");

    const unmatchedList = result.unmatched.length
      ? `<div class="inv-warn">
          <h4>${result.unmatched.length} item${result.unmatched.length === 1 ? "" : "s"} could not be matched to the item list</h4>
          <p class="small">Add these codes to the item list, or check that the PDF section was recognised.</p>
          <ul>${result.unmatched.map((u) => `
            <li><code>${esc(u.code || "?")}</code> — ${esc(u.description || "")}
              ${u.kind === "bar" ? `<span class="small muted">(${u.bars} × ${u.barLenMm} mm)</span>` : `<span class="small muted">(${fmt(u.qty)} ${esc(u.unit)})</span>`}
            </li>`).join("")}</ul>
        </div>`
      : "";

    const shortNeg = result.matched.filter((r) => r.inventoryAfter < 0).length;
    const shortWarn = shortNeg
      ? `<div class="inv-warn">
          <h4>${shortNeg} item${shortNeg === 1 ? "" : "s"} would go below zero stock</h4>
          <p class="small">These items don't have enough on hand to cover this job. Consider stock replenishment before the deduction is applied for real.</p>
        </div>`
      : "";

    $("#invOut").innerHTML = `
      <div class="inv-jobcard">
        <div class="inv-jobfield"><label>Job ref</label><strong>${esc(job.ref || "—")}</strong></div>
        <div class="inv-jobfield"><label>User</label><strong>${esc(job.user || "—")}</strong></div>
        <div class="inv-jobfield"><label>Description</label><strong>${esc(job.description || "—")}</strong></div>
        <div class="inv-jobfield"><label>Printed</label><strong>${esc(job.printedAt || "—")}</strong></div>
      </div>

      <div class="inv-tally">
        <div class="inv-tally-item"><strong>${totalItems}</strong><span>Line items</span></div>
        <div class="inv-tally-item"><strong>${money(totalValue)}</strong><span>Est. deduction value</span></div>
        <div class="inv-tally-item"><strong>${totalUnmatched}</strong><span>Unmatched</span></div>
        <div class="inv-tally-item"><strong>${shortNeg}</strong><span>Would go negative</span></div>
      </div>

      ${shortWarn}
      ${unmatchedList}

      <div class="inv-section-h">Preview of items that would be deducted</div>
      <div class="inv-scroll">
        <table class="inv-table">
          <thead><tr>
            <th>Code</th><th>Description</th><th>Category</th>
            <th class="num">Qty</th><th class="num">Cost / unit</th><th class="num">Value</th>
            <th class="num">In stock</th><th class="num">After</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="small muted" style="margin-top:var(--space-3)">Preview only — no stock has been changed. Confirm the numbers on real jobs, then wire up the actual deduction step.</p>
    `;
  }

  /* --------------------------- Excel export ------------------- */

  function downloadExcel(job, result) {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    const summary = [
      ["Job ref", job.ref || ""],
      ["User", job.user || ""],
      ["Description", job.description || ""],
      ["Printed", job.printedAt || ""],
      [],
      ["Line items", result.matched.length],
      ["Est. deduction value", result.matched.reduce((s, r) => s + (r.estValue || 0), 0)],
      ["Unmatched entries", result.unmatched.length],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Job");

    const header = ["Code", "Description", "Category", "Qty", "Unit", "Cost/unit", "Value", "In stock", "After",
                    "PDF text"];
    const body = result.matched.map((r) => [
      r.code, r.description, r.category, r.qty, r.unit,
      r.cost, r.estValue, r.inventoryBefore, r.inventoryAfter, r.pdfText,
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...body]), "Deductions");

    if (result.unmatched.length) {
      const uHead = ["Code", "Description", "Kind", "Details"];
      const uBody = result.unmatched.map((u) => [
        u.code || "", u.description || "", u.kind,
        u.kind === "bar" ? `${u.bars} × ${u.barLenMm} mm` : `${u.qty} ${u.unit}`,
      ]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([uHead, ...uBody]), "Unmatched");
    }
    const name = "flyscreen-preview-" + (job.ref || "job") + ".xlsx";
    XLSX.writeFile(wb, name);
  }

  /* --------------------------- Wire-up ------------------------ */

  function wireDrop(dropEl, inputEl, kind) {
    dropEl.addEventListener("click", () => inputEl.click());
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
      if (kind === "pdf") {
        state.pdfFile = f;
        $("#invPdfName").textContent = f.name;
      } else {
        state.xlsxFile = f;
        $("#invXlsxName").textContent = f.name;
      }
      dropEl.classList.add("ready");
      $("#invRun").disabled = !(state.pdfFile && state.xlsxFile);
    });
  }

  function status(text, kind) {
    const el = $("#invStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  async function run() {
    if (!state.pdfFile || !state.xlsxFile) return;
    const btn = $("#invRun");
    btn.disabled = true;
    status("Reading files…");
    try {
      const [pdfText, items] = await Promise.all([
        extractPdfText(state.pdfFile),
        loadItemList(state.xlsxFile),
      ]);
      state.itemList = items;
      state.parsed = parsePdfText(pdfText);
      state.matched = matchEntries(state.parsed, items);
      render(state.parsed.job, state.matched);
      status(`Preview ready — ${state.matched.matched.length} items matched, ${state.matched.unmatched.length} unmatched.`);
      $("#invDownload").disabled = false;
    } catch (err) {
      console.error(err);
      status("Could not read the files: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // Some elements only exist after boot has flipped #appShell visible.
  // Wait for the tab shell before wiring anything up.
  function init() {
    if (!$("#invRun")) { setTimeout(init, 50); return; }
    wireDrop($("#invDropPdf"), $("#invPdf"), "pdf");
    wireDrop($("#invDropXlsx"), $("#invXlsx"), "xlsx");
    $("#invRun").addEventListener("click", run);
    $("#invDownload").addEventListener("click", () => {
      if (state.parsed && state.matched) downloadExcel(state.parsed.job, state.matched);
    });
  }

  init();
})();
