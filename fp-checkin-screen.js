/* Check-in, the screen: Preview table, row actions, Confirm, Analyse pipeline, reset and manual entry for unreadable PDFs.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, ciIsUnconvertedRollLine, confirmRequest, esc, extractPdfTextPerPage, fmt,
    invoiceRollLengthM, keptDocNote, knownRollLengthM, loadInventoryItems, lookupExactCode, money,
    pdfFingerprint, readFnJson, wireDocRetry, itemPhotoButton, keepOpenEdits, loadItemPhotos,
    openItemPhoto, pickedInventoryRow, restoreOpenEdits, wireCodePicker, ciStatusChip,
    deletedItemsBox, CHECKIN_FN_URL, ciState, detectDocumentCurrencyInfo, detectShippingCharge,
    genericMoney, genericUnitMoney, loadExchangeRates, ocrPdfPages, RATE_SOURCE_LABEL,
    textLayerLooksUsable, parseCheckinHeader, parseCommercialInvoiceDescriptions,
    parseCheckinDocument, aliasCodeKey, aliasDescriptionKey, applyCiRowAction, buildAliasIndex,
    buildCheckinRows, ciInvoiceQty, ciLandedUnitCost, ciLoadExchangeRate, ciRate,
    ciRenderRowActionButtons, ciShippingAllocation, ciTally, CURRENCY_BASIS_NOTE,
    findSimilarMasterInventoryItems, loadSupplierAliases, sb, storedInventoryUnitCostAed, supplierKey } = FP;

  // Bumped whenever a new file is selected (see wireCiDrop) or a new
  // analysis starts (see ciAnalyse) -- an in-flight ciAnalyse() checks this
  // after every await and abandons its results if it no longer matches,
  // so a slow OCR run for a file the user has since replaced can never
  // overwrite the newer selection's state.
  let ciAnalyseToken = 0;
  // Single source of truth for whether Confirm may actually run -- used both
  // to enable/disable the button in ciRender() and, defensively, inside
  // ciConfirm() itself. The button's disabled state alone isn't trustworthy:
  // a stale render, or a race with re-selecting a file mid-analysis, could
  // in principle leave it enabled when one of these conditions no longer
  // holds, and this is the actual gate on whether anything gets written to
  // Supabase, not just whether the button looked clickable.
  function ciCanConfirm() {
    if (ciState.done) return false;
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

  // Purchase price history (price-history.js): the last price each matched
  // item was bought at, read once per item for this document and shown
  // under the line. Lookups only; a failure just leaves the note out.
  function ciLoadLastPrices() {
    const P = window.ORYX_PRICES;
    if (!P || !ciState.rows || ciState.done) return;
    // asked = lookup sent; loaded = answer in (only then may a line say
    // "no earlier purchase" -- not while the lookup is still on its way).
    if (!ciState.lastPrices) ciState.lastPrices = { asked: new Set(), loaded: new Set(), byItem: new Map() };
    const lp = ciState.lastPrices;
    const ids = [...new Set(ciState.rows.map((r) => r.itemId).filter((id) => id && !lp.asked.has(id)))];
    if (!ids.length) return;
    ids.forEach((id) => lp.asked.add(id));
    Promise.resolve(sb.from("inventory_transactions")
      .select("item_id,type,supplier,invoice_number,unit,unit_cost_used,original_unit_cost,original_currency,document_date,created_at")
      .eq("type", "check_in").in("item_id", ids).not("original_unit_cost", "is", null)
      .order("created_at", { ascending: false }).limit(2000))
      .then(({ data, error }) => {
        if (error) throw error;
        if (ciState.lastPrices !== lp) return; // another document since
        for (const [id, t] of P.lastPurchaseByItem(data)) lp.byItem.set(id, t);
        ids.forEach((id) => lp.loaded.add(id));
        if (ciState.rows && !ciState.done) ciRender();
      })
      .catch((err) => console.error("last purchase prices", err));
  }

  function ciMasterItemById(id) {
    for (const arr of (ciState.itemsByCode || new Map()).values()) {
      const hit = arr.find((it) => it.id === id);
      if (hit) return hit;
    }
    return null;
  }

  // "Last bought at …" under a matched line, with a badge when the price
  // differs. No earlier purchase on record: compared with the Master cost.
  function ciPriceNote(r, storedUnitCostAed) {
    const P = window.ORYX_PRICES;
    if (!P || !r.itemId || r.action === "skip" || r.invoiceUnitCost == null || ciState.done) return "";
    const lp = ciState.lastPrices;
    if (!lp || !lp.loaded.has(r.itemId)) return "";
    const last = lp.byItem.get(r.itemId);
    // Costs are per Master Inventory unit (per metre for a converted roll).
    const master = ciMasterItemById(r.itemId);
    const unit = master && master.unit_of_measure ? ` / ${esc(master.unit_of_measure)}` : "";
    const badge = (c) => c.change === "up"
      ? `<span class="badge warn fp-price-badge">Price up ${esc(P.pctText(c).slice(1))}</span>`
      : c.change === "down" ? `<span class="badge grey fp-price-badge">Price down ${esc(P.pctText(c).slice(1))}</span>` : "";
    const showMoney = (n, c) => (c === "AED" ? money(n) : genericMoney(n, c));
    if (last) {
      const c = P.compare({ currency: ciState.currency, unitCost: r.invoiceUnitCost, aed: storedUnitCostAed, unit: r.unit }, last);
      const day = new Date(last.document_date || last.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      const from = [last.supplier, last.invoice_number ? `invoice ${last.invoice_number}` : ""].filter(Boolean).map(esc).join(", ");
      const lastPrice = c && c.basis === "supplier" ? showMoney(last.original_unit_cost, last.original_currency) : money(last.unit_cost_used);
      const now = c ? ` Now ${showMoney(c.after, c.currency)}${unit}${c.change === "same" ? " (same price)" : ""}.` : "";
      const basis = c && c.basis === "aed" ? ` <span class="muted">Compared in AED, stored cost incl. shipping.</span>` : "";
      return `<div class="fp-price-note small">${c ? badge(c) : ""} Last bought at ${lastPrice}${unit} on ${esc(day)}${from ? ` (${from})` : ""}.${now}${basis}</div>`;
    }
    if (!master || !(Number(master.unit_cost) > 0) || !(storedUnitCostAed > 0)) return "";
    const c = P.compare({ currency: "AED", unitCost: storedUnitCostAed, unit: r.unit }, { original_currency: "AED", original_unit_cost: master.unit_cost, unit: r.unit });
    if (!c) return "";
    return `<div class="fp-price-note small">${badge(c)} No earlier purchase on record. Master Inventory cost is ${money(master.unit_cost)}${unit}; this line is ${money(c.after)}${unit}.</div>`;
  }

  function ciRender() {
    // Item photos (same ones as Master Inventory): loaded once, then the
    // preview redraws with them.
    if (!ciState.photos) {
      loadItemPhotos().then((photos) => { ciState.photos = photos; if (ciState.rows && !ciState.done) ciRender(); });
    }
    ciLoadLastPrices();
    const t = ciTally();
    const rate = ciRate();
    const unmatched = ciState.rows.filter((r) => !r.decided && r.status === "unmatched").length;
    const conflictUnmatched = ciState.rows.filter((r) => !r.decided && r.status === "unmatched" && r.codeDescConflict).length;
    const noCodeUnmatched = ciState.rows.filter((r) => !r.decided && r.status === "unmatched" && !r.code && !r.codeDescConflict).length;
    const codedUnmatched = unmatched - noCodeUnmatched - conflictUnmatched;
    const cur = ciState.currency;
    const curLabel = cur || "$"; // display only: "$" until the dollar is chosen
    const shipAlloc = ciShippingAllocation();
    const shippingActiveCount = ciState.rows.filter((r) => r.action === "add" || r.action === "create-new").length;
    const shippingPerItem = ciState.shippingAmountOriginal > 0 && shippingActiveCount > 0
      ? ciState.shippingAmountOriginal / shippingActiveCount
      : null;

    const rowsHtml = ciState.rows.map((r, i) => {
      if (r.creatingNew) {
        const suggestions = findSimilarMasterInventoryItems(r, ciState.itemsByCode);
        // Counted in rolls on the invoice: the stock is kept in metres, so ask
        // for one roll's length (prefilled when the invoice or the stock team
        // states it) and show what it works out to.
        const preConverted = !!(r.packageInfo && r.packageInfo.rollCount != null);
        const rollLine = preConverted || ciIsUnconvertedRollLine(r);
        const rollText = `${r.description || ""} ${(r.source && r.source.description) || ""}`;
        const rollM = preConverted ? r.packageInfo.qtyPerPackage
          : rollLine ? (invoiceRollLengthM(rollText) || knownRollLengthM(rollText)) : null;
        const rolls = ciInvoiceQty(r);
        const rollPrice = preConverted ? r.packageInfo.rollUnitCost : r.invoiceUnitCost;
        const rollHint = (m) => m > 0
          ? `${fmt(rolls)} roll${rolls === 1 ? "" : "s"} × ${fmt(m)} m = ${fmt(Math.round(rolls * m * 100) / 100)} m` +
            (rollPrice != null ? ` at ${curLabel} ${(Math.round(rollPrice / m * 10000) / 10000)}/m` : "") +
            ". Stock is kept in metres. Leave blank to count whole rolls instead."
          : "Enter one roll's length to keep the stock in metres, or leave blank to count whole rolls.";
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
              <h4>${r.code ? `${esc(r.code)} — ` : ""}${esc(r.description)}</h4>
              <p class="small muted">${r.code ? "This code was searched against the Master Inventory and no match was found." : "No Master Inventory item matches this line, and the document didn't print an item code."}
                Fill in the fields below to add it as a new item. Nothing is written until <b>Confirm Check-in</b>.</p>
              ${warn}
              <div class="fp-newitem-grid">
                ${r.code
                  ? `<div class="field"><label>Item code</label><input value="${esc(r.code)}" readonly>
                  <span class="hint">As read from the document — not editable here.</span></div>`
                  : `<div class="field"><label>Item code</label><input id="ciNewCode${i}" placeholder="e.g. 330110" autocomplete="off">
                  <span class="hint">Required. Use the supplier's part number from their price list or catalogue — must not already exist in the Master Inventory.</span></div>`}
                <div class="field"><label>Description</label><input id="ciNewDesc${i}" value="${esc(r.description)}"></div>
                <div class="field"><label>Category</label>
                  <select id="ciNewCategory${i}"><option value="">Select…</option><option>Accessory</option><option>Profile</option><option>Hardware</option></select>
                </div>
                ${rollLine ? `<div class="field full fp-newitem-roll"><label for="ciNewRollM${i}">Metres per roll</label>
                  <input id="ciNewRollM${i}" type="number" step="any" min="0" value="${rollM != null ? rollM : ""}" placeholder="e.g. 30">
                  <span class="hint" id="ciNewRollHint${i}">${esc(rollHint(rollM))}</span></div>` : ""}
                <div class="field"><label>Unit of measure</label><input id="ciNewUnit${i}" value="${esc(rollLine && rollM != null ? "m" : (r.unit || "pcs"))}"></div>
                <div class="field"><label>Opening quantity</label><input value="${rollLine ? `${fmt(rolls)} roll${rolls === 1 ? "" : "s"}` : fmt(r.qty)}" readonly>
                  <span class="hint">= the Check-in quantity for this line${rollLine ? " (as on the invoice)" : ""}.</span></div>
                <div class="field"><label>${rollLine ? "Price per roll" : "Unit cost"} (${esc(curLabel)})</label>
                  <input id="ciNewCost${i}" type="number" step="any" min="0" value="${(rollLine ? rollPrice : r.invoiceUnitCost) != null ? (rollLine ? rollPrice : r.invoiceUnitCost) : ""}" placeholder="e.g. 4.80">
                  <span class="hint">Required — never guessed for a new item.</span></div>
                <div class="field full"><label>Kanban trigger level <span class="opt">(optional — the row turns yellow, Low stock, at this stock)</span></label>
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
            <input type="hidden" id="ciEditItemId${i}" value="${r.itemId ? esc(r.itemId) : ""}">
            <div class="fp-dropdown-results" id="ciEditCodeResults${i}" hidden></div>
            ${!r.itemId ? `<div class="small muted" style="margin-top:2px">Extracted code: <code>${esc(r.code)}</code> — search below to find the right Master Inventory item.</div>` : ""}
          </td>
          <td><input class="fp-inline-input" id="ciEditDesc${i}" type="text" value="${esc(r.description)}" readonly></td>
          <td class="num">${r.current != null ? fmt(r.current) : "—"}</td>
          <td class="num">
            <input class="fp-inline-input fp-inline-input-num" id="ciEditQty${i}" type="number" step="any" min="0" value="${ciInvoiceQty(r)}"${r.packageInfo && r.packageInfo.rollCount != null ? ` title="Quantity as on the invoice (${esc(r.packageInfo.type.toLowerCase())}s), not metres"` : ""}>
            <input class="fp-inline-input fp-inline-input-unit" id="ciEditUnit${i}" type="text" value="${esc(r.unit)}">
          </td>
          <td class="num">—</td>
          <td class="num">${genericMoney(r.invoiceUnitCost, curLabel)}</td>
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
        ? `<span title="Read via a low-confidence fallback (no known document layout matched) -- verify this row against the original document." style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:600;background:#fff3cd;color:#7a5b00;border:1px solid #f0d78c;white-space:nowrap">⚠ low-confidence</span>`
        : "";
      const descriptionMatchBadge = r.matchedByAlias
        ? `<span class="fp-auto-match-note fp-remembered-note" title="Matched from a previous Check-in: someone confirmed that ${esc(r.matchedByAlias.supplier || "this supplier")}'s wording/code means this item (confirmed ${esc(r.matchedByAlias.timesConfirmed)}×). Use Edit if it's wrong — confirming a different item updates the link.">Remembered</span>`
        : r.matchedByDescription
        ? `<span class="fp-auto-match-note" title="Matched automatically from the product description (ignoring extra words like line numbers); supplier code was ${esc(r.matchedByDescription.sourceCode)}.">Auto</span>`
        : "";
      // The invoice's code and description each exactly match a different
      // Master Inventory record -- shown side by side so it's clear this
      // isn't an ordinary "not found" case but a genuine conflict, neither
      // side silently trusted over the other.
      const codeDescConflictNote = r.codeDescConflict ? `<div class="fp-exactdiff">
          <div class="fp-exactdiff-h">Code and description point to different Master Inventory items</div>
          <div><span class="lbl">Invoice code</span> <span class="code">${esc(r.code)}</span> matches Master Inventory item <span class="code">${esc(r.codeDescConflict.codeItemCode)}</span>.</div>
          <div><span class="lbl">Invoice description</span> "${esc(r.description)}" matches Master Inventory item <span class="code">${esc(r.codeDescConflict.descItemCode)}</span>.</div>
          <div class="fp-exactdiff-warn">⚠ Not auto-matched — pick the correct item via Edit.</div>
        </div>` : "";
      // A series-tolerant or close description match -- offered, never
      // applied, until the person clicks "Use this item".
      const suggestionNote = r.status === "unmatched" && !r.decided && r.suggestedItem ? `<div class="fp-exactdiff">
          <div class="fp-exactdiff-h">Possible match in Master Inventory</div>
          <div class="fp-ci-item">${itemPhotoButton(ciState.photos, { item_code: r.suggestedItem.code, description: r.suggestedItem.description }, "fp-photo-sm")}<div><span class="code">${esc(r.suggestedItem.code)}</span> — ${esc(r.suggestedItem.description)}${r.suggestedItem.barLengthMm != null ? ` <span class="small muted">(${esc(r.suggestedItem.barLengthMm)} mm)</span>` : ""}</div></div>
          <div class="small muted">${esc(r.suggestedItem.note || "")} Not added unless you confirm.</div>
          <div class="fp-row-actions"><button data-act="use-suggestion" data-i="${i}" class="on">Use this item</button></div>
        </div>` : "";
      // The exact code exists in Master Inventory, but the invoice's own
      // Unit text doesn't match what's on file for it -- shown side by
      // side so the difference is visible before anyone decides anything,
      // exactly as it was found (no conversion, no guessed value).
      const exactDiffNote = r.status === "exact-diff" ? `<div class="fp-exactdiff">
          <div class="fp-exactdiff-h">Exact Item Code found in Master Inventory</div>
          <div><span class="lbl">Master Inventory:</span> <span class="code">${esc(r.exactMatchItem.code)}</span> — ${esc(r.exactMatchItem.description)} · Unit: <b>${esc(r.exactMatchItem.unit || "—")}</b></div>
          <div><span class="lbl">Supplier Invoice:</span> <span class="code">${esc(r.code)}</span> — ${esc(r.description || "—")} · Unit: <b>${esc(r.unit || "—")}</b></div>
          <div class="fp-exactdiff-warn">⚠ Package length differs: supplier document ${esc(r.exactMatchItem.invoicePackSize)}, Master Inventory ${esc(r.exactMatchItem.packSize)}. Review before using. No conversion is applied automatically.</div>
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
      const expandedPackage = pkgForDisplay && pkgForDisplay.rollCount != null && pkgForDisplay.unit === "m";
      const storedUnitCostAed = storedInventoryUnitCostAed(r, landedUnitCost, rate);
      const unitCostDisplay = expandedPackage
        ? `${genericUnitMoney(r.invoiceUnitCost, curLabel, "m")}
           <div class="small muted">${genericMoney(pkgForDisplay.rollUnitCost, curLabel)} / ${esc(pkgForDisplay.type.toLowerCase())}</div>
           <div class="small muted">Stored: ${money(storedUnitCostAed)} / m</div>`
        : genericMoney(r.invoiceUnitCost, curLabel);
      const landedUnitCostDisplay = landedUnitCost == null
        ? "—"
        : expandedPackage
        ? genericUnitMoney(landedUnitCost, curLabel, "m")
        : genericMoney(landedUnitCost, curLabel);
      return `<tr class="${rowClass}">
        <td class="code"><div class="fp-checkin-code-cell"><span>${esc(r.code)}</span>${descriptionMatchBadge}${reviewFlag}${lowConfBadge}</div></td>
        <td><div class="fp-checkin-description-cell">${r.itemId
          ? `<div class="fp-ci-item">${itemPhotoButton(ciState.photos, { item_code: r.code, description: r.description }, "fp-photo-sm")}<span>${esc(r.description)}${r.addedByHand ? `<span class="small muted" style="display:block">${esc(["Added by hand", r.handLengthMm ? `${Math.round(r.handLengthMm)} mm` : ""].filter(Boolean).join(" · "))}</span>` : ""}</span></div>`
          : `<span>${esc(r.description)}</span>`}${ciPriceNote(r, storedUnitCostAed)}${exactDiffNote}${packReviewNote}${usedDiffNote}${codeDescConflictNote}${suggestionNote}</div></td>
        <td class="num">${r.current != null ? fmt(r.current) : "—"}</td>
        <td class="num" style="color:var(--brand); font-weight:600">${qtyDisplay}</td>
        <td class="num">${r.newQty != null ? fmt(r.newQty) : "—"}</td>
        <td class="num">${unitCostDisplay}</td>
        <td class="num">${shipAllocForRow > 0 ? genericMoney(shipAllocForRow, curLabel) : "—"}</td>
        <td class="num">${landedUnitCostDisplay}</td>
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
        ${noCodeUnmatched > 0 ? `<li><b>${noCodeUnmatched} row${noCodeUnmatched === 1 ? " has" : "s have"} no item code</b> —
          click Edit and map ${noCodeUnmatched === 1 ? "it" : "each one"} to the correct Master Inventory item, or click + New item
          (and enter its code) if it isn't in the Master Inventory yet. Where the document has no price, the existing Master Inventory
          cost is used; no price is guessed. Acknowledge only if the row should be skipped.</li>` : ""}
        ${codedUnmatched > 0 ? `<li><b>${codedUnmatched} unmatched item${codedUnmatched === 1 ? "" : "s"}</b> — code not in the Master Inventory.
          Not checked in; click Edit and pick the correct item from the Master Inventory list, or Acknowledge
          to confirm you've seen it. A new Master Inventory item is never created from here.
          </li>` : ""}
        ${conflictUnmatched > 0 ? `<li><b>${conflictUnmatched} item${conflictUnmatched === 1 ? "" : "s"} with a code/description conflict</b> —
          the invoice's code and description each exactly match a <i>different</i> Master Inventory item. Neither is trusted
          automatically; click Edit to review both and pick the correct one, or Acknowledge to confirm you've seen it.</li>` : ""}
        ${unmatched > 0 ? `<li class="fp-batch-actions"><button data-act="skip-all-unmatched" data-i="-1">Acknowledge all unmatched</button></li>` : ""}
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
        best-effort normaliser that pieces scattered fields back into the standard preview table. This is more likely to misread a code, quantity or
        price than the reader's normal formats — check every row below (marked ⚠ low-confidence) against the original
        document before confirming.</p>
      <label style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12.5px">
        <input type="checkbox" id="ciLowConfAck" ${ciState.lowConfidenceAcknowledged ? "checked" : ""}>
        I've checked every row below against the original document.
      </label>
    </div>` : "";

    const rateDateNote = ciState.rateDate ? ` (rate date ${esc(ciState.rateDate)})` : "";
    const sourceLabel = RATE_SOURCE_LABEL[ciState.rateSource] || ciState.rateSource;
    // Bare "$": which dollar is asked here (or shown, with how it was
    // detected, and changeable) -- never assumed silently.
    const dollarDoc = /^dollar-/.test(ciState.currencyBasis || "");
    const dollarPicker = dollarDoc ? `<div>
            <label class="field-label" for="ciDollarCurrency">Which dollar? (document shows "$" only)</label>
            <select id="ciDollarCurrency">
              ${cur ? "" : `<option value="" selected>Choose USD or AUD…</option>`}
              <option value="USD" ${cur === "USD" ? "selected" : ""}>USD — US dollar</option>
              <option value="AUD" ${cur === "AUD" ? "selected" : ""}>AUD — Australian dollar</option>
            </select>
          </div>` : "";
    // Normally nothing to do: one short line (currency, rate, total) with a
    // "Change" link that opens the full card. The full card shows by itself
    // only when a rate is missing and has to be typed in.
    const rateMissing = ciState.rateSource === "unavailable" || rate == null;
    const rateOld = ciState.rateSource === "cache-fallback" || ciState.rateSource === "api-latest-fallback";
    const prettyRateDate = (() => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ciState.rateDate || "");
      if (!m) return "";
      const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m[2] - 1];
      return ` <span class="fp-currency-muted">(rate of ${+m[3]} ${mon} ${m[1]})</span>`;
    })();
    const compactCurrency = cur && cur !== "AED" && !rateMissing && !ciState.showCurrencyEdit;
    const currencyCard = compactCurrency
      ? `<div class="fp-currency-card fp-currency-compact">
          <span>Prices in <b>${esc(cur)}</b>, converted to AED automatically at <b>1 ${esc(cur)} = ${esc(String(rate))} AED</b>${prettyRateDate}</span>
          <button type="button" id="ciCurrencyChange" class="fp-currency-change">Change</button>
          ${rateOld ? `<div class="fp-currency-note">Today's rate couldn't be fetched, so an older one is used — check it if the amount matters.</div>` : ""}
        </div>`
      : !cur
      ? `<div class="fp-currency-card">
          ${dollarPicker}
          <div class="fp-currency-note" style="color:var(--danger)">This document shows prices as "$" without saying which dollar, and nothing else on it
            (an ABN, an address, a currency code) tells USD from AUD. Choose the currency above — the exchange rate for the invoice date is then
            fetched and every price converted to AED automatically. Confirm stays locked until it's chosen.</div>
        </div>`
      : cur === "AED"
      ? `<div class="fp-currency-card"><div class="fp-currency-note">Document is already in AED — no conversion needed.</div></div>`
      : `<div class="fp-currency-card">
          ${dollarPicker || `<div><label class="field-label">Original currency</label><strong>${esc(cur)}</strong></div>`}
          <div><label class="field-label">Original amount</label><strong>${genericMoney(t.totalValueOriginal, cur)}</strong></div>
          <div>
            <label class="field-label" for="ciRateInput">Exchange rate (1 ${esc(cur)} = ? AED)</label>
            <input id="ciRateInput" type="number" step="any" min="0" value="${rate != null ? rate : ""}" placeholder="e.g. 2.45">
          </div>
          <div><label class="field-label">AED amount</label><strong>${t.totalValueAed != null ? money(t.totalValueAed) : "—"}</strong></div>
          ${rateMissing ? "" : `<button type="button" id="ciCurrencyDone" class="ghost">Done</button>`}
          <div class="fp-currency-note">${
            ciState.rateSource === "unavailable"
              ? `Could not retrieve an exchange rate for ${esc(cur)} from the currency API, and none is on file — flagged for review. Enter the current rate to continue.`
              : `Rate source: ${esc(sourceLabel)}${rateDateNote}. ${ciState.rateSource === "cache-fallback" || ciState.rateSource === "api-latest-fallback" ? "Check it's still current before confirming." : ""}`
          }${CURRENCY_BASIS_NOTE[ciState.currencyBasis] ? ` ${esc(CURRENCY_BASIS_NOTE[ciState.currencyBasis])}` : ""}</div>
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
        <div><label class="field-label" for="ciShippingInput">Shipping / freight / packing cost (${esc(curLabel)})</label>
          <input id="ciShippingInput" type="number" step="any" min="0"
            value="${ciState.shippingAmountOriginal != null ? ciState.shippingAmountOriginal : ""}" placeholder="0.00"></div>
        <div><label class="field-label">Inventory line items</label><strong>${shippingActiveCount}</strong></div>
        <div><label class="field-label">Shipping per item</label><strong>${shippingPerItem != null ? genericMoney(shippingPerItem, curLabel) : "—"}</strong></div>
        <div class="fp-currency-note">${esc(shippingGuidance)}</div>
      </div>`;

    const keptEdits = keepOpenEdits($("#ciOut"), ciState.rows);
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
      <div class="fp-scroll fp-checkin-scroll">
        <table class="fp-table fp-checkin-table">
          <thead><tr>
            <th>Code</th><th>Description</th>
            <th class="num">Current stock</th>
            <th class="num">Check-in qty</th>
            <th class="num">New stock</th>
            <th class="num">Unit cost (${esc(curLabel)})</th>
            <th class="num">Shipping alloc. (${esc(curLabel)})</th>
            <th class="num">Landed unit cost (${esc(curLabel)})</th>
            <th class="num">Value (AED)${ciState.shippingAmountOriginal > 0 ? " incl. shipping" : ""}</th>
            <th>Status</th><th>Action</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${ciState.rows.length ? "" : `<p class="small muted">Every line has been deleted from this Check-in — there is nothing left to add.</p>`}
      ${ciState.done ? "" : `<div class="fp-actions" style="margin-top:var(--space-3)"><button class="ghost" type="button" id="ciAddMore">+ Add more items</button></div>`}
      ${deletedItemsBox(ciState.deletedRows, "Check-in", "not acknowledged and not added to the Master Inventory.",
        (row) => esc([fmt(row.qty), row.unit].filter(Boolean).join(" ")))}
      <p class="small muted" style="margin-top:var(--space-3)">Nothing has been added yet.
      The confirm button unlocks once every unmatched row has been edited or acknowledged${cur !== "AED" ? " and the exchange rate is entered" : ""}.</p>
    `;

    const canConfirm = ciCanConfirm();
    $("#ciConfirmSummary").textContent =
      `${t.totalItems} items · ${t.totalValueAed != null ? money(t.totalValueAed) : "—"}` + (t.skipped ? ` · ${t.skipped} skipped` : "");
    $("#ciConfirmBar").hidden = !!ciState.done;
    $("#ciConfirm").disabled = !canConfirm || !!ciState.confirming;

    document.querySelectorAll("#ciOut .fp-row-actions button, #ciOut .fp-batch-actions button, #ciOut .fp-code-review-flag").forEach((b) => {
      b.addEventListener("click", () => applyCiRowAction(+b.dataset.i, b.dataset.act));
    });
    restoreOpenEdits(keptEdits, ciState.rows);
    // New item for a roll line: the "2 rolls × 30 m = 60 m" hint and the
    // unit follow the Metres per roll box as it's typed.
    ciState.rows.forEach((r, i) => {
      const rollEl = r.creatingNew && document.getElementById(`ciNewRollM${i}`);
      if (!rollEl) return;
      const hintEl = document.getElementById(`ciNewRollHint${i}`);
      const unitEl = document.getElementById(`ciNewUnit${i}`);
      const costEl = document.getElementById(`ciNewCost${i}`);
      const update = () => {
        const m = parseFloat(rollEl.value);
        const price = parseFloat(costEl && costEl.value);
        const n = ciInvoiceQty(r);
        const rolls = `${fmt(n)} roll${n === 1 ? "" : "s"}`;
        hintEl.textContent = m > 0
          ? `${rolls} × ${fmt(m)} m = ${fmt(Math.round(n * m * 100) / 100)} m` +
            (price > 0 ? ` at ${ciState.currency || "$"} ${Math.round(price / m * 10000) / 10000}/m` : "") +
            ". Stock is kept in metres. Leave blank to count whole rolls instead."
          : "Enter one roll's length to keep the stock in metres, or leave blank to count whole rolls.";
        unitEl.readOnly = m > 0;
        if (m > 0) unitEl.value = "m";
        else if (unitEl.value === "m") unitEl.value = r.unit && r.unit !== "m" ? r.unit : "roll";
      };
      rollEl.addEventListener("input", update);
      if (costEl) costEl.addEventListener("input", update);
      update();
    });
    ciState.rows.forEach((r, i) => { if (r.editing) wireCodePicker("ciEdit", ciState.itemsByCode, i); });
    document.querySelectorAll("#ciOut [data-mi-photo]").forEach((b) => {
      b.onclick = () => openItemPhoto(b.dataset.miPhoto, b.dataset.miPhotoCap);
    });
    const ciAddMore = document.getElementById("ciAddMore");
    if (ciAddMore) ciAddMore.onclick = async () => {
      // Opens the hand-entry table (above the list) and takes the person there.
      const panel = $("#ciManualPanel");
      if (panel.hidden) await ciManualToggle(); else ciManualUpdateHint();
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
      const search = panel.querySelector("[id^='ciManCodeSearch']");
      if (search) search.focus({ preventScroll: true });
    };
    const currencyChange = document.getElementById("ciCurrencyChange");
    if (currencyChange) currencyChange.onclick = () => {
      ciState.showCurrencyEdit = true;
      ciRender();
      const first = document.getElementById("ciDollarCurrency") || document.getElementById("ciRateInput");
      if (first) first.focus();
    };
    const currencyDone = document.getElementById("ciCurrencyDone");
    if (currencyDone) currencyDone.onclick = () => {
      ciState.showCurrencyEdit = false;
      ciRender();
    };
    const dollarSelect = document.getElementById("ciDollarCurrency");
    if (dollarSelect) {
      dollarSelect.addEventListener("change", async () => {
        if (!dollarSelect.value) return;
        ciState.currency = dollarSelect.value;
        ciState.currencyBasis = "dollar-chosen";
        ciState.showCurrencyEdit = false;
        dollarSelect.disabled = true;
        await ciLoadExchangeRate($("#ciDocDate").value || null);
        ciStatus(ciState.exchangeRate
          ? `Currency set to ${ciState.currency}; exchange rate ${ciState.exchangeRate} AED from ${RATE_SOURCE_LABEL[ciState.rateSource]}.`
          : `Currency set to ${ciState.currency}, but no exchange rate could be fetched — enter it in the box below.`);
        ciRender();
      });
    }
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
          // Same landed-cost rule as the preview (a roll's shipping share is
          // spread over its metres).
          const landedUnitCost = ciLandedUnitCost(i, shipAlloc);
          return {
            item_id: null, quantity: r.qty, unit: r.unit,
            unit_cost: storedInventoryUnitCostAed(r, landedUnitCost, rate),
            package_type: r.packageInfo ? r.packageInfo.type : null,
            package_qty: r.packageInfo ? r.packageInfo.rollCount : null,
            qty_per_package: r.packageInfo ? r.packageInfo.qtyPerPackage : null,
            package_unit: r.packageInfo ? r.packageInfo.unit : null,
            package_cost: r.packageInfo ? r.packageInfo.rollUnitCost * rate : null,
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
        const storedUnitCostAed = storedInventoryUnitCostAed(r, landedUnitCost, rate);
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
          unit_cost: storedUnitCostAed,
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

    // Teach once, remember: same rows, same order as `lines` above. Only a
    // decision a person made (Edit / Use this item / New item / Use existing
    // / confirmed pack) or a remembered link being re-confirmed is sent --
    // automatic matches don't need remembering. The server saves these only
    // after the stock itself was saved.
    const sentRows = ciState.rows.filter((r) => (r.action === "add" && r.itemId) || (r.action === "create-new" && r.newItemData));
    const supplierKeyForLinks = supplierKey(supplier);
    sentRows.forEach((r, k) => {
      if (!r.source || !(r.personResolved || r.matchedByAlias) || !supplierKeyForLinks) return;
      const ownCode = r.source.supplierRef || r.source.code;
      // A code that IS a Master code needs no link -- it already matches.
      const codeKey = ownCode && !lookupExactCode(ciState.itemsByCode, ownCode).length ? aliasCodeKey(ownCode) : "";
      const descriptionKey = aliasDescriptionKey(r.source.description);
      if (!codeKey && !descriptionKey) return;
      lines[k].remember = { supplier_key: supplierKeyForLinks, code_key: codeKey || null, description_key: descriptionKey || null, example: r.source.description || ownCode };
    });

    const pdfFile = ciState.pdfFile, pdfHash = ciState.pdfHash;
    const res = await fetch(CHECKIN_FN_URL, await confirmRequest({
      supplier, invoice_number: invoiceNumber, po_number: poNumber, document_date: docDate,
      pdf_hash: pdfHash,
      source_document_name: pdfFile ? pdfFile.name : null,
      currency: ciState.currency, exchange_rate: rate,
      rate_date: ciState.rateDate, rate_source: ciState.rateSource,
      lines,
    }, pdfHash ? pdfFile : null));
    const data = await readFnJson(res);

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

    ciState.done = true;
    $("#ciConfirmBar").hidden = true;
    document.querySelectorAll("#ciOut button, #ciOut input, #ciOut select").forEach((b) => { b.disabled = true; });
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
        Inventory and the Transaction History now reflect this. A permanent Check-in transaction has been recorded for each item.${currencyNote}${shippingNote}${
          data.remembered > 0 ? ` Lines you matched by hand will match automatically next time.` : ""}</p>
        ${keptDocNote(data, pdfHash ? pdfFile : null, pdfHash, "check_in")}
        <div class="fp-done-actions">
          <button class="ghost" id="ciNew">Start another Check-in</button>
        </div>
      </div>`;
    wireDocRetry($("#ciDone"), "check_in", pdfFile, pdfHash);
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
      let [pages, itemsByCode, hash, ratesByCurrency, aliases] = await Promise.all([
        extractPdfTextPerPage(ciState.pdfFile),
        loadInventoryItems(),
        pdfFingerprint(ciState.pdfFile),
        loadExchangeRates(),
        loadSupplierAliases(),
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
      ciState.lastPrices = null; // re-read: the last document may have just been saved
      ciState.header = parseCheckinHeader(pdfText, ciState.usedOcr ? null : pages.items);
      ciState.ratesByCurrency = ratesByCurrency;
      const currencyInfo = detectDocumentCurrencyInfo(pdfText);
      ciState.currency = currencyInfo.currency;
      ciState.currencyBasis = currencyInfo.basis;

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
      const doc = parseCheckinDocument(pdfText, ciState.usedOcr ? null : pages.items);
      if (doc.reconciliation && !doc.reconciliation.ok) {
        ciState.rows = null;
        $("#ciConfirmBar").hidden = true;
        $("#ciDone").innerHTML = "";
        ciStatus(`The document rows did not reconcile to its printed total (${genericMoney(doc.reconciliation.parsedTotal, ciState.currency || "$")} parsed versus ${genericMoney(doc.reconciliation.expectedTotal, ciState.currency || "$")} printed). Check-in has been blocked so incomplete stock cannot be added.`, "err");
        return;
      }
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
          ciRenderChargeOnly(chargeOnly);
          ciStatus(`Document read successfully — one non-stock charge found. The Master Inventory has not been changed.`);
        } else {
          ciStatus("This document isn't in a layout this reader recognises yet — no line items were found, so nothing can be checked in. The Master Inventory has not been changed.", "err");
        }
        return;
      }
      ciState.missingLnNumbers = doc.missingLnNumbers || [];
      ciState.missingLnAcknowledged = false;
      ciState.lowConfidenceFallback = doc.formatId === "greedy-tokens" || doc.formatId === "layoutless-standardized";

      // Landed Cost: a convenience prefill only -- always shown editable in
      // the preview (see ciRender's shippingCard) before Confirm is ever
      // reachable, so an ambiguous or missed detection can always be
      // corrected by hand rather than silently applied or silently dropped.
      const shipping = detectShippingCharge(pdfText);
      ciState.shippingAmountOriginal = shipping.amount;
      ciState.shippingNote = shipping.note;
      ciState.shippingNeedsReview = shipping.needsReview;

      await ciLoadExchangeRate(dEl.value || null);

      // Commercial Invoice descriptions live in a separate block of the PDF
      // (see parseCommercialInvoiceDescriptions above); every other format
      // captures its description inline, directly on each entry already.
      const descriptions = doc.formatId === "commercial-invoice"
        ? parseCommercialInvoiceDescriptions(pdfText, doc.entries.length)
        : [];
      if (isStale()) return;
      ciState.rows = buildCheckinRows(doc.entries, descriptions, itemsByCode, buildAliasIndex(aliases), $("#ciSupplier").value || ciState.header.supplier);
      ciState.deletedRows = [];
      ciRender();

      const t = ciTally();
      const rateNote = !ciState.currency
        ? " Prices are in \"$\" with nothing on the document saying which dollar — choose USD or AUD in the currency box below; the rate is then fetched automatically."
        : ciState.currency !== "AED"
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
      const manualMappingNote = doc.requiresManualMapping
        ? " This packing list has quantities but no item codes or prices. Map every row to the correct Master Inventory item with Edit; its existing cost will be retained."
        : "";
      const reconciliationNote = doc.reconciliation && doc.reconciliation.ok
        ? ` Parsed rows reconcile to the printed document total of ${genericMoney(doc.reconciliation.expectedTotal, ciState.currency || "$")}.`
        : "";
      ciStatus(`Analysis ready — ${ciState.header.docType || "document"} read via ${doc.formatLabel}, ${doc.entries.length} line${doc.entries.length === 1 ? "" : "s"} found in ${ciState.currency || "\"$\" (choose USD or AUD below)"}, ${t.unresolved} need decisions.${rateNote}${gapNote}${ocrNote}${lowConfNote}${manualMappingNote}${reconciliationNote}`);
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
    ciState.lastPrices = null;
    ciState.deletedRows = [];
    ciState.done = false;
    ciManualItemsPromise = null; // next manual entry reloads current stock
    ciState.currency = "AED"; ciState.currencyBasis = "none"; ciState.exchangeRate = 1; ciState.ratesByCurrency = null; ciState.showCurrencyEdit = false;
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
    $("#ciManualPanel").hidden = true;
    $("#ciManualBody").innerHTML = "";
    $("#ciManualStatus").textContent = "";
    ciManualRowCount = 0;
    ciStatus("");
  }

  /* --------------------------- Manual entry (unreadable PDF) -- */

  // Same fallback as Check-out's manual entry, for the Check-in side. Always
  // AED, rate 1 -- like the Master Inventory "Adjust" manual correction, this
  // is a person typing in what a document said, not a re-derivation of its
  // currency; if the source document was in another currency, the person
  // entering it converts the unit cost by hand before typing it in.
  let ciManualRowCount = 0;
  let ciManualItemsByCode = null;

  function ciManualRowHtml(i) {
    return `<tr data-man-row="${i}">
      <td class="fp-code-picker">
        <input class="fp-inline-input" id="ciManCodeSearch${i}" type="text" placeholder="Search code or description" autocomplete="off">
        <input type="hidden" id="ciManCodeValue${i}" value="">
        <input type="hidden" id="ciManItemId${i}" value="">
        <input type="hidden" id="ciManDesc${i}" value="">
        <div class="fp-dropdown-results" id="ciManCodeResults${i}" hidden></div>
      </td>
      <td class="num"><input class="fp-inline-input fp-inline-input-num" id="ciManQty${i}" type="number" step="any" min="0" placeholder="0"></td>
      <td class="num"><input class="fp-inline-input fp-inline-input-num" id="ciManCost${i}" type="number" step="any" min="0" placeholder="AED"></td>
      <td><button class="ghost" type="button" data-man-remove="${i}">Remove</button></td>
    </tr>`;
  }

  // Same in-flight-promise cache as Check-out's manual entry, and for the
  // same reason: "Add another item" clicked before the first load finishes
  // must never wire a row against a still-null Master Inventory.
  let ciManualItemsPromise = null;
  function ciManualLoadItems() {
    if (!ciManualItemsPromise) {
      ciManualItemsPromise = loadInventoryItems().catch((err) => { ciManualItemsPromise = null; throw err; });
    }
    return ciManualItemsPromise;
  }

  // Hand-entered costs are in the currency of the Check-in they join: AED
  // for a new hand-entry Check-in, or the invoice's own currency when they're
  // added to an invoice being reviewed -- so they're converted at the same
  // rate as the invoice's other lines, never twice.
  function ciManualCurrency() {
    return ciState.rows && !ciState.done ? (ciState.currency || "AED") : "AED";
  }

  function ciManualUpdateHint() {
    const existing = ciState.rows && !ciState.done ? ciState.rows.length : 0;
    const cur = ciManualCurrency();
    $("#ciManualHint").innerHTML = existing
      ? `Pick each item, type how many arrived and the unit cost in <b>${esc(cur)}</b>. They're <b>added</b> to the ${existing} line${existing === 1 ? "" : "s"} already in this Check-in.`
      : "Pick each item, type how many arrived and the unit cost in AED, then press <b>Add to Check-in</b>.";
    $("#ciManCostHead").textContent = `Unit cost (${cur})`;
    document.querySelectorAll("#ciManualBody [id^='ciManCost']").forEach((el) => { el.placeholder = cur; });
  }

  async function ciManualAddRow() {
    const i = ciManualRowCount++;
    $("#ciManualBody").insertAdjacentHTML("beforeend", ciManualRowHtml(i));
    $(`#ciManCost${i}`).placeholder = ciManualCurrency();
    $(`[data-man-remove="${i}"]`).addEventListener("click", () => {
      const row = document.querySelector(`[data-man-row="${i}"]`);
      if (row) row.remove();
    });
    try {
      ciManualItemsByCode = await ciManualLoadItems();
      wireCodePicker("ciMan", ciManualItemsByCode, i);
    } catch (err) {
      $("#ciManualStatus").textContent = "Could not load the Master Inventory: " + err.message;
    }
  }

  async function ciManualToggle() {
    const panel = $("#ciManualPanel");
    panel.hidden = !panel.hidden;
    ciManualUpdateHint();
    if (!panel.hidden && !ciManualRowCount) {
      $("#ciManualStatus").textContent = "Loading Master Inventory…";
      await ciManualAddRow();
      $("#ciManualStatus").textContent = "";
    }
  }

  function ciManualUse() {
    const rowEls = [...document.querySelectorAll("#ciManualBody [data-man-row]")];
    if (!rowEls.length) { $("#ciManualStatus").textContent = "Add at least one item first."; return; }
    const rows = [];
    for (const rowEl of rowEls) {
      const i = rowEl.dataset.manRow;
      const code = $(`#ciManCodeValue${i}`).value;
      const qty = parseFloat($(`#ciManQty${i}`).value);
      const unitCostInput = $(`#ciManCost${i}`).value;
      if (!code) { $("#ciManualStatus").textContent = "Every row needs a Master Inventory item selected."; return; }
      if (!(qty > 0)) { $("#ciManualStatus").textContent = "Every row needs a quantity greater than 0."; return; }
      const item = pickedInventoryRow(ciManualItemsByCode, code, $(`#ciManItemId${i}`).value, { kind: "checkin" });
      if (!item) { $("#ciManualStatus").textContent = "One of the selected items could not be found — please re-pick it."; return; }
      // No document price entered -- send null, not a fabricated 0, so
      // Confirm falls back to the Master Inventory's own unit_cost instead
      // of recording a false free cost (same rule buildCheckinRows follows).
      const unitCost = unitCostInput === "" ? null : parseFloat(unitCostInput);
      if (unitCost !== null && !(unitCost >= 0)) { $("#ciManualStatus").textContent = "Unit cost can't be negative — leave it blank to use the Master Inventory cost."; return; }
      rows.push({
        code: item.item_code, description: item.description, unit: item.unit_of_measure || "", qty,
        addedByHand: true, handLengthMm: item.bar_length_mm || null,
        invoiceUnitCost: unitCost,
        current: item.current_qty, newQty: item.current_qty + qty,
        status: "ok", action: "add", decided: true,
        itemId: item.id, editing: false, truncatedHint: false,
        lowConfidence: false, matchedByDescription: null, packageInfo: null,
      });
    }
    $("#ciManualStatus").textContent = "";
    // Clear the hand-entry table for the next lot.
    $("#ciManualBody").innerHTML = "";
    ciManualRowCount = 0;
    $("#ciManualPanel").hidden = true;
    const added = `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    if (ciState.rows && !ciState.done) {
      // A Check-in is already being reviewed (an invoice or earlier hand
      // entry): add to it. The document, its currency and rate, shipping and
      // any warnings stay exactly as they were.
      ciState.rows.push(...rows);
      ciRender();
      ciStatus(`Added ${added} by hand. The Check-in now has ${ciState.rows.length} lines.`);
      $("#ciOut").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    ciState.pdfFile = null;
    ciState.pdfHash = null;
    ciState.header = {};
    ciState.itemsByCode = ciManualItemsByCode;
    ciState.lastPrices = null;
    ciState.currency = "AED"; ciState.currencyBasis = "none"; ciState.exchangeRate = 1; ciState.rateDate = null; ciState.rateSource = "n/a"; ciState.showCurrencyEdit = false;
    ciState.shippingAmountOriginal = null; ciState.shippingNote = ""; ciState.shippingNeedsReview = false;
    ciState.usedOcr = false; ciState.ocrAcknowledged = false; ciState.ocrStillUnreadablePages = [];
    ciState.lowConfidenceFallback = false; ciState.lowConfidenceAcknowledged = false;
    ciState.missingLnNumbers = []; ciState.missingLnAcknowledged = false;
    ciState.done = false;
    ciState.rows = rows;
    ciState.deletedRows = [];
    ciRender();
    ciStatus(`${added} added by hand, ready for review.`);
    $("#ciOut").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function ciStatus(text, kind) {
    const el = $("#ciStatus");
    el.textContent = text || "";
    el.style.color = kind === "err" ? "var(--danger)" : "";
  }

  function ciRenderChargeOnly(charge) {
    const cur = ciState.currency || "AED";
    $("#ciOut").innerHTML = `
      <div class="fp-section-h">Document preview</div>
      <div class="fp-scroll">
        <table class="fp-table">
          <thead><tr>
            <th>Type</th>
            <th>Source description</th>
            <th class="num">Amount</th>
            <th>Inventory action</th>
          </tr></thead>
          <tbody><tr>
            <td>Shipping / freight / packing charge</td>
            <td>${esc(charge.label || "Charge")}</td>
            <td class="num">${esc(genericMoney(charge.amount, cur))}</td>
            <td><span class="fp-status-review"><span class="fp-dot"></span>Not added to stock</span></td>
          </tr></tbody>
        </table>
      </div>
      <div class="fp-warn" style="margin-top:var(--space-3)">
        <h4>Cost only — no goods to receive</h4>
        <p class="small" style="margin:0">This document contains a separate charge, not an inventory item. Apply the cost to the related goods invoice when its items are checked in. Confirm Check-in stays unavailable, so this preview cannot change stock.</p>
      </div>`;
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
      ciState.deletedRows = [];
      ciState.header = null;
      ciState.missingLnNumbers = []; ciState.missingLnAcknowledged = false;
      ciState.shippingAmountOriginal = null; ciState.shippingNote = ""; ciState.shippingNeedsReview = false;
      ciState.usedOcr = false; ciState.ocrAcknowledged = false; ciState.ocrStillUnreadablePages = [];
      ciState.lowConfidenceFallback = false; ciState.lowConfidenceAcknowledged = false;
      // A replacement PDF is a new Check-in. Never carry supplier/reference
      // values auto-filled from the previous document into the new one.
      $("#ciSupplier").value = ""; $("#ciInvoiceNumber").value = "";
      $("#ciPoNumber").value = ""; $("#ciDocDate").value = "";
      $("#ciOut").innerHTML = "";
      $("#ciDone").innerHTML = "";
      $("#ciConfirmBar").hidden = true;
      ciStatus("");
      $("#ciPdfName").textContent = f.name;
      dropEl.classList.add("ready");
      $("#ciExtract").disabled = false;
    });
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { ciAnalyse, ciConfirm, ciManualAddRow, ciManualToggle, ciManualUse, ciRender, ciResetAll,
    ciStatus, wireCiDrop });
})();
