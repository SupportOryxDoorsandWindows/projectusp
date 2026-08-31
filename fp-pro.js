/* FP Pro Optimization tab.
 *
 * Reads an FP Pro optimisation PDF in the browser and lists every item and
 * its required quantity in a clean table. That's it — no inventory, no
 * stock file, no matching against an item list, no deduction. This is a
 * demo-focused feature so the user can show the meeting how accurately
 * the tool extracts the numbers straight out of the PDF.
 *
 * pdf.js is lazy-loaded from a CDN the first time the tab is opened, so
 * the main app pays no cost when the tab is not used. */

(function () {
  const $ = (s) => document.querySelector(s);

  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

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
  const state = { pdfFile: null };

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
  //   Fittings — same code + unit are summed (rare but possible dupes)
  //   Bars     — same code + bar-length are summed; different bar lengths for
  //              the same code stay as separate rows (they're different SKUs).
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

  /* --------------------------- Render ------------------------ */

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Math.round(n * 100) / 100;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function render(job, entries) {
    const fittings = entries.filter((e) => e.kind === "fitting");
    const bars = entries.filter((e) => e.kind === "bar");

    const jobLine = (job.ref || job.user || job.description)
      ? `<p class="fp-jobline">Job <b>${esc(job.ref || "—")}</b>
          ${job.user ? ` · User ${esc(job.user)}` : ""}
          ${job.description ? ` · ${esc(job.description)}` : ""}
        </p>`
      : "";

    const fitRows = fittings.map((r) => `
      <tr>
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.description)}</td>
        <td class="num">${fmt(r.qty)}</td>
        <td>${esc(r.unit)}</td>
      </tr>`).join("");

    const barRows = bars.map((r) => `
      <tr>
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.description)}</td>
        <td class="num">${r.bars} × ${r.barLenMm}</td>
        <td>mm</td>
      </tr>`).join("");

    $("#fpOut").innerHTML = `
      ${jobLine}

      ${fittings.length ? `<div class="fp-section-h">Fittings &amp; gaskets — ${fittings.length} item${fittings.length === 1 ? "" : "s"}</div>
        <div class="fp-scroll">
          <table class="fp-table">
            <thead><tr>
              <th>Item Code</th><th>Description</th>
              <th class="num">Quantity</th><th>Unit</th>
            </tr></thead>
            <tbody>${fitRows}</tbody>
          </table>
        </div>` : ""}

      ${bars.length ? `<div class="fp-section-h">Bars &amp; profiles — ${bars.length} entr${bars.length === 1 ? "y" : "ies"}</div>
        <div class="fp-scroll">
          <table class="fp-table">
            <thead><tr>
              <th>Item Code</th><th>Description</th>
              <th class="num">Quantity</th><th>Unit</th>
            </tr></thead>
            <tbody>${barRows}</tbody>
          </table>
        </div>` : ""}

      ${entries.length === 0 ? `<p class="small muted">The PDF was read but no fittings or bars were recognised — is it an FP Pro optimisation report?</p>` : ""}
    `;
  }

  /* --------------------------- Wire-up ----------------------- */

  function status(text, kind) {
    const el = $("#fpStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  async function extract() {
    if (!state.pdfFile) return;
    const btn = $("#fpExtract");
    btn.disabled = true;
    status("Reading the PDF…");
    try {
      const text = await extractPdfText(state.pdfFile);
      const job = parseJobHeader(text);
      const entries = parsePdf(text);
      render(job, entries);
      const fittings = entries.filter((e) => e.kind === "fitting").length;
      const bars = entries.filter((e) => e.kind === "bar").length;
      status(`Extracted — ${fittings} fitting${fittings === 1 ? "" : "s"} and ${bars} bar entr${bars === 1 ? "y" : "ies"}.`);
    } catch (err) {
      console.error(err);
      status("Could not read the PDF: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function resetAll() {
    state.pdfFile = null;
    $("#fpPdf").value = "";
    $("#fpPdfName").textContent = "Click or drop the PDF file here";
    $("#fpDrop").classList.remove("ready");
    $("#fpOut").innerHTML = "";
    $("#fpExtract").disabled = true;
    status("");
  }

  function wireDrop() {
    const drop = $("#fpDrop");
    const input = $("#fpPdf");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        input.files = e.dataTransfer.files;
        input.dispatchEvent(new Event("change"));
      }
    });
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      state.pdfFile = f;
      $("#fpPdfName").textContent = f.name;
      drop.classList.add("ready");
      $("#fpExtract").disabled = false;
    });
  }

  function init() {
    if (!$("#fpExtract")) { setTimeout(init, 50); return; }
    wireDrop();
    $("#fpExtract").addEventListener("click", extract);
    $("#fpReset").addEventListener("click", resetAll);
  }

  init();
})();
