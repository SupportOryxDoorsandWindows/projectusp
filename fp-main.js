/* Starts everything: wires the Check-out, Check-in and Master Inventory screens (init) and the header stepper read-out.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, esc, state, analyse, confirmAllocation, fpManualAddRow, fpManualToggle, fpManualUse,
    promptForMissingJobDetails, render, resetAll, setJobFieldInvalid, status, wireDrop, ciState,
    ciAnalyse, ciConfirm, ciManualAddRow, ciManualToggle, ciManualUse, ciRender, ciResetAll,
    ciStatus, wireCiDrop, exportCheckoutReport, exportInventoryList, fillTxDocs,
    loadMasterInventoryView } = FP;

  // Header stepper (Upload → Review → Confirm) and, on Check-in, the
  // Supplier / Invoice / Currency / Exchange rate strip (proposal pages 5-6).
  // Purely a read-out of what the page already shows; nothing here acts.
  function updateFlowUi() {
    const step = (pre) => {
      const done = !!($(`#${pre}Done`) && $(`#${pre}Done`).textContent.trim());
      const review = !done && (!$(`#${pre}ConfirmBar`).hidden || !!$(`#${pre}Out`).querySelector("table"));
      const now = done ? 3 : review ? 2 : 1;
      for (const st of document.querySelectorAll(`#${pre}Stepper .st`)) {
        const n = Number(st.dataset.step);
        st.classList.toggle("done", n < now || (done && n === 3));
        st.classList.toggle("now", n === now && !(done && n === 3));
        st.querySelector(".st-dot").textContent = n < now || (done && n === 3) ? "✓" : String(n);
      }
    };
    step("fp"); step("ci");
    const box = $("#ciSummary");
    if (!box) return;
    const shown = !$("#ciConfirmBar").hidden || !!$("#ciOut").querySelector("table");
    box.hidden = !shown || !ciState.rows;
    if (box.hidden) return;
    const cur = ciState.currency || "—";
    const basis = ciState.currencyBasis ? String(ciState.currencyBasis) : "";
    const d = ($("#ciDocDate").value || "").trim();
    const day = d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No date found";
    const rate = cur === "AED" ? "No conversion" : ciState.exchangeRate ? `1 ${esc(cur)} = ${Number(ciState.exchangeRate).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} AED` : "Rate needed";
    box.innerHTML = `
      <div><span>Supplier</span><b>${esc(($("#ciSupplier").value || "").trim() || "Not found — type it below")}</b><small>${esc(ciState.header && ciState.header.docType ? ciState.header.docType : "")}</small></div>
      <div><span>Invoice</span><b class="mono">${esc(($("#ciInvoiceNumber").value || "").trim() || "—")}</b><small>${esc(day)}</small></div>
      <div><span>Currency</span><b>${esc(cur)}</b><small>${esc(({ stated: "Written on the invoice", "dollar-australian-details": "\"$\" with Australian details", "dollar-us-details": "\"$\" with US details", "dollar-default-aud": "\"$\" read as AUD", "dollar-chosen": "Chosen by you", none: "No foreign currency found" })[basis] || "Change it below if wrong")}</small></div>
      <div><span>Exchange rate</span><b class="mono">${rate}</b><small>${esc(ciState.rateDate ? "Rate for " + ciState.rateDate : ciState.rateSource && ciState.rateSource !== "n/a" ? ciState.rateSource : "")}</small></div>`;
  }

  function init() {
    if (!$("#fpExtract")) { setTimeout(init, 50); return; }
    // A PDF attached elsewhere (Activity, item panel) shows here too.
    document.addEventListener("oryx-doc-kept", () => fillTxDocs());
    const flowObserver = new MutationObserver(() => updateFlowUi());
    for (const id of ["#fpOut", "#fpDone", "#fpConfirmBar", "#ciOut", "#ciDone", "#ciConfirmBar"]) {
      if ($(id)) flowObserver.observe($(id), { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    }
    for (const id of ["#ciSupplier", "#ciInvoiceNumber", "#ciDocDate"]) if ($(id)) $(id).addEventListener("input", updateFlowUi);
    updateFlowUi();
    wireDrop($("#fpDrop"), $("#fpPdf"), "pdf");
    $("#fpExtract").addEventListener("click", analyse);
    $("#fpReset").addEventListener("click", resetAll);
    $("#fpManualToggle").addEventListener("click", fpManualToggle);
    $("#fpManualAddRow").addEventListener("click", fpManualAddRow);
    $("#fpManualUse").addEventListener("click", fpManualUse);
    $("#fpConfirm").addEventListener("click", async () => {
      if (state.confirming || state.done) return;
      if (promptForMissingJobDetails()) return;
      status("");
      state.confirming = true;
      $("#fpConfirm").disabled = true;
      try { await confirmAllocation(); }
      catch (err) { console.error(err); status("Could not confirm: " + err.message, "err"); }
      finally { state.confirming = false; if (state.rows && !state.done) render(); }
    });
    ["fpJobNumber", "fpClient"].forEach((id) => {
      $("#" + id).addEventListener("input", () => {
        // The highlight clears as soon as something is typed in.
        if ($("#" + id).value.trim()) setJobFieldInvalid(id, false);
        if (state.rows && !state.done) render();
      });
    });

    // An Admin turned Allow Delete on/off: redraw the Delete buttons now.
    document.addEventListener("oryx-permissions", () => {
      if (state.rows && !state.done) render();
      if (ciState.rows && !ciState.done) ciRender();
    });

    const miNavBtn = document.querySelector('nav button[data-v="master-inventory"]');
    if (miNavBtn) miNavBtn.addEventListener("click", loadMasterInventoryView);
    const exportBtn = $("#miExportBtn");
    if (exportBtn) exportBtn.addEventListener("click", () => exportCheckoutReport("detailed"));
    const reportBtn = $("#miReportBtn");
    if (reportBtn) reportBtn.addEventListener("click", () => exportCheckoutReport("report"));
    const extractBtn = $("#miExtractBtn");
    if (extractBtn) extractBtn.addEventListener("click", exportInventoryList);

    wireCiDrop($("#ciDrop"), $("#ciPdf"));
    $("#ciExtract").addEventListener("click", ciAnalyse);
    $("#ciReset").addEventListener("click", ciResetAll);
    $("#ciManualToggle").addEventListener("click", ciManualToggle);
    $("#ciManualAddRow").addEventListener("click", ciManualAddRow);
    $("#ciManualUse").addEventListener("click", ciManualUse);
    $("#ciConfirm").addEventListener("click", async () => {
      if (ciState.confirming || ciState.done) return;
      ciState.confirming = true;
      $("#ciConfirm").disabled = true;
      try { await ciConfirm(); }
      catch (err) { console.error(err); ciStatus("Could not confirm: " + err.message, "err"); }
      finally { ciState.confirming = false; if (ciState.rows && !ciState.done) ciRender(); }
    });
    ["ciSupplier", "ciInvoiceNumber", "ciPoNumber", "ciDocDate"].forEach((id) => {
      $("#" + id).addEventListener("input", () => { if (ciState.rows && !ciState.done) ciRender(); });
    });
  }

  init();
})();
