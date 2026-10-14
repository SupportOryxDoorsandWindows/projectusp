/* Check-in, general readers: line-item block reader, last-resort readers, wrapped-line recovery, and parseCheckinDocument, which tries every layout and keeps the best.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { SUPPORTED_CURRENCIES, CHECKIN_FORMATS, parseFreedomApprovalCellStream,
    parseFreedomApprovalOrder, parsePackingListRows, parseQtyDescPriceTotal, parseSlNoParticulars,
    parseZiplineOrderForm, QUOTE_CODE_RE, QUOTE_LN_RE } = FP;

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

  // Layoutless standardiser: a final, cautious fallback for supplier PDFs
  // whose rows survive text/OCR extraction but do not match a known table
  // shape. It looks for a product-code-like token followed by description
  // text and enough numbers to prove a quantity × unit-cost ≈ line total.
  // Every row it creates is low-confidence and therefore review-gated.
  function parseLayoutlessStandardizedRows(text) {
    const entries = [];
    const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const codeStartRe = /^(\[?)([A-Za-z0-9][A-Za-z0-9-]{2,19}R?)\]?\s+(.+)$/i;
    const badCodeRe = /^(date|page|total|subtotal|invoice|purchase|shipment|supplier|buyer|ship|bill|bank|swift|contact)$/i;
    const currencyRe = new RegExp(`^(${SUPPORTED_CURRENCIES.join("|")})$`, "i");
    const unitWordRe = /^(units?|pcs?|pieces?|each|box(?:es)?|set|sheets?|rolls?|meters?|metres?|m|kgs?)$/i;

    function tokenise(line) {
      const raw = line.split(/\s+/).filter(Boolean);
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        const cur = raw[i];
        const next = raw[i + 1] || "";
        if (/^\d{1,3}$/.test(cur) && /^,\d{3}(?:\.\d+)?$/.test(next)) {
          out.push(cur + next);
          i++;
        } else {
          out.push(cur);
        }
      }
      return out;
    }

    function numericTokens(tokens) {
      return tokens
        .map((raw, idx) => {
          const cleaned = raw.replace(/,/g, "");
          if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
          const value = parseFloat(cleaned);
          return isFinite(value) ? { raw, idx, value, decimal: /\./.test(cleaned) } : null;
        })
        .filter(Boolean);
    }

    function bestQuantityCost(nums) {
      if (nums.length < 3) return null;
      const total = [...nums].reverse().find((n) => n.decimal);
      if (!total || total.value <= 0) return null;
      let best = null;
      for (const qty of nums) {
        if (qty.idx >= total.idx || qty.value <= 0) continue;
        for (const cost of nums) {
          if (cost.idx >= total.idx || cost.idx === qty.idx || cost.value <= 0) continue;
          const expected = qty.value * cost.value;
          const rel = Math.abs(expected - total.value) / Math.max(total.value, 1);
          if (rel > 0.04) continue;
          const score = rel + (cost.decimal ? 0 : 0.02) + (qty.idx > cost.idx ? 0.01 : 0);
          if (!best || score < best.score) best = { qty, cost, total, score };
        }
      }
      return best;
    }

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (BLOCK_SKIP_LINE_RE.test(line) || BLOCK_HS_LINE_RE.test(line)) continue;
      const m = line.match(codeStartRe);
      if (!m) continue;
      const code = m[2];
      if (badCodeRe.test(code) || !/\d/.test(code)) continue;

      let candidate = `${code} ${m[3]}`;
      // Pull in one or two short continuation lines until the next row
      // starts. This catches OCR/text-layer wraps without letting a whole
      // page paragraph leak into one item.
      for (let j = i + 1; j < Math.min(i + 3, rawLines.length); j++) {
        const next = rawLines[j];
        if (codeStartRe.test(next) || BLOCK_SKIP_LINE_RE.test(next) || BLOCK_HS_LINE_RE.test(next)) break;
        if (next.length <= 80) candidate += " " + next;
      }

      const tokens = tokenise(candidate);
      const nums = numericTokens(tokens);
      const picked = bestQuantityCost(nums);
      if (!picked) continue;

      const firstDataIdx = Math.min(picked.qty.idx, picked.cost.idx);
      const descTokens = tokens.slice(1, firstDataIdx)
        .filter((t) => !currencyRe.test(t) && !unitWordRe.test(t));
      const description = descTokens.join(" ").replace(/\s+/g, " ").trim();
      if (!description || !/[A-Za-z]/.test(description)) continue;

      const unitToken = tokens[picked.qty.idx + 1] || tokens[picked.qty.idx - 1] || "";
      entries.push({
        code,
        description,
        qty: picked.qty.value,
        unit: unitWordRe.test(unitToken) ? unitToken : "",
        unitCost: picked.cost.value,
        lowConfidence: true,
      });
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
  function parseCheckinDocument(text, pdfItems) {
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
    const freedomCellStream = parseFreedomApprovalCellStream(text);
    if (freedomCellStream.entries.length > best.entries.length) {
      best = {
        formatId: "freedom-approval-cell-stream",
        formatLabel: "Freedom approval/order table cells",
        entries: freedomCellStream.entries,
        reconciliation: freedomCellStream.reconciliation,
      };
    }
    const qdpt = parseQtyDescPriceTotal(text, pdfItems);
    if (qdpt.entries.length > best.entries.length) {
      best = {
        formatId: "qty-description-price-total",
        formatLabel: "Freedom invoice / quote (QTY · DESCRIPTION · UNIT PRICE · TOTAL)",
        entries: qdpt.entries,
        reconciliation: qdpt.reconciliation,
      };
    }
    const slNo = parseSlNoParticulars(text);
    if (slNo.entries.length > best.entries.length) {
      best = {
        formatId: "slno-particulars",
        formatLabel: "Freedom India proforma (Sl No · Particulars · Rate · Amount)",
        entries: slNo.entries,
        reconciliation: slNo.reconciliation,
      };
    }
    const ziplineEntries = parseZiplineOrderForm(text);
    if (ziplineEntries.length > best.entries.length) {
      best = {
        formatId: "zipline-order-form",
        formatLabel: "Freedom component order form (Zipline / ZL2)",
        entries: ziplineEntries,
      };
    }
    const packingListEntries = parsePackingListRows(text);
    if (packingListEntries.length > best.entries.length) {
      best = {
        formatId: "packing-list-no-codes",
        formatLabel: "Packing list (manual inventory mapping required)",
        entries: packingListEntries,
        requiresManualMapping: true,
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
    if (!best.entries.length) {
      const layoutlessEntries = parseLayoutlessStandardizedRows(text);
      if (layoutlessEntries.length) {
        best = {
          formatId: "layoutless-standardized",
          formatLabel: "Auto-standardised line items (low-confidence fallback)",
          entries: layoutlessEntries,
        };
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

  // Used by the other stock-screen files.
  Object.assign(FP, { parseCheckinDocument });
})();
