/* Check-in, reading the document: shared Check-in state, OCR fallback, currency detection, exchange rates and shipping/freight/packing detection.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { fmt, loadLibs, sb } = FP;

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
    // was instead read via a last-resort low-confidence normaliser (see
    // parseGreedyTokenDocument / parseLayoutlessStandardizedRows below).
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
  // Detects the document's currency, most certain evidence first:
  //  1. a written code or a code-marked symbol -- USD, AUD, US$, A$, AU$...
  //     (most frequent wins, as before);
  //  2. a bare "$" with country details elsewhere on the document -- an ABN,
  //     "Pty Ltd", "Australia" or a .com.au address means AUD; "United
  //     States"/"USA"/"U.S." means USD;
  //  3. a bare "$" with no such details -> AUD automatically. Verified on
  //     real documents: Freedom Screens of Australia's "$"-only Zipline/ZL2
  //     order forms carry exactly the prices of their AUD quotes/proformas
  //     (e.g. ZL2 Drawbar Cap ASSEM $23.11 on both, 19/03/2024). Shown on
  //     screen with a USD/AUD switch preselected for the rare correction --
  //     nobody has to act, and it's never treated as AED.
  //  Nothing at all -> AED.
  const DOLLAR_AMOUNT_RE = /(^|[^A-Za-z])\$\s?\d/;
  // Australia-only markers. GST is deliberately not one (India, Singapore and
  // NZ charge GST too -- Freedom also ships from India).
  const AUD_CONTEXT_RE = /\b(Australia|A\.?B\.?N\.?|Pty\.?\s*Ltd|NSW|QLD|Queensland|New South Wales)\b|\.com\.au\b/i;
  const USD_CONTEXT_RE = /\b(United States|U\.S\.A\.?|USA)\b/;
  function detectDocumentCurrencyInfo(text) {
    const counts = {};
    const add = (cur) => { counts[cur] = (counts[cur] || 0) + 1; };
    const codeRe = new RegExp(`\\b(${SUPPORTED_CURRENCIES.join("|")})\\b`, "g");
    let m;
    while ((m = codeRe.exec(text)) !== null) add(m[1]);
    const symbolRe = /\b(US|AU|A)\$/g;
    while ((m = symbolRe.exec(text)) !== null) add(m[1] === "US" ? "USD" : "AUD");
    let best = null, bestCount = 0;
    for (const [cur, n] of Object.entries(counts)) {
      if (n > bestCount) { best = cur; bestCount = n; }
    }
    if (best) return { currency: best, basis: "stated", needsChoice: false };
    if (DOLLAR_AMOUNT_RE.test(text)) {
      const aud = AUD_CONTEXT_RE.test(text), usd = USD_CONTEXT_RE.test(text);
      if (aud && !usd) return { currency: "AUD", basis: "dollar-australian-details", needsChoice: false };
      if (usd && !aud) return { currency: "USD", basis: "dollar-us-details", needsChoice: false };
      return { currency: "AUD", basis: "dollar-default-aud", needsChoice: false };
    }
    return { currency: "AED", basis: "none", needsChoice: false };
  }
  function detectDocumentCurrency(text) {
    return detectDocumentCurrencyInfo(text).currency || "AED";
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
  // Column headings that can contain a shipping word without describing an
  // actual charge. These are excluded from the wrapped-line OCR fallback
  // below, where looking ahead for a number would otherwise be too broad.
  const SHIPPING_HEADER_RE = /\b(qty|quantity|unit|price|rate|tax|amount|total)\b/i;
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
      // OCR often splits one visual table row into several lines. The real
      // Freedom Screens packing-charge sample becomes:
      //   Additional Packing charges (in
      //   1
      //   crate) 998540 1.00 59.00 No 59.00
      // Join at most the next two non-empty fragments when the first line is
      // a short charge label. The header guard prevents phrases such as
      // "Tax Rate Price Freight" from borrowing an unrelated amount below.
      const labelWordCount = line.split(/\s+/).length;
      if (labelWordCount <= 8 && !SHIPPING_HEADER_RE.test(line)) {
        const fragments = [];
        for (let j = i + 1; j < rawLines.length && fragments.length < 2; j++) {
          const fragment = rawLines[j].trim();
          if (fragment) fragments.push(fragment);
        }
        const wrapped = [line, ...fragments].join(" ");
        if (!NOT_SHIPPING_RE.test(wrapped) && !ITEM_ROW_SHAPE_RE.test(wrapped)) {
          const wm = lastMoneyMatch(stripDates(wrapped));
          if (wm) {
            const amt = parseFloat(wm[1].replace(/,/g, ""));
            if (amt > 0) candidates.push({ label: wrapped, amount: amt });
            continue;
          }
        }
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
    // Last resort, only when nothing above matched: a bare "Packing 120" /
    // "Freight: 85" at the very end of a line, with a plain number (Freedom
    // Screens India's proforma prints "Validity Of Pi is 30 days  Packing  120").
    if (!candidates.length) {
      for (const raw of rawLines) {
        const m = raw.trim().match(/\b(packing|freight|shipping)(?:\s+charges?)?\s*:?\s+([\d,]+(?:\.\d{1,3})?)\s*$/i);
        if (!m || NOT_SHIPPING_RE.test(raw) || ITEM_ROW_SHAPE_RE.test(raw)) continue;
        const amt = parseFloat(m[2].replace(/,/g, ""));
        if (amt > 0) candidates.push({ label: `${m[1]} ${m[2]}`, amount: amt });
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

  function genericUnitMoney(n, code, unit) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return `${code} ` + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ` / ${unit}`;
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { CHECKIN_FN_URL, RATE_SOURCE_LABEL, SUPPORTED_CURRENCIES, ciState,
    detectDocumentCurrencyInfo, detectShippingCharge, fetchCheckinExchangeRate, genericMoney,
    genericUnitMoney, loadExchangeRates, ocrPdfPages, textLayerLooksUsable });
})();
