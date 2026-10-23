/* Check-out: Allocation Preview, Confirm, manual entry, reset and wiring of the Check-out screen.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, buildRows, CHECKOUT_FN_URL, confirmRequest, deleteBtnAttrs, esc, extractPdfText, fmt,
    keptDocNote, loadInventoryItems, money, parseJobHeader, parsePdf, pdfFingerprint, readFnJson,
    recomputeAfterEdit, state, wireDocRetry, itemPhotoCell, keepOpenEdits, keepListScroll, restoreListScroll, loadItemPhotos,
    openItemPhoto, pickedInventoryRow, restoreOpenEdits, wireCodePicker } = FP;

  function statusChip(status) {
    if (status === "ok") return `<span class="fp-status-ok">Matched</span>`;
    if (status === "shortage") return `<span class="fp-status-short">Below zero, allowed</span>`;
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

  // Stock is checked per Master row, not per line: two lines of 6 against 10
  // in stock is a shortage of 2 on both. Negative stock is still allowed --
  // this only makes sure the preview says so.
  function applyCombinedStock(rows) {
    const totals = new Map();
    for (const r of rows) {
      if (r.itemId && r.action === "deduct") totals.set(r.itemId, (totals.get(r.itemId) || 0) + r.requiredQty);
    }
    for (const r of rows) {
      if (!r.itemId || r.available == null || !(r.baseStatus === "ok" || r.baseStatus === "shortage")) continue;
      const needed = r.action === "deduct" ? totals.get(r.itemId) : r.requiredQty;
      r.remaining = r.available - needed;
      r.status = r.baseStatus = r.remaining < 0 ? "shortage" : "ok";
    }
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

  // "Deleted items" box shared by Check-out and Check-in. Each deleted row is
  // kept whole ({row, index}) so Restore can put it back exactly as it was,
  // at its original position -- nothing is written until Confirm, so a
  // deletion can always be undone before then. The Restore buttons sit in
  // .fp-row-actions so each page's existing button wiring handles them.
  function deletedItemsBox(deleted, pageName, consequence, qtyOf) {
    if (!deleted || !deleted.length) return "";
    return `<div class="fp-removed-note">
      <b>${deleted.length} item${deleted.length === 1 ? "" : "s"} deleted from this ${pageName}</b> — ${consequence}
      Click <b>Restore</b> to put an item back exactly as it was.
      <ul class="fp-removed-list">${deleted.map((d, k) => `<li>
        <span>${d.row.code ? `<span class="code">${esc(d.row.code)}</span> — ` : ""}${esc(d.row.description || "")} (${qtyOf(d.row)})</span>
        <span class="fp-row-actions"><button data-act="restore" data-i="${k}" title="Put this item back in the list">Restore</button></span>
      </li>`).join("")}</ul>
    </div>`;
  }
  function deleteRowAt(rows, deleted, idx) {
    const [row] = rows.splice(idx, 1);
    row.editing = false; row.creatingNew = false;
    deleted.push({ row, index: idx });
    return row;
  }
  function restoreDeleted(rows, deleted, k) {
    const entry = deleted.splice(k, 1)[0];
    if (!entry) return null;
    rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
    return entry.row;
  }

  // One line, same order on every row: [Skip / Undo / Acknowledge] · Edit ·
  // Delete -- Delete always last, set slightly apart as the destructive one.
  // Delete as a red trash icon (approved UI proposal, page 5). The word
  // "Delete" stays for screen readers; permission handling is unchanged.
  const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg><span class="sr-only">Delete</span>`;
  function renderRowActionButtons(idx, row) {
    const on = (yes) => yes ? "on" : "";
    let first = "";
    if (row.baseStatus === "ok" || row.baseStatus === "shortage") {
      first = row.action === "skip"
        ? `<button data-act="deduct" data-i="${idx}" class="on" title="Skipped — click to deduct it again">Undo skip</button>`
        : `<button data-act="skip" data-i="${idx}">Skip</button>`;
    } else if (row.baseStatus === "unmatched") {
      first = `<button data-act="skip" data-i="${idx}" class="${on(row.decided)}" title="Confirm you've seen this unmatched item; it won't be deducted">Acknowledge</button>`;
    }
    return `<div class="fp-row-actions fp-row-actions-line">
        ${first}
        <button data-act="edit" data-i="${idx}">Edit</button>
        <button data-act="delete" data-i="${idx}" class="fp-row-delete" aria-label="Delete"${deleteBtnAttrs() || ` title="Remove this item from the Check-out"`}>${TRASH_ICON}</button>
      </div>`;
  }

  function applyRowAction(idx, act) {
    if (state.done) return;
    if (act === "skip-all-unmatched") {
      state.rows.forEach((rr) => {
        if (rr.decided) return;
        if (rr.baseStatus === "unmatched") { rr.action = "skip"; rr.decided = true; }
      });
      render();
      return;
    }
    if (act === "restore") {
      const back = restoreDeleted(state.rows, state.removedRows || [], idx);
      if (back) {
        if (window.ORYX_AUTH) window.ORYX_AUTH.logRestore({ area: "checkout", ref: back.code || back.description,
          detail: { code: back.code || null, description: back.description || null }, documentName: state.pdfFile ? state.pdfFile.name : null });
        render();
        status(`Restored ${back.code ? back.code + " — " : ""}${back.description || "item"} to the Check-out.`);
      }
      return;
    }
    const r = state.rows[idx];
    if (!r) return;
    if (act === "delete") {
      // Removed outright, not just skipped: the row leaves the list, so it can
      // no longer be acknowledged, edited or deducted. Nothing has been
      // written yet, so this only changes what Confirm would send.
      const label = `${r.code ? r.code + " — " : ""}${r.description || "this item"} (${[fmt(r.requiredQty), r.unit].filter(Boolean).join(" ")})`;
      // Confirmation + the server's permission check (and the delete log);
      // the line is only removed once both say yes.
      if (window.ORYX_AUTH) {
        window.ORYX_AUTH.requestDelete({
          what: label, area: "checkout", ref: r.code || r.description,
          detail: { code: r.code || null, description: r.description || null, qty: r.requiredQty, unit: r.unit || null,
                    job_number: ($("#fpJobNumber") || {}).value || null },
          documentName: state.pdfFile ? state.pdfFile.name : null,
          note: "It won't be deducted from the Master Inventory. You can still bring it back with Restore, below the table, until you confirm the Check-out.",
        }).then((ok) => {
          if (!ok || state.done || state.rows[idx] !== r) return;
          state.removedRows = state.removedRows || [];
          deleteRowAt(state.rows, state.removedRows, idx);
          render();
          status(`Deleted ${label} — it will not be acknowledged or deducted. Use Restore below the table to bring it back.`);
        });
        return;
      }
      const ok = window.confirm(`Delete ${label} from this Check-out?`);
      if (!ok) return;
      state.removedRows = state.removedRows || [];
      deleteRowAt(state.rows, state.removedRows, idx);
      render();
      status(`Deleted ${label} — it will not be acknowledged or deducted. Use Restore below the table to bring it back.`);
      return;
    }
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
      const idEl = document.getElementById(`fpEditItemId${idx}`);
      recomputeAfterEdit(r, newCode, "", newQty, unitEl.value.trim() || r.unit, idEl ? idEl.value : "");
      r.editing = false;
    }
    render();
  }

  function render() {
    applyCombinedStock(state.rows);
    // Item photos (same ones as Master Inventory): loaded once, then the
    // preview redraws with them.
    if (!state.photos) {
      loadItemPhotos().then((photos) => { state.photos = photos; if (state.rows && !state.done) render(); });
    }
    const job = state.parsedJob;
    const t = tallyTotals();
    const u = unresolvedByStatus();

    const rowsHtml = state.rows.map((r, i) => {
      if (r.editing) {
        const codeLabel = r.itemId ? `${esc(r.code)} — ${esc(r.description)}` : esc(r.code);
        return `<tr class="fp-editing">
          <td></td>
          <td class="fp-code-picker">
            <input class="fp-inline-input" id="fpEditCodeSearch${i}" type="text" value="${codeLabel}"
              placeholder="Type to search Master Inventory" autocomplete="off">
            <input type="hidden" id="fpEditCodeValue${i}" value="${r.itemId ? esc(r.code) : ""}">
            <input type="hidden" id="fpEditItemId${i}" value="${r.itemId ? esc(r.itemId) : ""}">
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
      const photoCell = r.itemId
        ? itemPhotoCell(state.photos, { item_code: r.code, description: r.description })
        : `<td><span class="fp-photo-none" title="Not in Master Inventory"></span></td>`;
      return `<tr class="${rowClass}">
        ${photoCell}
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
    const removedNote = deletedItemsBox(state.removedRows, "Check-out", "not acknowledged and not deducted.",
      (row) => esc([fmt(row.requiredQty), row.unit].filter(Boolean).join(" ")));
    const shortageNote = t.shortages > 0 ? `<p class="small muted" style="color:var(--danger)">
      ${t.shortages} item${t.shortages === 1 ? "" : "s"} will go negative — allowed, and shown in red below.
      A future Check-in will correct it.</p>` : "";

    const keptEdits = keepOpenEdits($("#fpOut"), state.rows);
    const keptScroll = keepListScroll($("#fpOut"));
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
        <table class="fp-table fp-checkout-table">
          <thead><tr>
            <th class="fp-photo-col"><span class="sr-only">Photo</span></th>
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
      ${state.rows.length ? "" : `<p class="small muted">Every item has been deleted from this Check-out — there is nothing left to deduct.</p>`}
      ${state.done ? "" : `<div class="fp-actions" style="margin-top:var(--space-3)"><button class="ghost" type="button" id="fpAddMore">+ Add more items</button></div>`}
      ${removedNote}
      <p class="small muted" style="margin-top:var(--space-3)">Nothing has been deducted yet.
      The confirm button unlocks once every unmatched row has been edited or acknowledged.</p>
    `;

    // Job number and client name are required, but they don't disable the
    // button: clicking Confirm with one empty takes the person to that field
    // (see missingJobDetail), which is clearer than a button that just won't
    // press.
    const canConfirm =
      !state.done && !state.confirming &&
      t.unresolved === 0 &&
      t.totalItems > 0 &&
      !state.rows.some((r) => r.editing);
    const missing = missingJobDetail();
    $("#fpConfirmSummary").textContent =
      `${t.totalItems} items · ${money(t.totalValue)}` +
      (t.skipped ? ` · ${t.skipped} skipped` : "") +
      (missing ? ` · ${missing.label} needed` : "");
    $("#fpConfirmBar").hidden = state.done;
    $("#fpConfirm").disabled = !canConfirm;

    document.querySelectorAll("#fpOut .fp-row-actions button, #fpOut .fp-batch-actions button").forEach((b) => {
      b.addEventListener("click", () => applyRowAction(+b.dataset.i, b.dataset.act));
    });
    document.querySelectorAll("#fpOut [data-mi-photo]").forEach((b) => {
      b.onclick = () => openItemPhoto(b.dataset.miPhoto, b.dataset.miPhotoCap);
    });
    const addMore = document.getElementById("fpAddMore");
    if (addMore) addMore.onclick = async () => {
      // Opens the hand-entry table (above the list) and takes the person there.
      const panel = $("#fpManualPanel");
      if (panel.hidden) await fpManualToggle(); else fpManualUpdateHint();
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
      const search = panel.querySelector("[id^='fpManCodeSearch']");
      if (search) search.focus({ preventScroll: true });
    };
    restoreOpenEdits(keptEdits, state.rows);
    restoreListScroll($("#fpOut"), keptScroll);
    state.rows.forEach((r, i) => { if (r.editing) wireCodePicker("fpEdit", state.itemsByCode, i); });
  }

  /* --------------------------- Confirm & apply --------------- */

  // Required job details, in the order they appear on the page.
  const REQUIRED_JOB_FIELDS = [
    { id: "fpJobNumber", label: "job number" },
    { id: "fpClient", label: "client name" },
  ];

  function missingJobDetail() {
    return REQUIRED_JOB_FIELDS.find((f) => !$("#" + f.id).value.trim()) || null;
  }

  function setJobFieldInvalid(id, invalid) {
    const input = $("#" + id);
    const field = input.closest(".fp-jobrow-field");
    field.classList.toggle("fp-invalid", invalid);
    if (!invalid) field.classList.remove("fp-attention");
    input.setAttribute("aria-invalid", invalid ? "true" : "false");
    $("#" + id + "Error").hidden = !invalid;
  }

  // Marks every empty required field, then scrolls to the first one,
  // highlights it and puts the cursor in it. Returns true when something
  // was missing (so Confirm must stop).
  function promptForMissingJobDetails() {
    const empty = REQUIRED_JOB_FIELDS.filter((f) => !$("#" + f.id).value.trim());
    REQUIRED_JOB_FIELDS.forEach((f) => setJobFieldInvalid(f.id, empty.includes(f)));
    if (!empty.length) return false;
    const first = $("#" + empty[0].id);
    const field = first.closest(".fp-jobrow-field");
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    field.classList.remove("fp-attention");
    void field.offsetWidth; // restart the highlight animation on every click
    field.classList.add("fp-attention");
    field.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    first.focus({ preventScroll: true });
    status(`Enter the ${empty.map((f) => f.label).join(" and ")} before confirming.`, "err");
    return true;
  }

  async function confirmAllocation() {
    const jobRef = $("#fpJobNumber").value.trim();
    const client = $("#fpClient").value.trim();
    if (!jobRef || !client) throw new Error("Enter the job number and client name before confirming.");
    const lines = state.rows
      .filter((r) => r.action === "deduct" && r.itemId)
      .map((r) => ({ item_id: r.itemId, quantity: r.requiredQty, unit: r.unit }));

    const pdfFile = state.pdfFile, pdfHash = state.pdfHash;
    const res = await fetch(CHECKOUT_FN_URL, await confirmRequest({
      job_number: jobRef,
      client,
      pdf_hash: pdfHash,
      source_document_name: pdfFile ? pdfFile.name : null,
      lines,
    }, pdfHash ? pdfFile : null));
    const data = await readFnJson(res);

    if (!data.ok) {
      if (data.error === "duplicate_document") {
        throw new Error("This PDF has already been checked out — re-processing it would double-count the deduction.");
      }
      if (data.error === "insufficient_stock") {
        throw new Error("Stock changed since this was analysed — re-run Analyse and preview to refresh availability.");
      }
      throw new Error(data.detail || data.error || "The Check-out was not applied.");
    }

    state.done = true;
    $("#fpConfirmBar").hidden = true;
    document.querySelectorAll("#fpOut button").forEach((b) => { b.disabled = true; });
    $("#fpDone").innerHTML = `
      <div class="fp-done">
        <h3>Check-out confirmed — ${data.lines.length} item${data.lines.length === 1 ? "" : "s"} deducted</h3>
        <p class="small">Job <code>${esc(jobRef)}</code> for <b>${esc(client)}</b>. The Master Inventory
        and the Inventory tab now reflect this. A permanent Check-out transaction has been recorded for each item.</p>
        ${keptDocNote(data, pdfHash ? pdfFile : null, pdfHash, "check_out")}
        <div class="fp-done-actions">
          <button class="ghost" id="fpNew">Start another Check-out</button>
        </div>
      </div>`;
    wireDocRetry($("#fpDone"), "check_out", pdfFile, pdfHash);
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
      state.done = false;
      state.rows = buildRows(entries, state.itemsByCode);
      state.removedRows = [];
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

  /* --------------------------- Manual entry (unreadable PDF) -- */

  // Fallback for a document the PDF/OCR pipeline genuinely can't read: the
  // same Master Inventory search used everywhere else (wireCodePicker), one
  // row per item, no PDF involved at all. A row built this way is already a
  // matched item (picked directly from Master Inventory), so it lands in
  // state.rows in exactly the shape buildRows() gives a normal "ok" match --
  // render(), tallyTotals() and confirmAllocation() all work unchanged.
  let fpManualRowCount = 0;
  let fpManualItemsByCode = null;

  function fpManualRowHtml(i) {
    return `<tr data-man-row="${i}">
      <td class="fp-code-picker">
        <input class="fp-inline-input" id="fpManCodeSearch${i}" type="text" placeholder="Search code or description" autocomplete="off">
        <input type="hidden" id="fpManCodeValue${i}" value="">
        <input type="hidden" id="fpManItemId${i}" value="">
        <input type="hidden" id="fpManDesc${i}" value="">
        <div class="fp-dropdown-results" id="fpManCodeResults${i}" hidden></div>
      </td>
      <td class="num"><input class="fp-inline-input fp-inline-input-num" id="fpManQty${i}" type="number" step="any" min="0" placeholder="0"></td>
      <td><button class="ghost" type="button" data-man-remove="${i}">Remove</button></td>
    </tr>`;
  }

  // Loaded once and cached as a PROMISE (not just the resolved value) --
  // if "Add another item" is clicked while the first load is still in
  // flight, this still awaits that same in-flight request instead of
  // wiring the search box against a not-yet-loaded (null) Master Inventory,
  // which would otherwise leave that row's search permanently dead (typing
  // shows nothing, forever, until Reset) with no visible error at all.
  let fpManualItemsPromise = null;
  function fpManualLoadItems() {
    if (!fpManualItemsPromise) {
      fpManualItemsPromise = loadInventoryItems().catch((err) => { fpManualItemsPromise = null; throw err; });
    }
    return fpManualItemsPromise;
  }

  async function fpManualAddRow() {
    const i = fpManualRowCount++;
    $("#fpManualBody").insertAdjacentHTML("beforeend", fpManualRowHtml(i));
    $(`[data-man-remove="${i}"]`).addEventListener("click", () => {
      const row = document.querySelector(`[data-man-row="${i}"]`);
      if (row) row.remove();
    });
    try {
      fpManualItemsByCode = await fpManualLoadItems();
      wireCodePicker("fpMan", fpManualItemsByCode, i);
    } catch (err) {
      $("#fpManualStatus").textContent = "Could not load the Master Inventory: " + err.message;
    }
  }

  // The hint above the hand-entry table says whether the items start a new
  // Check-out or join the list that's already being reviewed.
  function fpManualUpdateHint() {
    const existing = state.rows && !state.done ? state.rows.length : 0;
    $("#fpManualHint").innerHTML = existing
      ? `Pick each item and type how many to take out. They're <b>added</b> to the ${existing} item${existing === 1 ? "" : "s"} already in this Check-out.`
      : "Pick each item and type how many to take out, then press <b>Add to Check-out</b>.";
  }

  async function fpManualToggle() {
    const panel = $("#fpManualPanel");
    panel.hidden = !panel.hidden;
    fpManualUpdateHint();
    if (!panel.hidden && !fpManualRowCount) {
      $("#fpManualStatus").textContent = "Loading Master Inventory…";
      await fpManualAddRow();
      $("#fpManualStatus").textContent = "";
    }
  }

  function fpManualUse() {
    const rowEls = [...document.querySelectorAll("#fpManualBody [data-man-row]")];
    if (!rowEls.length) { $("#fpManualStatus").textContent = "Add at least one item first."; return; }
    const rows = [];
    for (const rowEl of rowEls) {
      const i = rowEl.dataset.manRow;
      const code = $(`#fpManCodeValue${i}`).value;
      const qty = parseFloat($(`#fpManQty${i}`).value);
      if (!code) { $("#fpManualStatus").textContent = "Every row needs a Master Inventory item selected."; return; }
      if (!(qty > 0)) { $("#fpManualStatus").textContent = "Every row needs a quantity greater than 0."; return; }
      const item = pickedInventoryRow(fpManualItemsByCode, code, $(`#fpManItemId${i}`).value, { kind: "fitting" });
      if (!item) { $("#fpManualStatus").textContent = "One of the selected items could not be found — please re-pick it."; return; }
      const remaining = item.current_qty - qty;
      rows.push({
        kind: "fitting", code: item.item_code, barLenMm: null,
        description: item.description,
        pdfDetail: ["Added by hand", item.bar_length_mm ? `${Math.round(item.bar_length_mm)} mm` : ""].filter(Boolean).join(" · "),
        requiredQty: qty, unit: item.unit_of_measure || "",
        available: item.current_qty, remaining,
        costPerUnit: item.unit_cost || 0,
        estValue: qty * (item.unit_cost || 0),
        status: remaining < 0 ? "shortage" : "ok", baseStatus: remaining < 0 ? "shortage" : "ok",
        action: "deduct", decided: true,
        itemId: item.id, hasVariants: false, editing: false,
      });
    }
    $("#fpManualStatus").textContent = "";
    // Clear the hand-entry table for the next lot.
    $("#fpManualBody").innerHTML = "";
    fpManualRowCount = 0;
    $("#fpManualPanel").hidden = true;
    const added = `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    if (state.rows && !state.done) {
      // A Check-out is already being reviewed (from a PDF or earlier hand
      // entry): add to it. The PDF, its fingerprint and job details stay.
      state.rows.push(...rows);
      render();
      status(`Added ${added} by hand. The Check-out now has ${state.rows.length} lines.`);
    } else {
      state.pdfFile = null;
      state.pdfHash = null;
      state.parsedJob = { ref: "", user: "", description: "", printedAt: "" };
      state.itemsByCode = fpManualItemsByCode;
      state.done = false;
      state.rows = rows;
      state.removedRows = [];
      render();
      status(`${added} added by hand, ready for review.`);
    }
    $("#fpOut").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* --------------------------- Reset / status ---------------- */

  function resetAll() {
    state.pdfFile = null;
    state.pdfHash = state.parsedJob = state.rows = state.itemsByCode = null;
    state.removedRows = [];
    state.done = false;
    fpManualItemsPromise = null; // next manual entry reloads current stock
    $("#fpPdf").value = "";
    $("#fpPdfName").textContent = "Click or drop the PDF file here";
    $("#fpDrop").classList.remove("ready");
    $("#fpJobNumber").value = ""; $("#fpClient").value = "";
    REQUIRED_JOB_FIELDS.forEach((f) => setJobFieldInvalid(f.id, false));
    $("#fpOut").innerHTML = "";
    $("#fpDone").innerHTML = "";
    $("#fpConfirmBar").hidden = true;
    $("#fpExtract").disabled = true;
    $("#fpManualPanel").hidden = true;
    $("#fpManualBody").innerHTML = "";
    $("#fpManualStatus").textContent = "";
    fpManualRowCount = 0;
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

  // Used by the other stock-screen files.
  Object.assign(FP, { TRASH_ICON, analyse, applyCombinedStock, ciStatusChip, confirmAllocation, deleteRowAt,
    deletedItemsBox, fpManualAddRow, fpManualToggle, fpManualUse, promptForMissingJobDetails,
    render, resetAll, restoreDeleted, setJobFieldInvalid, status, wireDrop });
})();
