/* FP Pro Optimization tab + Master Inventory view -- shared part (fp-core.js).
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
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  // The stock screens are split over several files (boot.js FP_FILES, loaded
  // in that order). Each file ends by adding the names other files use to
  // FP (window.ORYX_FP); a later file takes them at its top, and an earlier
  // file reads FP.name when it runs (by then every file has loaded).

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
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
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

  // An outage or gateway error returns an HTML page, not JSON -- say so
  // plainly instead of showing the browser's "Unexpected token" message.
  async function readFnJson(res) {
    try {
      return await res.json();
    } catch {
      throw new Error(`The server didn't answer properly (HTTP ${res.status}). Check the Transaction History before trying again.`);
    }
  }

  // The signed-in client from boot.js (falls back to a plain one in tests).
  const sb = window.ORYX_AUTH ? window.ORYX_AUTH.sb : window.supabase.createClient(window.ORYX_CONFIG.supabaseUrl, window.ORYX_CONFIG.supabaseKey);
  // Edge Functions only accept signed-in staff: send the person's own token.
  async function fnHeaders() {
    if (window.ORYX_AUTH) return window.ORYX_AUTH.fnHeaders();
    return { "Content-Type": "application/json", "Authorization": "Bearer " + window.ORYX_CONFIG.supabaseKey, "apikey": window.ORYX_CONFIG.supabaseKey };
  }
  // Confirm sends the original PDF along with the lines (multipart) so the
  // server keeps it with the transaction -- after the stock is saved, never
  // instead of it. No PDF (hand entry) or over 25 MB: the same JSON as before.
  const DOC_MAX_BYTES = 25 * 1024 * 1024;
  async function confirmRequest(payload, file) {
    const headers = await fnHeaders();
    if (!file || file.size > DOC_MAX_BYTES) return { method: "POST", headers, body: JSON.stringify(payload) };
    delete headers["Content-Type"]; // the browser sets the multipart boundary
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    form.append("document", file, file.name);
    return { method: "POST", headers, body: form };
  }

  // The line under "Check-out/Check-in confirmed" about the original PDF.
  // Not kept -> says why and offers "Try again" with the same file.
  function keptDocNote(answer, file, hash, kind) {
    if (!file) return "";
    const what = kind === "check_in" ? "Check-in" : "Check-out";
    if (file.size > DOC_MAX_BYTES) {
      return `<p class="small doc-note warn">The original PDF is over 25 MB, so it wasn't kept with this ${what}.</p>`;
    }
    const doc = answer && answer.document;
    if (doc && doc.saved) {
      return `<p class="small doc-note ok">The original PDF is kept with this ${what}. Open it from Activity, the Transaction History or an item's history.</p>`;
    }
    if (!doc) return "";
    const why = window.ORYX_DOCS ? window.ORYX_DOCS.reason(doc.error, doc.detail) : doc.error;
    return `<p class="small doc-note warn" data-doc-retry-wrap>The stock is saved, but the original PDF wasn't kept (${esc(why)}).
      <button type="button" class="doc-btn" data-doc-retry>Try again</button> <span class="doc-msg" role="status"></span></p>`;
  }
  function wireDocRetry(container, kind, file, hash) {
    const btn = container.querySelector("[data-doc-retry]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const msg = container.querySelector("[data-doc-retry-wrap] .doc-msg");
      if (!window.ORYX_DOCS) { msg.textContent = "Reload the page and try again."; return; }
      btn.disabled = true; msg.textContent = "Keeping the PDF…";
      try {
        await window.ORYX_DOCS.attach(kind, file, hash);
        container.querySelector("[data-doc-retry-wrap]").outerHTML = keptDocNote({ document: { saved: true } }, file, hash, kind);
      } catch (err) {
        msg.textContent = "Still not kept: " + err.message + ".";
        btn.disabled = false;
      }
    });
  }

  // Delete permission (Admin, or Allow Delete). The server checks again.
  const canDeleteLines = () => !window.ORYX_AUTH || window.ORYX_AUTH.canDelete();
  const deleteBtnAttrs = () => canDeleteLines()
    ? ""
    : ` aria-disabled="true" title="You don't have permission to delete this record. Please contact an administrator."`;

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
    // confirming: a Confirm is in flight; done: this preview was saved.
    // Either one keeps Confirm locked so the same entry can't be sent twice.
    confirming: false,
    done: false,
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
    // Each text fragment's position, kept alongside the plain text (as
    // pages.items) so a reader can re-attach a fragment the PDF stores out
    // of order -- e.g. Freedom's "50 white /25 black" colour-split notes,
    // which sit on their item's line but come last in the text stream.
    const itemsPerPage = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      itemsPerPage.push(content.items
        .filter((it) => it.transform && it.str && it.str.trim())
        .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5],
          // Horizontal text only: the header reader pairs a label with the
          // value printed to its right, which means nothing on a rotated page.
          upright: it.transform[0] > 0 && !it.transform[1] && !it.transform[2] })));
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
    pages.items = itemsPerPage;
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

  // OCR-tolerant, punctuation/casing-insensitive tokens. Digits that are
  // commonly misread for a look-alike letter (0/O, 1/I, 5/S, 8/B) are
  // canonicalised within each token -- this only ever remaps characters
  // inside a token, never merges or splits tokens, so it can't turn two
  // genuinely different words into the same one; it only forgives the exact
  // handful of OCR mix-ups it's meant to.
  const OCR_DIGIT_TO_LETTER = { 0: "O", 1: "I", 5: "S", 8: "B" };
  // Supplier spellings normalised to Master Inventory's, on BOTH sides:
  // White/Black -> WHT/BLK, "(L)"/"(R)" -> LEFT/RIGHT, and a size glued to
  // its side letter ("60A") split into "60 A".
  function normaliseForMatch(text) {
    return String(text || "")
      .replace(/\(\s*L\s*\)/gi, " LEFT ")
      .replace(/\(\s*R\s*\)/gi, " RIGHT ")
      .replace(/\bwhite\b/gi, "WHT")
      .replace(/\bblack\b/gi, "BLK")
      .replace(/\b(\d{2,3})([AB])\b/g, "$1 $2");
  }
  function tokenizeForMatch(text, raw) {
    const tokens = normaliseForMatch(text)
      .toUpperCase()
      .replace(/\bMETRES?\b/g, "M")
      .split(/[^A-Z0-9]+/)
      .filter(Boolean);
    return raw ? tokens : tokens.map((tok) => tok.replace(/[0158]/g, (c) => OCR_DIGIT_TO_LETTER[c]));
  }

  // Master's own product-name words -- the ones that must all be present
  // somewhere in the invoice's description for this to be the same product.
  // Two things are stripped here, and ONLY here (never from the invoice's
  // side): Master Inventory's own leading code ("39999R-Bug Fur...",
  // "230052: ...") -- a real item code, not a product word -- and a
  // trailing "AB", Master's own "both sides, one record" convention (e.g.
  // "ZLS1 Brake Arm AB") that a supplier line rarely repeats. The dash-code
  // strip must never run on invoice text: a supplier line like "ZLS1-Brake
  // Arm" uses that same dash to join a genuine product-family word (ZLS1) to
  // the rest of the name, not to prefix a database id. Nothing else is
  // dropped from Master's words: a bare size number (the "60"/"70"/"80"/
  // "100" that distinguishes otherwise-identical End Cap variants) or a
  // side/colour word (A/B, BLK/WHT, Left/Right) stays required, so two
  // genuinely different Master Inventory records can never collapse onto
  // each other.
  function masterCoreTokens(description, raw) {
    const withoutOwnCode = String(description || "").replace(/^[a-z0-9]*\d[a-z0-9]*\s*[-:]\s*/i, "");
    // "AB" is Master's "both sides, one record" marker wherever it appears
    // ("ZLS1 Brake Arm AB", "ZLS1 Handle Mount AB WHT") -- suppliers rarely
    // print it, so it's never a required word.
    return tokenizeForMatch(withoutOwnCode, raw).filter((t) => t !== "AB");
  }

  // A code that's missing, truncated, or simply wrong can still be resolved
  // from the description alone -- but only when Master's own core words are
  // ALL present somewhere in the invoice's description. The invoice is
  // allowed extra words on top (a supplier's own line number, "01"/"02", a
  // colour note, its own reference code) -- those never block a match, the
  // same way a human skimming the line would ignore them. What's never
  // allowed is the reverse: a Master word that simply isn't there is never
  // assumed. Requires at least 2 core words (a single generic word like
  // "Screw" is too broad to trust alone) and, same as before, never guesses
  // between more than one equally-good candidate.
  //
  // seriesTolerantPass is the looser pass behind findSeriesSuggestion(): a
  // product-family word may appear with or without its series number on
  // either side -- Master's "ZLS Brake Spring" against a supplier's
  // "ZLS1-Brake Spring 01", or Master's "ZLS1 Handle Bush" against "ZLS
  // Handle Bush". Two DIFFERENT series numbers (ZLS1 vs ZLS2, SMB1 vs SMB2)
  // are never treated as the same word, and every other word, size and
  // colour still has to be there, with exactly one candidate.
  function findUniqueDescriptionItem(itemsByCode, description, seriesTolerantPass) {
    const invoiceTokens = new Set(tokenizeForMatch(description));
    if (!invoiceTokens.size) return null;
    const invoiceRaw = new Set(tokenizeForMatch(description, true));
    const invoiceSeriesBase = new Set();
    for (const tok of invoiceRaw) {
      const m = tok.match(/^([A-Z]{2,})\d{1,2}$/);
      if (m) invoiceSeriesBase.add(m[1]);
    }

    function seriesTolerant(tok, rawTok) {
      if (invoiceTokens.has(tok)) return true;
      // Master has the bare family word, the invoice adds a series number.
      if (/^[A-Z]{2,}$/.test(rawTok) && invoiceSeriesBase.has(rawTok)) return true;
      // Master has the series number, the invoice has the bare family word.
      const m = rawTok.match(/^([A-Z]{2,})\d{1,2}$/);
      return !!m && invoiceRaw.has(m[1]) && !invoiceSeriesBase.has(m[1]);
    }

    // A shared part names several families ("ZLS1 ZLS2 Magnet AB"): the
    // invoice naming ANY one of them is enough. A part naming one family
    // still needs that family, exactly as before.
    function familyGroupOk(coreRaw, test, core) {
      const fam = coreRaw.map((t, k) => (/^[A-Z]{2,}\d{1,2}$/.test(t) ? k : -1)).filter((k) => k >= 0);
      if (fam.length < 2) return { ok: true, skip: new Set() };
      return { ok: fam.some((k) => test(core[k], coreRaw[k])), skip: new Set(fam) };
    }

    function uniqueMatch(test) {
      const matches = [];
      for (const candidates of itemsByCode.values()) {
        for (const candidate of candidates) {
          const core = masterCoreTokens(candidate.description);
          if (core.length < 2) continue;
          const coreRaw = masterCoreTokens(candidate.description, true);
          const fam = familyGroupOk(coreRaw, test, core);
          if (!fam.ok) continue;
          if (!core.every((tok, k) => fam.skip.has(k) || test(tok, coreRaw[k]))) continue;
          // Specificity: how many of the item's own words the invoice line
          // actually contains (optional MILL counts only when printed).
          const score = core.filter((tok) => invoiceTokens.has(tok)).length;
          matches.push({ candidate, score });
        }
      }
      const unique = matches.filter((mm, idx) => matches.findIndex((o) => o.candidate.id === mm.candidate.id) === idx);
      if (unique.length === 1) return unique[0].candidate;
      if (!unique.length) return null;
      // Most specific wins: when every one of several items' words is on the
      // invoice line, the item that accounts for MORE of the line's words is
      // the line's product -- "SMB1 Brake Spring" over "SMB1 Brake", "ZLS1
      // Track Guide A" over "ZLS1 Track 01". A tie (e.g. BLK and WHT
      // variants when the line names no colour) still matches nothing.
      const top = Math.max(...unique.map((mm) => mm.score));
      const best = unique.filter((mm) => mm.score === top);
      return best.length === 1 ? best[0].candidate : false;
    }

    // "MILL" is Master's default finish -- invoices for mill-finish parts
    // rarely print it, so it's never required (a coloured variant still has
    // its own BLK/WHT word, which IS required).
    return uniqueMatch(seriesTolerantPass ? seriesTolerant : (tok) => tok === "MILL" || invoiceTokens.has(tok)) || null;
  }

  // Never auto-applied: whether "ZLS1-Brake Spring 01" really is Master's
  // "ZLS Brake Spring" is a stock decision, so a series-tolerant match is
  // only offered to the person doing the Check-in as a one-click
  // suggestion. Only consulted once the strict match has found nothing.
  // Master Inventory sometimes keeps two supplier parts as ONE item and
  // writes the second code into the name, e.g. 230031 "SMB1 Slide Bolt
  // BLK-230033-SMB1 Slide Lock BLK". An invoice line coded 230033 then has
  // no Master row of its own; this offers that combined item as a
  // "Possible match" (never auto-applied -- whether the lock is counted
  // separately from the bolt is the stock team's call). One item only.
  function findEmbeddedCodeSuggestion(itemsByCode, code) {
    const c = String(code || "").trim();
    if (!/^[A-Za-z0-9]{5,}$/.test(c)) return null;
    const re = new RegExp(`(^|[^A-Za-z0-9])${c}([^A-Za-z0-9]|$)`, "i");
    const hits = new Map();
    for (const list of itemsByCode.values()) {
      for (const it of list) {
        if (String(it.item_code || "").toUpperCase() !== c.toUpperCase() && re.test(it.description || "")) hits.set(it.item_code, it);
      }
    }
    if (hits.size !== 1) return null;
    const item = [...hits.values()][0];
    // A code with one row per bar length can't be resolved from the name.
    if ((itemsByCode.get(item.item_code) || []).length > 1) return null;
    return { item, note: `Master Inventory lists code ${c} inside this item's name — the two parts are kept as one item there. Check before using it.` };
  }

  function findSeriesSuggestion(itemsByCode, description) {
    if (!description) return null;
    const item = findUniqueDescriptionItem(itemsByCode, description, true);
    if (item) return { item, note: "Same words, but the series number differs (e.g. ZLS vs ZLS1)." };
    return findCloseSuggestion(itemsByCode, description) || findSizeSuggestion(itemsByCode, description);
  }

  // --- Sizes stated on an invoice line (metres) ---------------------------
  // Roll LENGTH only when the line clearly states one: feet "9' x 100'"
  // (the second figure), a bracketed "(25mtrs roll)" / "(125m)", or
  // "50 mtrs roll". Never a width ("3m wide roll" is a width).
  const FEET_DIMS_RE = /(\d+(?:\.\d+)?)\s*['\u2032]\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*['\u2032]/i;
  const METRE_UNIT = "(?:m|mtrs?|meters?|metres?)";
  function invoiceRollLengthM(text) {
    const t = String(text || "");
    const ft = t.match(FEET_DIMS_RE);
    if (ft) return Math.round(parseFloat(ft[2]) * 0.3048 * 100) / 100;
    const br = t.match(new RegExp(`\\(\\s*(\\d+(?:\\.\\d+)?)\\s*${METRE_UNIT}\\b[^)]*\\)`, "i"));
    if (br) return parseFloat(br[1]);
    const rl = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${METRE_UNIT}\\s+rolls?\\b`, "i"));
    return rl ? parseFloat(rl[1]) : null;
  }
  // "3m wide" is a width, never a length -- removed before any length
  // token is read from a line ("Paw Lite Mesh 3m wide roll" is not a 3 m roll).
  function withoutWidths(text) {
    return String(text || "").replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*${METRE_UNIT}\\s+wide\\b`, "gi"), " ");
  }
  // Roll lengths the supplier doesn't print but the stock team confirmed.
  // Only ever a prefilled, editable value in the New item form -- never
  // applied without a person seeing it.
  const KNOWN_ROLL_LENGTHS_M = [
    { re: /\bpaw\s*-?\s*lite\b/i, metres: 30 }, // Paw Lite Mesh: "usually 30m" (Oct 2026)
  ];
  function knownRollLengthM(text) {
    const hit = KNOWN_ROLL_LENGTHS_M.find((k) => k.re.test(String(text || "")));
    return hit ? hit.metres : null;
  }
  // A line the supplier counts in rolls whose length isn't converted yet.
  function ciIsUnconvertedRollLine(r) {
    if (r.packageInfo) return false;
    return /\b(rolls?|coils?|reels?)\b/i.test(`${r.unit || ""} ${r.description || ""} ${(r.source && r.source.description) || ""}`);
  }

  // Width: the first figure of feet "9' x 100'", or "3m wide"; on a Master
  // description, a metre figure OUTSIDE brackets ("Patio Mesh 2.7m (30M)").
  function invoiceWidthM(text) {
    const t = String(text || "");
    const ft = t.match(FEET_DIMS_RE);
    if (ft) return Math.round(parseFloat(ft[1]) * 0.3048 * 100) / 100;
    const w = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${METRE_UNIT}\\s+wide\\b`, "i"));
    return w ? parseFloat(w[1]) : null;
  }
  function masterWidthM(description) {
    const outside = String(description || "").replace(/\([^()]*\)/g, " ");
    const m = outside.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    return m ? parseFloat(m[1]) : null;
  }
  const mmSizes = (t) => [...String(t || "").matchAll(/(\d+(?:\.\d+)?)\s*mm\b/gi)].map((m) => parseFloat(m[1]));

  // Third suggestion pass -- same product, sizes written differently (feet vs
  // metres) or a different roll size. E.g. Freedom India's "Phifer Fiberglass
  // Pool and Patio Screen 9' x 100'" -> Master "Patio Mesh 2.7m (30M)"
  // (9 ft = 2.74 m wide), or "ZLS1- Magnet-01 (25mtrs roll)" -> Master's
  // 200 m roll magnet. Never applied by itself. Required:
  //  - a product word in common, covering at least half of the Master item's
  //    own product words;
  //  - no product-family conflict (ZLS1 vs SMB1 / ZL2 ...);
  //  - no colour or side conflict;
  //  - widths within 0.1 m and every "mm" size equal when both sides state
  //    one (8mm vs 12mm Bug Fur, 11 ft = 3.35 m vs 3.2 m -> nothing);
  //  - a single best candidate.
  // A different roll LENGTH is allowed but spelled out in the note.
  const SIZE_STOP_WORDS = new Set(["ROLL", "ROLLS", "WIDE", "LENGTH", "ONLY", "WITH", "SHEET", "PER", "MILL", "LEFT", "RIGHT", "AND", "FROM", "ASSEM", "SCREEN", "FIBERGLASS", "FIBREGLASS",
    "THE", "FOR", "PCS", "NOS", "SET", "MTR", "MTRS", "BLK", "WHT", "STR", "CNR", "OFF", "NEW", "OLD"]);
  function productWords(text) {
    return closeTokens(String(text || "").replace(/\([^()]*\)/g, " "))
      .filter((t) => /^[A-Z]{3,}$/.test(t) && !SIZE_STOP_WORDS.has(t) && !PRODUCT_FAMILIES.has(t));
  }
  function findSizeSuggestion(itemsByCode, description) {
    const inv = new Set(closeTokens(description));
    const invWords = new Set(productWords(description));
    if (!invWords.size) return null;
    // Family tokens as written (ZLS1, SMB2, ZL2...): same family and series,
    // or one side bare (ZLS = ZLS1) -- never ZLS1 vs ZLS2.
    const famTokens = (set) => [...set].filter((t) => { const b = familyBase(t); return b && (PRODUCT_FAMILIES.has(b) || /\d$/.test(t)); });
    const sameSeries = (a, b) => familyBase(a) === familyBase(b) && (a === b || a === familyBase(a) || b === familyBase(b));
    const invFamilies = famTokens(inv);
    const invColour = ["BLK", "WHT"].filter((c) => inv.has(c));
    const invSide = ["LEFT", "RIGHT"].filter((c) => inv.has(c));
    const invWidth = invoiceWidthM(description);
    const invRoll = invoiceRollLengthM(description);
    const invMm = mmSizes(description);
    let best = null, tie = false;
    for (const candidates of itemsByCode.values()) {
      for (const c of candidates) {
        const desc = String(c.description || "").replace(/^[a-z0-9]*\d[a-z0-9]*\s*[-:]\s*/i, "");
        const words = [...new Set(productWords(desc))];
        if (!words.length) continue;
        const shared = words.filter((w) => invWords.has(w));
        if (!shared.length || shared.length * 2 < words.length) continue;
        const mt = new Set(closeTokens(desc));
        const masterFamilies = famTokens(mt);
        if (invFamilies.length && !invFamilies.some((f) => masterFamilies.some((m) => sameSeries(f, m)))) continue;
        if (invFamilies.length && masterFamilies.some((m) => !invFamilies.some((f) => sameSeries(f, m))) && masterFamilies.length === 1) continue;
        if (!invFamilies.length && masterFamilies.length) {
          // A family-specific Master part needs the line to name that family.
          continue;
        }
        if (invColour.length && ["BLK", "WHT"].some((col) => mt.has(col) && !invColour.includes(col))) continue;
        if (invSide.length && ["LEFT", "RIGHT"].some((sd) => mt.has(sd) && !invSide.includes(sd))) continue;
        if (!invColour.length && (mt.has("BLK") || mt.has("WHT"))) continue; // colour unknown -> no guess
        const mWidth = masterWidthM(desc);
        if (invWidth != null && mWidth != null && Math.abs(invWidth - mWidth) > 0.1) continue;
        const mMm = mmSizes(desc);
        if (invMm.length && mMm.length && !invMm.every((v) => mMm.includes(v))) continue;
        // Evidence it's the same product: every one of the Master item's
        // product words is on the line, OR the sizes back it up (same width,
        // or a roll length stated on both). "Handle Mount" vs "Handle Bush"
        // shares a word but has neither -> nothing.
        const sizeEvidence = (invWidth != null && mWidth != null) || (invRoll != null && parseBundleLengthM(c.description) != null);
        if (shared.length < words.length && !sizeEvidence) continue;
        const score = shared.length * 10 + (invWidth != null && mWidth != null ? 5 : 0);
        if (!best || score > best.score) { best = { item: c, score, mWidth, mRoll: parseBundleLengthM(c.description) }; tie = false; }
        else if (score === best.score && best.item.id !== c.id) tie = true;
      }
    }
    if (!best || tie) return null;
    const bits = [];
    if (invWidth != null && best.mWidth != null) bits.push(`width ${invWidth} m on the invoice vs ${best.mWidth} m in Master`);
    if (invRoll != null && best.mRoll != null) {
      bits.push(Math.abs(invRoll - best.mRoll) <= best.mRoll * 0.02
        ? `roll length ${invRoll} m ≈ ${best.mRoll} m`
        : `roll size differs — invoice ${invRoll} m, Master ${best.mRoll} m; stock is added in metres (rolls × ${invRoll} m)`);
    }
    return {
      item: best.item,
      note: `Similar product, written differently${bits.length ? ` (${bits.join("; ")})` : ""}. Check it's the same item.`,
    };
  }

  // Second suggestion pass, for supplier names that use a different product
  // word from Master Inventory -- e.g. Freedom's "ZLS1-Infinity 60mm-IS(
  // 2.9m)Mill" for Master's "ZLS1 Housing 60 IS 01 MILL" (2900 mm). Like
  // the series pass it is only ever a suggestion. What must still agree:
  //   - family (ZLS1/SMB1/...; ZLS = ZLS1, never ZLS1 vs ZLS2), unless the
  //     invoice names no family at all;
  //   - every size number and every side/colour/finish word (IS/OS, A/B,
  //     BLK/WHT, MILL, LEFT/RIGHT);
  //   - the bar/roll length, when the invoice states one ("2.9m") and the
  //     Master row has a bar length -- this picks the exact length row.
  // At most ONE other Master word may be missing (Housing vs Infinity), a
  // bare version number ("01") is ignored, and the best-scoring candidate
  // must be unique -- a tie suggests nothing.
  const CLOSE_REQUIRED_WORDS = new Set(["IS", "OS", "A", "B", "BLK", "WHT", "BLACK", "WHITE", "MILL", "LEFT", "RIGHT", "STR", "CNR"]);
  const CLOSE_WORD_ALIASES = { BLACK: "BLK", WHITE: "WHT" };
  // Product-family words, with or without a series number (ZLS / ZLS1).
  // Two different families are never suggested for each other.
  const PRODUCT_FAMILIES = new Set(["SMB", "ZLS", "ZLX", "IZLX", "RADC"]);
  function familyBase(tok) {
    const base = tok.replace(/\d{1,2}$/, "");
    return PRODUCT_FAMILIES.has(base) || /^[A-Z]{2,}\d{1,2}$/.test(tok) ? base : null;
  }
  function closeTokens(text) {
    return String(text || "")
      .toUpperCase()
      .replace(/\b(\d+)\s*MM\b/g, "$1")
      .split(/[^A-Z0-9]+/)
      .filter(Boolean)
      .map((t) => CLOSE_WORD_ALIASES[t] || t);
  }
  function statedLengthMm(text) {
    const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*m(?![a-z])/i);
    return m ? Math.round(parseFloat(m[1]) * 1000) : null;
  }
  function findCloseSuggestion(itemsByCode, description) {
    const invLen = statedLengthMm(description);
    const inv = new Set(closeTokens(String(description).replace(/(\d+(?:\.\d+)?)\s*m(?![a-z])/ig, " ")));
    const invFamilies = [...inv].filter((t) => familyBase(t) && PRODUCT_FAMILIES.has(familyBase(t)) || /^[A-Z]{2,}\d{1,2}$/.test(t));
    let best = null, tie = false;
    for (const candidates of itemsByCode.values()) {
      for (const c of candidates) {
        if (invLen != null && c.bar_length_mm != null && Math.abs(c.bar_length_mm - invLen) > 50) continue;
        // Never guess which length row is meant when the invoice states none.
        if (invLen == null && candidates.length > 1 && candidates.some((o) => o.bar_length_mm !== c.bar_length_mm)) continue;
        const own = String(c.description || "").replace(/^[a-z0-9]*\d[a-z0-9]*\s*[-:]\s*/i, "");
        const master = closeTokens(own.replace(/(\d+(?:\.\d+)?)\s*m(?![a-z])/ig, " ")).filter((t) => !/^0\d$/.test(t) && t !== "AB"); // "AB" = Master's both-sides marker, rarely printed by suppliers
        let matched = 0, missingWords = 0, ok = true;
        const masterFamilies = master.filter((t) => familyBase(t) && (PRODUCT_FAMILIES.has(familyBase(t)) || /\d$/.test(t)));
        // Invoice names a family the Master item doesn't carry -> a different product line.
        if (invFamilies.length && !invFamilies.every((f) => masterFamilies.some((t) => familyBase(t) === familyBase(f)))) continue;
        for (const t of master) {
          if (inv.has(t)) { matched++; continue; }
          if (masterFamilies.includes(t)) {
            const base = familyBase(t);
            // Same series, or one side bare (ZLS = ZLS1) -- never ZLS1 vs ZLS2.
            const sameSeries = invFamilies.some((f) => familyBase(f) === base && (f === base || t === base || f === t));
            if (sameSeries) { matched++; continue; }
            if (invFamilies.length) { ok = false; break; } // a different family on the invoice
            continue; // invoice names no family at all
          }
          if (/\d/.test(t) || CLOSE_REQUIRED_WORDS.has(t)) { ok = false; break; }
          missingWords++;
          if (missingWords > 1) { ok = false; break; }
        }
        if (!ok || matched < 3) continue;
        const score = matched - missingWords;
        if (!best || score > best.score) { best = { item: c, score, missingWords }; tie = false; }
        else if (score === best.score && best.item.id !== c.id) tie = true;
      }
    }
    if (!best || tie) return null;
    const lenNote = invLen != null && best.item.bar_length_mm != null ? ` Bar length ${best.item.bar_length_mm} mm matches the invoice.` : "";
    return {
      item: best.item,
      note: (best.missingWords ? "The product name differs from Master Inventory's, but family, size, side and finish agree." : "Close match on family, size, side and finish.") + lenNote,
    };
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

  // Items the job list gives in metres (fittings section, "2.63 m") while
  // Master counts whole bars: the metres become bars of the item's own
  // bar_length_mm, rounded up (2.63 m of 5100 mm bars = 1 bar). Only the
  // items the stock team named (620001, 2026-10-26; not 220002/220003).
  const METRES_TO_BARS_CODES = new Set(["620001"]);
  function metresAsBars(e, item) {
    const barMm = item ? Number(item.bar_length_mm) : 0;
    if (e.kind !== "fitting" || e.unit !== "m" || !(barMm > 0)) return null;
    if (!METRES_TO_BARS_CODES.has(String(item.item_code).toUpperCase())) return null;
    // whole millimetres first, so 10.2 m / 5.1 m is exactly 2, never 3
    return Math.ceil(Math.round(e.qty * 1000) / barMm);
  }

  function buildRows(entries, itemsByCode) {
    const rows = [];
    for (const e of entries) {
      const candidates = lookupExactCode(itemsByCode, e.code);
      const item = pickInventoryRow(e, candidates);

      const asBars = metresAsBars(e, item);
      const requiredQty = e.kind === "bar" ? e.bars : asBars != null ? asBars : e.qty;
      const unit = e.kind === "bar" || asBars != null ? "bars" : e.unit;
      const pdfDetail = e.kind === "bar" ? `${e.bars} × ${e.barLenMm} mm`
        : asBars != null ? `${fmt(e.qty)} m → ${asBars} × ${Math.round(item.bar_length_mm)} mm` : "";
      // what the job list itself asked for, kept for the line after an Edit
      const jobListText = e.kind === "bar" ? pdfDetail : `${fmt(e.qty)} ${e.unit}`;

      if (!item) {
        rows.push({
          kind: e.kind, code: e.code, barLenMm: e.barLenMm,
          description: e.description, pdfDetail, jobListText,
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
        description: item.description || e.description, pdfDetail, jobListText,
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
  function recomputeAfterEdit(row, newCode, newDescription, newQty, newUnit, exactItemId) {
    row.code = newCode;
    row.description = newDescription;
    row.requiredQty = newQty;
    row.unit = newUnit;

    const candidates = state.itemsByCode.get(newCode) || [];
    const item = FP.pickedInventoryRow(state.itemsByCode, newCode, exactItemId, { kind: row.kind, barLenMm: row.barLenMm });

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
    // The person picked this exact row (e.g. 5100 mm for a "2 × 2900 mm"
    // line): say so, and show what is taken now -- the job list's own
    // "2 × 2900 mm" alone read as if the edit had not been kept.
    row.personPicked = !!(exactItemId && item.id === exactItemId);
    const lenMm = Number(item.bar_length_mm) > 0 ? Math.round(item.bar_length_mm) : null;
    const now = lenMm ? `${fmt(newQty)} × ${lenMm} mm` : "";
    if (row.jobListText) {
      row.pdfDetail = now ? `Job list: ${row.jobListText} · Now: ${now}` : `Job list: ${row.jobListText}`;
    } else if (/^Added by hand/.test(row.pdfDetail || "")) {
      row.pdfDetail = ["Added by hand", lenMm ? `${lenMm} mm` : ""].filter(Boolean).join(" · ");
    }
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { $, CHECKOUT_FN_URL, buildRows, metresAsBars, ciIsUnconvertedRollLine, confirmRequest, deleteBtnAttrs,
    esc, extractPdfText, extractPdfTextPerPage, findEmbeddedCodeSuggestion, findSeriesSuggestion,
    findUniqueDescriptionItem, fmt, fnHeaders, invoiceRollLengthM, keptDocNote, knownRollLengthM,
    loadInventoryItems, loadLibs, loadXlsxLib, lookupExactCode, money, normaliseForMatch,
    parseBundleLengthM, parseJobHeader, parseLengthToken, parsePackaging, parsePdf, pdfFingerprint,
    pickInventoryRow, readFnJson, recomputeAfterEdit, sb, state, wireDocRetry, withoutWidths });
})();
