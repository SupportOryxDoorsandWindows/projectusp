/* Check-in, matching and costs: teach once / remember (supplier_item_aliases), buildCheckinRows (Master Inventory matching and suggestions), roll conversion, exchange rate, landed cost and New-item lookups.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, deleteBtnAttrs, findEmbeddedCodeSuggestion, findSeriesSuggestion,
    findUniqueDescriptionItem, fmt, invoiceRollLengthM, knownRollLengthM, lookupExactCode,
    normaliseForMatch, parseBundleLengthM, parseLengthToken, parsePackaging, pickInventoryRow, sb,
    withoutWidths, deleteRowAt, restoreDeleted, TRASH_ICON, ciState, fetchCheckinExchangeRate } = FP;

  /* --------------------- Teach once, remember -------------------------- */
  // A person's confirmed decision that a supplier's own code or wording means
  // a given Master Inventory item (table supplier_item_aliases, written only
  // by the `checkin` Edge Function after a successful Check-in). Keys are
  // normalised the same way the matcher reads text, so trivial differences
  // ("White" vs "WHT", spacing, dashes) still hit the same link.
  function supplierKey(name) {
    return String(name || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(pty|ltd|llc|l l c|inc|co|company|limited|fzco|fze|fzc|the|of|trading)\b/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function aliasDescriptionKey(text) {
    return normaliseForMatch(text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).join(" ");
  }
  function aliasCodeKey(code) {
    return String(code || "").toUpperCase().replace(/\s+/g, " ").trim();
  }

  async function loadSupplierAliases() {
    try {
      const { data, error } = await sb.from("supplier_item_aliases").select("*");
      if (error) throw error;
      return data || [];
    } catch (err) {
      // Never blocks a Check-in -- it just reads without remembered links.
      console.warn("Remembered matches unavailable:", err && err.message);
      return [];
    }
  }
  function buildAliasIndex(aliases) {
    const index = new Map();
    for (const a of aliases || []) {
      const k = `${a.match_kind}|${a.match_key}`;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(a);
    }
    return index;
  }
  // Supplier's own code first, then its wording. When the same text was
  // linked to different items for different suppliers, the current
  // supplier's link decides; if that still isn't one item, nothing is used.
  function lookupAlias(aliasIndex, itemsByCode, line, description, supplierHint) {
    if (!aliasIndex || !aliasIndex.size) return null;
    const byId = new Map();
    for (const cands of itemsByCode.values()) for (const c of cands) byId.set(c.id, c);
    const hint = supplierKey(supplierHint);
    const hintFirst = hint.split(" ")[0];
    const tries = [];
    const code = aliasCodeKey(line.supplierRef || line.code);
    if (code) tries.push(["code", code]);
    const desc = aliasDescriptionKey(description);
    if (desc) tries.push(["description", desc]);
    for (const [kind, key] of tries) {
      const hits = (aliasIndex.get(`${kind}|${key}`) || []).filter((a) => byId.has(a.item_id));
      if (!hits.length) continue;
      let pool = hits;
      if (new Set(pool.map((a) => a.item_id)).size > 1 && hint) {
        pool = hits.filter((a) => a.supplier_key === hint || (hintFirst && a.supplier_key.split(" ")[0] === hintFirst));
      }
      if (pool.length && new Set(pool.map((a) => a.item_id)).size === 1) {
        const a = pool.reduce((x, y) => (y.times_confirmed > x.times_confirmed ? y : x));
        return { item: byId.get(a.item_id), kind, supplier: a.supplier, timesConfirmed: a.times_confirmed };
      }
    }
    return null;
  }

  function buildCheckinRows(lines, descriptions, itemsByCode, aliasIndex, supplierHint) {
    const rows = [];
    const aliasHits = [];
    lines.forEach((l, i) => {
      const candidates = lookupExactCode(itemsByCode, l.code);
      // Description comes straight from the row parser when that format
      // captures it inline (every non-Commercial-Invoice format); only the
      // Commercial Invoice reader relies on the separate description block.
      const pdfDescription = l.description || (descriptions.length === lines.length ? descriptions[i] : "");
      let item = pickInventoryRow({ kind: "checkin" }, candidates);
      // Not an exact Master code -> a link a person already confirmed for this
      // supplier's code or wording wins over every automatic rule below.
      const matchedByAlias = !item ? lookupAlias(aliasIndex, itemsByCode, l, pdfDescription, supplierHint) : null;
      if (matchedByAlias) item = matchedByAlias.item;
      aliasHits[i] = matchedByAlias;
      // The invoice's own code didn't resolve to anything (missing,
      // truncated, or simply wrong) -- fall back to an exact, UNIQUE
      // description match against Master Inventory (never fires once a code
      // has already matched; that path goes through the conflict check
      // below instead). findUniqueDescriptionItem never guesses between
      // duplicate descriptions -- it returns null for those, same as no
      // match at all.
      const matchedByDescription = !item
        ? findUniqueDescriptionItem(itemsByCode, pdfDescription)
        : null;
      if (matchedByDescription) item = matchedByDescription;
      // The invoice stated BOTH a code and a description, and the code
      // resolved to a real Master Inventory item -- but the description, if
      // it independently and uniquely identifies a DIFFERENT item, is a
      // genuine data conflict (wrong code typed for this line, or the code
      // and description got swapped on the source document). Never trust
      // one field over the other here; flag for manual review instead of
      // silently picking the code's item.
      let codeDescConflict = null;
      if (item && !matchedByDescription && !matchedByAlias && l.code && pdfDescription) {
        const descItem = findUniqueDescriptionItem(itemsByCode, pdfDescription);
        if (descItem && descItem.id !== item.id) {
          codeDescConflict = { codeItemCode: item.item_code, descItemCode: descItem.item_code };
          item = null;
        }
      }
      const resolvedCode = item ? (item.item_code || l.code) : l.code;
      // A very short code (<=4 chars) that still didn't match anything is
      // worth calling out explicitly -- real Master Inventory codes are
      // 5-6 digits, so this is a strong hint the source document truncated
      // its own Code column rather than this reader mis-parsing it. Not
      // shown for a code/description conflict -- that already has its own,
      // more specific explanation.
      const truncatedHint = !item && !codeDescConflict && l.code && l.code.length <= 4;
      if (!item) {
        // Only for a plain "not found" -- a code/description conflict
        // already has its own, more specific note.
        const suggestion = !codeDescConflict
          ? (findEmbeddedCodeSuggestion(itemsByCode, l.code) || findSeriesSuggestion(itemsByCode, pdfDescription))
          : null;
        // Not in Master yet, but the line is a roll whose length is known
        // (stated on the invoice, or confirmed by the stock team, e.g. Paw
        // Lite = 30 m): shown in metres straight away, like a matched roll.
        // Edit / Use this item / New item all start again from the roll
        // count and per-roll price kept here.
        const rollText = `${l.unit || ""} ${pdfDescription || ""}`;
        const preRollM = l.qty > 0 && /\b(rolls?|coils?|reels?)\b/i.test(rollText)
          ? (invoiceRollLengthM(rollText) || knownRollLengthM(rollText))
          : null;
        rows.push({
          code: l.code, description: pdfDescription, unit: l.unit || "",
          qty: preRollM ? Math.round(l.qty * preRollM * 100) / 100 : l.qty,
          invoiceUnitCost: preRollM && l.unitCost != null ? l.unitCost / preRollM : l.unitCost,
          packageInfo: preRollM ? { type: "Roll", qtyPerPackage: preRollM, unit: "m", rollCount: l.qty, rollUnitCost: l.unitCost } : null,
          current: null, newQty: null,
          status: "unmatched", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint,
          lowConfidence: !!l.lowConfidence,
          codeDescConflict,
          suggestedItem: suggestion
            ? {
                id: suggestion.item.id, code: suggestion.item.item_code,
                description: suggestion.item.description || "",
                barLengthMm: suggestion.item.bar_length_mm != null ? suggestion.item.bar_length_mm : null,
                note: suggestion.note,
              }
            : null,
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
      // states a pack size is a "<number>m" token: the invoice's Unit field
      // or description sometimes carries one ("300m", "(200m roll)"), and
      // Master Inventory's own description carries one in parentheses.
      // Only flag when BOTH sides state one and they disagree -- this
      // can't misfire on the common case where neither side claims a
      // length at all.
      const invoiceLen = parseLengthToken(withoutWidths(`${l.unit || ""} ${pdfDescription || ""}`));
      const masterLen = parseBundleLengthM(item.description);
      if (invoiceLen != null && masterLen != null && invoiceLen !== masterLen) {
        rows.push({
          code: resolvedCode, description: pdfDescription, unit: l.unit || "", qty: l.qty,
          invoiceUnitCost: l.unitCost,
          current: item.current_qty, newQty: null,
          status: "exact-diff", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          matchedByDescription: matchedByDescription ? { sourceCode: l.code || "—" } : null,
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
      // own roll length in its description ("...(300m Roll)"). The invoice
      // quantity is a roll/bundle COUNT ("1", "4"), whether the invoice's
      // Unit column is blank/"Units" or repeats the same length ("300m").
      // A different stated length was already stopped for review above.
      // Master Inventory tracks stock and unit cost
      // for these items in metres (confirmed against real records: e.g.
      // 30003R's current_qty and unit_cost are both metre-based, not
      // roll-based), so the roll count is expanded to metres and the roll
      // price is divided down to a per-metre cost automatically -- the
      // same way every other matched row here checks in without a manual
      // review step. The roll count itself is kept (packageInfo.rollCount)
      // purely so the Qty column can still show "+1 (300 m)" instead of
      // the less readable "+300 m", and so the original per-roll price is
      // preserved for the audit trail at Confirm.
      if (masterLen != null && (invoiceLen == null || invoiceLen === masterLen)) {
        const rollCount = l.qty;
        const qtyMetres = rollCount * masterLen;
        const perMetreCost = l.unitCost != null ? l.unitCost / masterLen : null;
        const bundleType = /roll|coil|reel/i.test(`${item.description || ""} ${pdfDescription || ""} ${l.unit || ""}`) ? "Roll" : "Length";
        rows.push({
          code: resolvedCode, description: item.description || pdfDescription, unit: l.unit || "", qty: qtyMetres,
          invoiceUnitCost: perMetreCost,
          current: item.current_qty, newQty: item.current_qty + qtyMetres,
          status: "ok", action: "add", decided: true,
          itemId: item.id, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          matchedByDescription: matchedByDescription ? { sourceCode: l.code || "—" } : null,
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
          code: resolvedCode, description: item.description || pdfDescription, unit: l.unit || "", qty: l.qty,
          invoiceUnitCost: l.unitCost,
          current: item.current_qty, newQty: null,
          status: "pack-review", action: "pending", decided: false,
          itemId: null, editing: false, truncatedHint: false,
          lowConfidence: !!l.lowConfidence,
          matchedByDescription: matchedByDescription ? { sourceCode: l.code || "—" } : null,
          packMismatch: {
            itemId: item.id, itemDescription: item.description, itemCurrentQty: item.current_qty,
            itemUnit: item.unit_of_measure || "",
            invoicePkg: { ...invoicePkg, sourceQty: l.qty }, masterPkg,
          },
        });
        return;
      }
      rows.push({
        code: resolvedCode, description: item.description || pdfDescription, unit: l.unit || "", qty: l.qty,
        invoiceUnitCost: l.unitCost,
        current: item.current_qty, newQty: item.current_qty + l.qty,
        status: "ok", action: "add", decided: true,
        itemId: item.id, editing: false, truncatedHint: false,
        lowConfidence: !!l.lowConfidence,
        matchedByDescription: matchedByDescription ? { sourceCode: l.code || "—" } : null,
        packageInfo: invoicePkg ? { type: invoicePkg.type, qtyPerPackage: invoicePkg.qtyPerPackage, unit: invoicePkg.unit } : null,
      });
    });
    // Every line pushes exactly one row, so rows[i] is lines[i]. Keep what
    // the supplier actually printed -- a resolved row's code/description are
    // replaced by the Master item's, but "teach once, remember" needs the
    // supplier's own wording and code.
    rows.forEach((r, i) => {
      const l = lines[i] || {};
      r.source = {
        code: l.code || "",
        supplierRef: l.supplierRef || "",
        description: l.description || (descriptions.length === lines.length ? descriptions[i] : "") || "",
      };
      const hit = aliasHits[i];
      r.matchedByAlias = hit && r.itemId === hit.item.id ? { supplier: hit.supplier, timesConfirmed: hit.timesConfirmed } : null;
    });
    return rows;
  }

  // The invoice's own quantity for a row: the roll count for a row already
  // converted to metres ("2 rolls" -> 250 m), else its quantity. Edit and
  // "Use this item" always start from this, so converting again can never
  // treat 250 m as 250 rolls.
  function ciInvoiceQty(row) {
    return row.packageInfo && row.packageInfo.rollCount != null ? row.packageInfo.rollCount : row.qty;
  }

  function recomputeCiRowAfterEdit(row, newCode, newDescription, newQty, newUnit, exactItemId) {
    // A row already converted to metres carries a per-metre cost; go back to
    // the invoice's own per-roll price before working anything out again.
    if (row.packageInfo && row.packageInfo.rollCount != null && row.packageInfo.rollUnitCost !== undefined) {
      row.invoiceUnitCost = row.packageInfo.rollUnitCost;
    }
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
    // A suggestion names one exact Master row (e.g. the 2900 mm length of a
    // code that has 2500/2900/5100 mm rows) -- use that row, never a guess.
    const item = (exactItemId && candidates.find((c) => c.id === exactItemId)) || pickInventoryRow({ kind: "checkin" }, candidates);
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
    // The supplier's own wording (kept on row.source) counts too -- Edit
    // passes no description, and "(25mtrs roll)" / "9' x 100'" must never be
    // lost: 8 rolls of 25 m are 200 m, not 8 x Master's 200 m roll.
    const invoiceText = `${newUnit || ""} ${newDescription || ""} ${(row.source && row.source.description) || ""}`;
    const statedRollM = invoiceRollLengthM(invoiceText);
    const editedInvoiceLen = statedRollM != null ? statedRollM : parseLengthToken(withoutWidths(`${newUnit || ""} ${newDescription || ""}`));
    if (bundleLenM != null && (editedInvoiceLen == null || editedInvoiceLen === bundleLenM || statedRollM != null)) {
      const perRollM = statedRollM != null ? statedRollM : bundleLenM;
      const rollCount = invoiceQty;
      const qtyMetres = Math.round(rollCount * perRollM * 100) / 100;
      const rollUnitCost = row.invoiceUnitCost; // original per-roll price, before conversion
      const perMetreCost = rollUnitCost != null ? rollUnitCost / perRollM : null;
      // The supplier's own wording counts ("Paw Lite Mesh 3m wide roll").
      const bundleType = /roll|coil|reel/i.test(`${item.description || ""} ${invoiceText}`) ? "Roll" : "Length";
      row.qty = qtyMetres;
      row.invoiceUnitCost = perMetreCost;
      row.current = item.current_qty;
      row.newQty = item.current_qty + qtyMetres;
      row.status = "ok"; row.action = "add"; row.decided = true;
      row.itemId = item.id;
      row.description = item.description || newDescription;
      row.packageInfo = { type: bundleType, qtyPerPackage: perRollM, unit: "m", rollCount, rollUnitCost };
      return;
    }
    row.description = item.description || newDescription;
    row.current = item.current_qty;
    row.newQty = item.current_qty + newQty;
    row.status = "ok"; row.action = "add"; row.decided = true;
    row.itemId = item.id;
  }

  function ciRate() {
    if (!ciState.currency) return null; // "$" whose dollar hasn't been chosen yet
    return ciState.currency === "AED" ? 1 : (ciState.exchangeRate || null);
  }

  // Fetches the ciState.currency -> AED rate for the invoice date: currency
  // API first, then the last rate on file, else flagged for manual entry.
  async function ciLoadExchangeRate(isoDocDate) {
    if (!ciState.currency) {
      ciState.exchangeRate = null; ciState.rateDate = null; ciState.rateSource = "n/a";
      return;
    }
    if (ciState.currency === "AED") {
      ciState.exchangeRate = 1; ciState.rateDate = null; ciState.rateSource = "n/a";
      return;
    }
    FP.ciStatus(`Fetching the ${ciState.currency}→AED exchange rate…`);
    const fetched = await fetchCheckinExchangeRate(ciState.currency, isoDocDate);
    if (fetched) {
      ciState.exchangeRate = fetched.rate;
      ciState.rateDate = fetched.rateDate;
      ciState.rateSource = fetched.source;
      return;
    }
    const cached = ciState.ratesByCurrency && ciState.ratesByCurrency.get(ciState.currency);
    if (cached) {
      ciState.exchangeRate = cached.rate;
      ciState.rateDate = cached.asOf ? String(cached.asOf).slice(0, 10) : null;
      ciState.rateSource = "cache-fallback";
    } else {
      ciState.exchangeRate = null; ciState.rateDate = null; ciState.rateSource = "unavailable";
    }
  }

  const CURRENCY_BASIS_NOTE = {
    "dollar-australian-details": "Detected as AUD: prices are in \"$\" and the document carries Australian details (e.g. ABN, Pty Ltd, Australia).",
    "dollar-us-details": "Detected as USD: prices are in \"$\" and the document carries US details.",
    "dollar-chosen": "Prices are in \"$\" — currency changed on this screen; every price was converted to AED with the new rate.",
    "dollar-default-aud": "Prices are in \"$\", so AUD was used automatically (Freedom Screens of Australia's \"$\" order forms carry the same prices as their AUD quotes) and every price was converted to AED. Nothing to do here.",
  };

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

  // Master Inventory stores AED unit costs. For roll-based items whose
  // stock is expanded into metres, the agreed business rule is to keep two
  // decimal places without rounding up (499.94 / 300 = 1.6664... -> 1.66).
  // The exact source-currency calculation and original per-roll price stay
  // in the transaction audit fields; only the Master Inventory unit cost is
  // cut off to two AED decimals.
  function storedInventoryUnitCostAed(row, landedUnitCost, rate) {
    if (landedUnitCost == null || !(rate > 0)) return null;
    const converted = landedUnitCost * rate;
    const isMetreRoll = row.packageInfo && row.packageInfo.unit === "m" && row.packageInfo.rollCount != null;
    return isMetreRoll ? Math.floor((converted + 1e-9) * 100) / 100 : converted;
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
    // Delete is always the last button, whatever the row's status.
    const deleteBtn = `<button data-act="delete" data-i="${idx}" class="fp-row-delete" aria-label="Delete"${deleteBtnAttrs() || ` title="Remove this line from the Check-in"`}>${TRASH_ICON}</button>`;
    const on = (yes) => yes ? "on" : "";
    const editBtn = `<button data-act="edit" data-i="${idx}">Edit</button>`;
    if (row.status === "ok") {
      return `<div class="fp-row-actions">
        <button data-act="skip" data-i="${idx}" class="${on(row.action === "skip")}">Skip</button>
        ${row.action === "skip" ? `<button data-act="add" data-i="${idx}">Undo</button>` : ""}
        ${editBtn}
        ${deleteBtn}
      </div>`;
    }
    if (row.status === "new") {
      return `<div class="fp-row-actions">
        <button data-act="undo-new" data-i="${idx}">Undo</button>
        ${editBtn}
        ${deleteBtn}
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
        ${deleteBtn}
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
        ${deleteBtn}
      </div>`;
    }
    return `<div class="fp-row-actions">
      <button data-act="skip" data-i="${idx}" class="${on(row.decided)}">Acknowledge</button>
      ${editBtn}
      <button data-act="new-item" data-i="${idx}">+ New item</button>
      ${deleteBtn}
    </div>`;
  }

  function applyCiRowAction(idx, act) {
    if (ciState.done) return;
    if (act === "restore") {
      const back = restoreDeleted(ciState.rows, ciState.deletedRows || [], idx);
      if (back) {
        if (window.ORYX_AUTH) window.ORYX_AUTH.logRestore({ area: "checkin", ref: back.code || back.description,
          detail: { code: back.code || null, description: back.description || null }, documentName: ciState.pdfFile ? ciState.pdfFile.name : null });
        FP.ciRender();
        FP.ciStatus(`Restored ${back.code ? back.code + " — " : ""}${back.description || "line"} to the Check-in.`);
      }
      return;
    }
    if (act === "delete") {
      const r = ciState.rows[idx];
      if (!r) return;
      // Removed outright, not just acknowledged: the line leaves the list, so
      // it can no longer be acknowledged, matched or checked in, and it drops
      // out of the shipping split. Nothing is written until Confirm, and
      // Restore puts it back exactly as it was.
      const label = `${r.code ? r.code + " — " : ""}${r.description || "this line"} (${[fmt(r.qty), r.unit].filter(Boolean).join(" ")})`;
      // Confirmation + the server's permission check (and the delete log);
      // the line is only removed once both say yes.
      if (window.ORYX_AUTH) {
        window.ORYX_AUTH.requestDelete({
          what: label, area: "checkin", ref: r.code || r.description,
          detail: { code: r.code || null, description: r.description || null, qty: r.qty, unit: r.unit || null,
                    unit_cost: r.invoiceUnitCost != null ? r.invoiceUnitCost : null, currency: ciState.currency || null,
                    supplier: ($("#ciSupplier") || {}).value || null, invoice_number: ($("#ciInvoiceNumber") || {}).value || null },
          documentName: ciState.pdfFile ? ciState.pdfFile.name : null,
          note: "It won't be added to the Master Inventory. You can still bring it back with Restore, below the table, until you confirm the Check-in.",
        }).then((ok) => {
          if (!ok || ciState.done || ciState.rows[idx] !== r) return;
          ciState.deletedRows = ciState.deletedRows || [];
          deleteRowAt(ciState.rows, ciState.deletedRows, idx);
          FP.ciRender();
          FP.ciStatus(`Deleted ${label} — it will not be acknowledged or checked in. Use Restore below the table to bring it back.`);
        });
        return;
      }
      const ok = window.confirm(`Delete ${label} from this Check-in?`);
      if (!ok) return;
      ciState.deletedRows = ciState.deletedRows || [];
      deleteRowAt(ciState.rows, ciState.deletedRows, idx);
      FP.ciRender();
      FP.ciStatus(`Deleted ${label} — it will not be acknowledged or checked in. Use Restore below the table to bring it back.`);
      return;
    }
    if (act === "skip-all-unmatched") {
      ciState.rows.forEach((rr) => {
        if (rr.decided) return;
        if (rr.status === "unmatched") { rr.action = "skip"; rr.decided = true; }
      });
      FP.ciRender();
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
      r.personResolved = true;
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
        FP.ciStatus("Enter a quantity greater than zero before confirming.", "err");
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
      r.personResolved = true;
    }
    else if (act === "use-suggestion") {
      // The person confirmed the suggested Master Inventory item -- resolved
      // exactly as if they'd picked it via Edit, keeping the invoice's own
      // description and unit so roll/bundle conversion still applies.
      const suggested = r.suggestedItem;
      if (!suggested) return;
      r.suggestedItem = null;
      recomputeCiRowAfterEdit(r, suggested.code, r.description, ciInvoiceQty(r), r.unit, suggested.id);
      r.personResolved = r.status === "ok";
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
        FP.ciStatus("Select an item from the Master Inventory list before saving.", "err");
        return;
      }
      if (!isFinite(newQty) || newQty <= 0) {
        FP.ciStatus("Enter a quantity greater than zero.", "err");
        return;
      }
      const idEl = document.getElementById(`ciEditItemId${idx}`);
      recomputeCiRowAfterEdit(r, newCode, "", newQty, unitEl.value.trim() || r.unit, idEl ? idEl.value : "");
      r.personResolved = r.status === "ok";
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
      if (r.beforeNewItem) {
        Object.assign(r, r.beforeNewItem);
        r.beforeNewItem = null;
      }
      // A code typed into the New item form (the document had none) was
      // never the document's own -- put the row back exactly as it was read.
      if (r.typedNewCode) { r.code = ""; r.typedNewCode = false; }
    }
    else if (act === "save-new") {
      const descEl = document.getElementById(`ciNewDesc${idx}`);
      const catEl = document.getElementById(`ciNewCategory${idx}`);
      const unitEl = document.getElementById(`ciNewUnit${idx}`);
      const costEl = document.getElementById(`ciNewCost${idx}`);
      const bufferEl = document.getElementById(`ciNewBuffer${idx}`);
      const approverEl = document.getElementById(`ciNewApprover${idx}`);
      const ackEl = document.getElementById(`ciNewAck${idx}`);

      // The document's own code when it printed one; otherwise the code the
      // person typed (e.g. Freedom's part number from their price list).
      const codeEl = document.getElementById(`ciNewCode${idx}`);
      const typedCode = !r.code;
      const code = typedCode ? (codeEl ? codeEl.value.trim().toUpperCase() : "") : r.code;
      const description = descEl.value.trim();
      const category = catEl.value;
      const unit = unitEl.value.trim();
      const cost = parseFloat(costEl.value);
      const buffer = bufferEl.value.trim() ? parseFloat(bufferEl.value) : null;
      const approver = approverEl.value.trim();

      if (!code) { FP.ciStatus("Enter an item code for the new item -- the document didn't print one.", "err"); return; }
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) {
        FP.ciStatus("Item code can only use letters, numbers and dashes (e.g. 330110).", "err");
        return;
      }
      if (typedCode && lookupExactCode(ciState.itemsByCode, code).length) {
        FP.ciStatus(`Item code ${code} already exists in the Master Inventory -- use Edit to pick it, or enter a different code.`, "err");
        return;
      }
      if (typedCode && ciState.rows.some((other, j) => j !== idx && other.newItemData && String(other.newItemData.code).toUpperCase() === code)) {
        FP.ciStatus(`Item code ${code} is already being used for another new item on this Check-in.`, "err");
        return;
      }
      if (!description) { FP.ciStatus("Enter a description before adding this item.", "err"); return; }
      if (!unit) { FP.ciStatus("Enter a unit of measure before adding this item.", "err"); return; }
      if (!isFinite(cost) || cost <= 0) {
        FP.ciStatus("Enter a unit cost greater than zero -- it's never guessed for a new item.", "err");
        return;
      }
      if (buffer != null && (!isFinite(buffer) || buffer < 0)) {
        FP.ciStatus("Kanban trigger level must be a positive number, or left blank.", "err");
        return;
      }
      if (!approver) { FP.ciStatus("Enter the name of the person approving this new item.", "err"); return; }
      if (ackEl && !ackEl.checked) {
        FP.ciStatus("Confirm none of the possible matches above are this item before adding it.", "err");
        return;
      }

      const rollEl = document.getElementById(`ciNewRollM${idx}`);
      const rollM = rollEl && rollEl.value.trim() ? parseFloat(rollEl.value) : null;
      if (rollM != null && !(isFinite(rollM) && rollM > 0)) {
        FP.ciStatus("Metres per roll must be a number greater than zero, or left blank.", "err");
        return;
      }

      // Kept so Undo puts the row back exactly as read.
      r.beforeNewItem = { qty: r.qty, unit: r.unit, invoiceUnitCost: r.invoiceUnitCost, description: r.description, packageInfo: r.packageInfo || null };
      const rollCount = ciInvoiceQty(r); // the invoice's own roll count, even if shown in metres already
      if (typedCode) { r.code = code; r.typedNewCode = true; }
      if (rollM != null) {
        // 2 rolls × 30 m = 60 m at (price per roll ÷ 30) per metre. The
        // length goes into the Master name too -- "(30M)", like Patio Mesh --
        // so the next invoice for this item converts by itself.
        r.qty = Math.round(rollCount * rollM * 100) / 100;
        r.unit = "m";
        r.invoiceUnitCost = cost / rollM;
        r.packageInfo = { type: "Roll", qtyPerPackage: rollM, unit: "m", rollCount, rollUnitCost: cost };
        r.description = parseBundleLengthM(description) == null ? `${description} (${rollM}M)` : description;
        r.newItemData = { code: r.code, description: r.description, category: category || null, unit: "m", bufferLevel: buffer, approvedBy: approver };
      } else {
        // Blank: whole rolls (undo any metres shown before).
        if (r.packageInfo && r.packageInfo.rollCount != null) { r.qty = rollCount; r.packageInfo = null; }
        r.description = description;
        r.unit = unit;
        r.invoiceUnitCost = cost;
      }
      r.current = null;
      r.newQty = r.qty;
      r.status = "new";
      r.action = "create-new";
      r.decided = true;
      r.creatingNew = false;
      if (rollM == null) r.newItemData = { code: r.code, description, category: category || null, unit, bufferLevel: buffer, approvedBy: approver };
      r.personResolved = true;
    }
    FP.ciRender();
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { CURRENCY_BASIS_NOTE, aliasCodeKey, aliasDescriptionKey, applyCiRowAction, buildAliasIndex,
    buildCheckinRows, ciInvoiceQty, ciLandedUnitCost, ciLoadExchangeRate, ciRate,
    ciRenderRowActionButtons, ciShippingAllocation, ciTally, findSimilarMasterInventoryItems,
    loadSupplierAliases, storedInventoryUnitCostAed, supplierKey });
})();
