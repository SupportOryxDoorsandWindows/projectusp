/* Check-in, supplier layouts: the fixed-layout readers (Commercial Invoice, quotes / order approvals, Freedom Screens of Australia invoice / quote / Zipline and ZL2 order forms, Freedom Screens India proforma, packing lists).
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});

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

  // "Invoice No:" / "PO No:" / "Your Ref:" and the value printed to the
  // right of it, read by page position. Freedom's quotes and invoices store
  // their header labels and values as separate blocks, so in the plain text
  // the label is followed by other labels and the text-only rules below
  // picked up the wrong words (the "19" of the date after "Quote", the label
  // "PO No" itself). Only horizontal text on the first page; a value must not
  // be another label. Returns {} when no positions are available (OCR).
  const HEADER_INVOICE_LABEL_RE = /^(?:(?:tax\s+|commercial\s+|pro-?forma\s+)?invoice|quote|quotation)(?:\s*(?:no\.?|number|#))?\s*:?$/i;
  const HEADER_PO_LABEL_RE = /^(?:p\.?o\.?|purchase\s+order)\s*(?:no\.?|number|#)\s*:?$|^your\s+ref(?:erence)?\s*:?$/i;
  const HEADER_INVOICE_VALUE_RE = /^[A-Za-z]{0,4}[-\/]?\d[\w\/-]{0,24}$/;
  function headerFieldsFromPositions(pageItems) {
    const items = (pageItems && pageItems[0] || []).filter((it) => it.upright);
    const valueRightOf = (label, ok) => {
      let best = null;
      for (const it of items) {
        const dx = it.x - label.x;
        if (it === label || Math.abs(it.y - label.y) > 4 || dx <= 0 || dx > 260) continue;
        if (/:\s*$/.test(it.str) || !ok(it.str)) continue;
        if (!best || dx < best.x - label.x) best = it;
      }
      return best ? best.str : "";
    };
    const find = (labelRe, ok) => {
      for (const label of items) {
        if (!labelRe.test(label.str)) continue;
        const v = valueRightOf(label, ok);
        if (v) return v;
      }
      return "";
    };
    return {
      invoiceNumber: find(HEADER_INVOICE_LABEL_RE, (v) => HEADER_INVOICE_VALUE_RE.test(v)),
      poNumber: find(HEADER_PO_LABEL_RE, (v) => v.length <= 40 && /[A-Za-z0-9]/.test(v)),
    };
  }

  function parseCheckinHeader(text, pageItems) {
    const placed = headerFieldsFromPositions(pageItems);
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
    // A value read beside its own label (above) wins over every text rule.
    const invoiceNumber = placed.invoiceNumber
      || (text.match(/\b(?:SI|SO|SQ|INV|DN)-\d+\b/i) || [])[0]
      || (text.match(/\bFSI\/[^\s,;]+/i) || [])[0]
      || (text.match(/(?:pro-?forma\s+invoice|commercial\s+invoice|tax\s+invoice|supplier\s+invoice|invoice|quotation|quote|delivery\s+note)\s*#?\s*:?\s*\n?\s*([A-Za-z]{0,4}\d[A-Za-z0-9-]{2,19})\b(?![\/.]\d)/i) || [])[1]
      || "";
    // Strict "PO-1234" first (existing behaviour, unchanged), then a
    // labelled "Your Reference" value, then a looser "PO 1234"/"PO26-1139"
    // mention -- in that order, so a stricter/more-certain match always
    // wins over a broader guess.
    const poNumber = placed.poNumber
      || (text.match(/\bPO-[\w-]+\b/i) || [])[0]
      || ((text.match(/your\s+reference\s*\n?\s*([^\n]{2,40})/i) || [])[1] || "").trim()
      || (text.match(/\bPO[\s-](?=[A-Za-z-]*\d)[A-Za-z0-9-]{2,20}\b/i) || [])[0]
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

  // The same Freedom approval/order spreadsheet has a second text-layer
  // shape in pdf.js: instead of one row per physical line, every table cell
  // arrives on its own line. A row therefore looks like:
  //   134002 / description / Each / Metal / 2 / 2.48 / USD / 400 / 992.00 / USD
  // The first USD closes the unit-price column and the second closes the
  // line-total column. We recover only rows whose arithmetic reconciles,
  // then reconcile their combined totals to the document's printed Total.
  function parseFreedomApprovalCellStream(text) {
    if (!/(?:PART NUMBER|Part code)/i.test(text) || !/QTY SUM/i.test(text) || !/\bUSD\b/i.test(text)) {
      return { entries: [], reconciliation: null };
    }

    const cells = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const codeRe = /^\d{5,6}R?$/i;
    const moneyRe = /^[\d,]+(?:\.\d+)?$/;
    const entries = [];
    const acceptedLineTotals = [];

    function numberAt(value) {
      if (!moneyRe.test(value || "")) return null;
      const n = parseFloat(value.replace(/,/g, ""));
      return isFinite(n) ? n : null;
    }

    const codeIndexes = cells
      .map((cell, idx) => (codeRe.test(cell) ? idx : null))
      .filter((idx) => idx !== null);

    for (let k = 0; k < codeIndexes.length; k++) {
      const start = codeIndexes[k];
      const end = codeIndexes[k + 1] == null ? cells.length : codeIndexes[k + 1];
      const row = cells.slice(start, end);
      const usdIndexes = row
        .map((cell, idx) => (/^USD$/i.test(cell) ? idx : null))
        .filter((idx) => idx !== null);
      if (usdIndexes.length < 2) continue;

      const firstUsd = usdIndexes[0];
      const secondUsd = usdIndexes[1];
      const unitCost = numberAt(row[firstUsd - 1]);
      const lineTotal = numberAt(row[secondUsd - 1]);
      const quantityCells = row.slice(firstUsd + 1, secondUsd - 1)
        .map(numberAt)
        .filter((n) => n != null);
      const qty = quantityCells.length ? quantityCells[quantityCells.length - 1] : null;
      const description = row.slice(1, firstUsd - 1).find((cell) => /[A-Za-z]/.test(cell)) || "";
      if (!(unitCost > 0) || !(qty > 0) || !(lineTotal > 0) || !description) continue;

      const tolerance = Math.max(0.02, lineTotal * 0.001);
      if (Math.abs(qty * unitCost - lineTotal) > tolerance) continue;

      entries.push({ code: row[0], description, qty, unitCost });
      acceptedLineTotals.push(lineTotal);
    }

    let documentTotal = null;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (!/^Total$/i.test(cells[i])) continue;
      const possibleTotal = numberAt(cells[i + 1]);
      if (possibleTotal != null && /^USD$/i.test(cells[i + 2] || "")) {
        documentTotal = possibleTotal;
        break;
      }
    }

    const parsedTotal = acceptedLineTotals.reduce((sum, n) => sum + n, 0);
    const reconciliation = documentTotal == null || !entries.length
      ? null
      : {
          expectedTotal: documentTotal,
          parsedTotal,
          ok: Math.abs(parsedTotal - documentTotal) <= Math.max(0.05, documentTotal * 0.0001),
        };
    return { entries, reconciliation };
  }

  // Freedom "Zipline Component Order Form" (e.g. "SUP -5- ORYX ZIPLINE
  // COMPONENTS 24-04 - FOR APPROVAL.pdf"). pdf.js emits every table cell on
  // its own line:
  //   ZIP49 / ZLS1-Brake Adjuster-01 0.005 kgs / 2 / 3.69 / 200 / n/a / $738.00
  //   (Ref No. / Name / Amt Per Screen / Mill Price / QTY / Colour / Sub Total)
  // The Ref No. (ZIP49) is Freedom's own order-form reference, not an Oryx
  // Master Inventory code, so it's never used as the item code -- rows are
  // matched by description instead. Of the numbers between the name and the
  // Sub Total, a row is only read when exactly one (price, quantity) pair
  // multiplies out to that Sub Total -- "Amt Per Screen" and cut-length
  // notes can never be mistaken for the quantity.
  function parseZiplineOrderForm(text) {
    // Same Freedom form also comes titled "ZL2 Components" (no "Order Form"),
    // with the "Mill Price" heading split over two lines -- gate on the
    // column headings that every variant has.
    if (!/Ref No/i.test(text) || !/Sub Total/i.test(text) || !/\bMill\b/i.test(text)) return [];
    const cells = text.split("\n").map((c) => c.trim()).filter(Boolean);
    const headerIdx = cells.findIndex((c) => /^Sub Total$/i.test(c));
    if (headerIdx === -1) return [];
    // "ZL31", "ZIP50B", and variant refs printed as "ZL32 -" / "ZL32 PC"
    // (mill / powder-coated) -- an empty segment between two refs simply has
    // no Sub Total and is skipped.
    const refRe = /^[A-Z]{2,5}\d{1,4}[A-Z]?(?:\s*-|\s+PC)?$/;
    const subTotalRe = /^\$\s?([\d,]+\.\d{2})$/;
    const numRe = /^[\d,]+(?:\.\d+)?$/;
    const starts = [];
    for (let i = headerIdx + 1; i < cells.length; i++) if (refRe.test(cells[i])) starts.push(i);

    const entries = [];
    starts.forEach((start, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : cells.length;
      const row = cells.slice(start + 1, end);
      const subIdx = row.findIndex((c) => subTotalRe.test(c));
      if (subIdx < 1) return;
      const subTotal = parseFloat(row[subIdx].match(subTotalRe)[1].replace(/,/g, ""));
      const nameIdx = row.findIndex((c, i) => i < subIdx && /[A-Za-z]{3,}/.test(c) && !/^n\/a$/i.test(c));
      if (nameIdx === -1) return;
      const nums = row.slice(nameIdx + 1, subIdx)
        .map((c, i) => (numRe.test(c) ? { i, v: parseFloat(c.replace(/,/g, "")), decimal: c.includes(".") } : null))
        .filter((n) => n && n.v > 0);
      const pairs = [];
      for (const price of nums) {
        for (const qty of nums) {
          if (qty.i <= price.i) continue;
          if (Math.abs(price.v * qty.v - subTotal) <= Math.max(0.02, subTotal * 0.0005)) pairs.push({ price, qty });
        }
      }
      if (pairs.length !== 1) return;
      const description = row[nameIdx]
        .replace(/\s+\d+(?:\.\d+)?\s*kgs?\s*$/i, "")
        .replace(/\s*\(NOTE:[^)]*\)/i, "")
        .replace(/\s+/g, " ").trim();
      entries.push({ code: "", supplierRef: cells[start].replace(/\s*-$/, "").trim(), description, qty: pairs[0].qty.v, unitCost: pairs[0].price.v, lineTotal: subTotal });
    });
    return entries;
  }

  // Freedom Screens of Australia invoice / quote / proforma layout:
  //   QTY  DESCRIPTION  UNIT PRICE (ex GST)  DISC %  TOTAL (ex GST)
  // pdf.js keeps each item on one line, e.g.
  //   "50  ZLS1 Handle - F - A - 01 (L)  -  White  $7.36  $368.00"
  // A line is only read when QTY x UNIT PRICE (less any DISC %) reconciles
  // to its TOTAL. Section headings ("Smartscreen Components") and colour-
  // split notes ("50 white /25 black") have no prices, so are never read as
  // items. No item codes are printed, so rows match by description.
  // "75 White 75 Black", "50 white /25 black", "16 Black/16 White" -- one
  // invoice line covering two colours. Returned only when the two counts add
  // up to the line's quantity, so a note is never misread as something else.
  const COLOUR_SPLIT_RE = /(\d+)\s*(white|black|wht|blk)\s*[\/,&]?\s*(\d+)\s*(white|black|wht|blk)/i;
  function colourSplitFrom(note, qty) {
    const m = String(note || "").match(COLOUR_SPLIT_RE);
    if (!m) return null;
    const a = parseFloat(m[1]), b = parseFloat(m[3]);
    const name = (c) => (/^(white|wht)$/i.test(c) ? "White" : "Black");
    if (name(m[2]) === name(m[4]) || Math.abs(a + b - qty) > 1e-9) return null;
    return [{ colour: name(m[2]), qty: a }, { colour: name(m[4]), qty: b }];
  }

  function parseQtyDescPriceTotal(text, pdfItems) {
    if (!/\bQTY\b/.test(text) || !/\bDESCRIPTION\b/.test(text) || !/UNIT PRICE/i.test(text)) return { entries: [], reconciliation: null };
    const lineRe = /^(\d+(?:\.\d+)?)\s+(.*?[A-Za-z].*?)\s+\$\s?([\d,]+\.\d{2})\s+(?:(\d+(?:\.\d+)?)\s*%?\s+)?\$\s?([\d,]+\.\d{2})$/;
    const money = (v) => parseFloat(v.replace(/,/g, ""));
    const entries = [];
    let parsedTotal = 0;
    for (const raw of text.split("\n")) {
      const m = raw.trim().replace(/\s+/g, " ").match(lineRe);
      if (!m) continue;
      const qty = parseFloat(m[1]);
      const unitCost = money(m[3]);
      const disc = m[4] != null ? parseFloat(m[4]) : 0;
      const total = money(m[5]);
      const expected = qty * unitCost * (1 - disc / 100);
      if (!(qty > 0) || Math.abs(expected - total) > Math.max(0.02, total * 0.001)) continue;
      const rawDescription = m[2].replace(/\s+/g, " ").trim();
      entries.push({ code: "", rawDescription, qty, unitCost: disc ? unitCost * (1 - disc / 100) : unitCost, lineTotal: total, colourNote: null });
      parsedTotal += total;
    }
    // Colour-split notes the PDF stores out of order: attach each to the
    // item line it sits beside (same height on the page, within a few
    // points, and the closest such line).
    for (const pageItems of pdfItems || []) {
      for (const note of pageItems.filter((it) => COLOUR_SPLIT_RE.test(it.str) && it.str.replace(COLOUR_SPLIT_RE, "").trim() === "")) {
        let best = null;
        for (const e of entries) {
          const host = pageItems.find((it) => it.str.replace(/\s+/g, " ") === e.rawDescription.replace(/\s+-\s+/g, " - "))
            || pageItems.find((it) => e.rawDescription.startsWith(it.str.replace(/\s+/g, " ")) && it.str.length > 6);
          if (!host) continue;
          const dy = Math.abs(host.y - note.y);
          if (dy <= 12 && (!best || dy < best.dy)) best = { e, dy };
        }
        if (best && !best.e.colourNote) best.e.colourNote = note.str;
      }
    }
    const out = [];
    for (const e of entries) {
      // Inline note, e.g. "ZLS1 Handle Mount - 01 - 75 White 75 Black".
      let base = e.rawDescription, note = e.colourNote;
      const inline = base.match(new RegExp(`\\s*-?\\s*${COLOUR_SPLIT_RE.source}\\s*$`, "i"));
      if (inline) { note = note || inline[0]; base = base.slice(0, inline.index); }
      const description = base.replace(/\s+-\s+/g, " - ").replace(/\s+/g, " ").trim();
      const split = colourSplitFrom(note, e.qty);
      if (split) {
        for (const part of split) {
          out.push({ code: "", description: `${description} - ${part.colour}`, qty: part.qty, unitCost: e.unitCost,
            lineTotal: Math.round(part.qty * e.unitCost * 100) / 100, colourSplitFrom: `${note.trim()} (of ${e.qty})` });
        }
      } else {
        out.push({ code: "", description, qty: e.qty, unitCost: e.unitCost, lineTotal: e.lineTotal });
      }
    }
    entries.length = 0;
    entries.push(...out);
    // The printed Subtotal (or Total/Balance Due when there's no freight or
    // tax) must appear somewhere on the document as the sum of the lines --
    // a missed line would leave the rows short of it.
    let reconciliation = null;
    if (entries.length) {
      const printed = [...text.matchAll(/\$\s?([\d,]+\.\d{2})/g)].map((mm) => money(mm[1]));
      reconciliation = {
        expectedTotal: printed.length ? Math.max(...printed) : parsedTotal,
        parsedTotal,
        ok: printed.some((v) => Math.abs(v - parsedTotal) <= 0.05),
      };
    }
    return { entries, reconciliation };
  }

  // Freedom Screens India proforma (real file: "SUP 22 Oryx Doors- Pool Patio
  // Mesh R2"):  Sl No · Particulars · Rolls/Qty · Rate $USD · Per · Amount
  //   "1  Phifer Fiberglass Pool and Patio Screen 9' x 100'  10  458  roll  4580.000"
  // Rates often have no decimals, so a line is read only when its numbers
  // reconcile (qty x rate = amount) and its Sl No runs in sequence (a gap is
  // reported, never guessed). No item codes are printed.
  const PER_UNIT_RE = "(?:rolls?|pcs?|nos?|each|ea|sets?|pairs?|m|mtrs?|meters?|metres?|kgs?|box(?:es)?|sheets?|lengths?|bars?)";
  function parseSlNoParticulars(text) {
    if (!/\bSl\.?\s*No\b/i.test(text) || !/\bParticulars\b/i.test(text) || !/\bAmount\b/i.test(text)) return { entries: [], reconciliation: null };
    const num = "([\\d,]+(?:\\.\\d+)?)";
    const lineRe = new RegExp(`^(\\d{1,3})\\s+(.*?[A-Za-z].*?)\\s+${num}\\s+${num}\\s+(?:(${PER_UNIT_RE})\\s+)?${num}$`, "i");
    const money = (v) => parseFloat(v.replace(/,/g, ""));
    const entries = [];
    let parsedTotal = 0;
    for (const raw of text.split("\n")) {
      const m = raw.trim().replace(/\s+/g, " ").match(lineRe);
      if (!m) continue;
      const qty = money(m[3]), rate = money(m[4]), amount = money(m[6]);
      // Only cent-level rounding of the rate is tolerated (half a cent per unit).
      if (!(qty > 0) || !(rate > 0) || Math.abs(qty * rate - amount) > 0.02 + qty * 0.005) continue;
      entries.push({ code: "", description: m[2].replace(/\s+/g, " ").trim(), qty, unitCost: rate, unit: m[5] ? m[5].toLowerCase() : "", ln: parseInt(m[1], 10), lineTotal: amount });
      parsedTotal += amount;
    }
    let reconciliation = null;
    if (entries.length) {
      const printed = [...text.matchAll(/(?:^|\s)([\d,]+\.\d{2,3})(?=\s|$)/gm)].map((mm) => money(mm[1]));
      reconciliation = { expectedTotal: parsedTotal, parsedTotal, ok: printed.some((v) => Math.abs(v - parsedTotal) <= 0.05) };
    }
    return { entries, reconciliation };
  }

  // Freedom Screens packing lists contain reliable received quantities but
  // deliberately omit item codes and prices. pdf.js may either keep each
  // visible row together or emit the Description column later in the text
  // stream, so both shapes are supported. Rows always remain unmatched: a
  // human must map each description to Master Inventory before it can add
  // stock, and a null unit cost tells the server to retain the item's
  // existing Master Inventory cost rather than inventing a price.
  function parsePackingListRows(text) {
    if (!/\bPACKING LIST\b/i.test(text) || !/Bundle\s*\/\s*Roll NO/i.test(text) || !/Gross+\s*Weight/i.test(text)) {
      return [];
    }

    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const dimension = "\\d+(?:\\.\\d+)?\\s*[xX]\\s*\\d+(?:\\.\\d+)?\\s*[xX]\\s*\\d+(?:\\.\\d+)?";
    const inlineRe = new RegExp(`^(\\d{1,3})\\s+(?:Roll|Bundle)\\s+\\d+\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+${dimension}\\s+\\d+(?:\\.\\d+)?$`, "i");
    const detachedRe = new RegExp(`^(\\d{1,3})\\s+(?:Roll|Bundle)\\s+\\d+\\s+(\\d+(?:\\.\\d+)?)\\s+${dimension}\\s+\\d+(?:\\.\\d+)?$`, "i");
    const inline = [];
    const detached = [];

    for (const line of lines) {
      const im = line.match(inlineRe);
      if (im) {
        inline.push({ ln: parseInt(im[1], 10), description: im[2].trim(), qty: parseFloat(im[3]) });
        continue;
      }
      const dm = line.match(detachedRe);
      if (dm) detached.push({ ln: parseInt(dm[1], 10), qty: parseFloat(dm[2]) });
    }

    let rows = inline;
    if (!rows.length && detached.length) {
      const descriptions = lines.filter((line) =>
        /[A-Za-z]/.test(line) && /\b\d+(?:\.\d+)?\s*MM\s*$/i.test(line) && !/^Dimension\b/i.test(line)
      );
      if (descriptions.length !== detached.length) return [];
      rows = detached.map((row, idx) => ({ ...row, description: descriptions[idx] }));
    }

    if (!rows.length || rows.some((row, idx) => row.ln !== idx + 1 || !(row.qty > 0) || !row.description)) return [];
    const totalLine = lines.find((line) => /^Total No of Rolls\b/i.test(line));
    const totalMatch = totalLine && totalLine.match(/^Total No of Rolls\s+(\d+)/i);
    if (totalMatch && parseInt(totalMatch[1], 10) !== rows.length) return [];

    return rows.map((row) => ({
      code: "",
      description: row.description,
      qty: row.qty,
      unit: "Nos",
      unitCost: null,
      manualMatchRequired: true,
      ln: row.ln,
    }));
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { CHECKIN_FORMATS, QUOTE_CODE_RE, QUOTE_LN_RE, parseCheckinHeader,
    parseCommercialInvoiceDescriptions, parseFreedomApprovalCellStream, parseFreedomApprovalOrder,
    parsePackingListRows, parseQtyDescPriceTotal, parseSlNoParticulars, parseZiplineOrderForm });
})();
