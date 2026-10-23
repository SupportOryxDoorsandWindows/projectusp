/* Reports: Check-out report / detailed transactions export (.xlsx) and the shared Excel styles.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, loadXlsxLib, sb } = FP;

  /* --------------------------- Check-out report export --------- */

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function fetchAllTransactions() {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from("inventory_transactions")
        .select("*")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  // Groups line-item transactions back into one Check-out/Check-in event
  // per (reference, party, timestamp) -- same key as the Transaction History
  // view, since Postgres's now() returns one timestamp per
  // checkout_transaction()/checkin_transaction() call.
  function groupTransactions(txs) {
    const map = new Map();
    for (const tx of txs) {
      const isCheckin = tx.type === "check_in";
      const reference = isCheckin ? (tx.invoice_number || tx.po_number || "") : tx.job_number;
      const party = isCheckin ? tx.supplier : tx.client;
      const key = `${tx.type}|${reference}|${party}|${tx.created_at}`;
      let g = map.get(key);
      if (!g) {
        g = { created_at: tx.created_at, type: tx.type, reference, party, lines: [], totalValue: 0 };
        map.set(key, g);
      }
      g.lines.push(tx);
      g.totalValue += tx.value || 0;
    }
    return [...map.values()];
  }

  const REPORT_COLS = 6; // Code, Description, Qty, Unit, Unit Cost, Value

  // Oryx brand palette (per the account brief): blue is the primary colour,
  // used sparingly -- one banner, not a colour on every row.
  const ORYX_BLUE = "022A3A";
  const ORYX_SILVER = "A9A9A9";
  const STYLE_TITLE = {
    fill: { fgColor: { rgb: ORYX_BLUE } },
    font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } },
    alignment: { horizontal: "center", vertical: "center" },
  };
  const STYLE_LABEL = { font: { bold: true } };
  const STYLE_HEADER = {
    fill: { fgColor: { rgb: ORYX_SILVER } },
    font: { bold: true, color: { rgb: "FFFFFF" } },
  };

  function buildReportSheet(groups) {
    const aoa = [];
    const merges = [];
    const styledCells = []; // [row, col, style]
    const currencyCells = []; // [row, col] pairs to format as AED after the fact

    aoa.push(["Oryx Doors & Windows — Inventory Transaction Report"]);
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: REPORT_COLS - 1 } });
    styledCells.push([0, 0, STYLE_TITLE]);
    aoa.push([]);

    // Newest transaction first, matching the Transaction History view.
    for (const g of [...groups].reverse()) {
      const dateStr = String(g.created_at).slice(0, 16).replace("T", " ");
      const isCheckin = g.type === "check_in";

      const partyRow = aoa.length;
      aoa.push([`${isCheckin ? "Supplier" : "Client"}: ${g.party || "—"}`]);
      styledCells.push([partyRow, 0, STYLE_LABEL]);

      const refRow = aoa.length;
      aoa.push([`${isCheckin ? "Check-in" : "Check-out"} · Order Number ${g.reference || "—"}`]);
      styledCells.push([refRow, 0, STYLE_LABEL]);

      const summaryRow = aoa.length;
      aoa.push([
        `Generated ${todayISO()}`, "", "", "",
        `${g.lines.length} item${g.lines.length === 1 ? "" : "s"}`,
        `Total AED ${g.totalValue.toFixed(2)}`,
      ]);
      styledCells.push([summaryRow, 4, { font: { italic: true } }], [summaryRow, 5, { font: { bold: true } }]);

      const headerRow = aoa.length;
      aoa.push(["Code", "Description", "Qty", "Unit", "Unit Cost", "Value"]);
      for (let c = 0; c < REPORT_COLS; c++) styledCells.push([headerRow, c, STYLE_HEADER]);

      for (const tx of g.lines) {
        const r = aoa.length;
        aoa.push([tx.item_code, tx.description, tx.quantity, tx.unit, tx.unit_cost_used, tx.value]);
        currencyCells.push([r, 4], [r, 5]);
      }
      aoa.push([]);
    }

    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = merges;
    ws["!cols"] = [{ wch: 12 }, { wch: 42 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 18 }];
    ws["!rows"] = [{ hpt: 22 }];
    for (const [r, c] of currencyCells) {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) ws[addr].z = '"AED" #,##0.00';
    }
    for (const [r, c, style] of styledCells) {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      ws[addr].s = style;
    }
    return ws;
  }

  // "Report" export: one row per transaction (the same groups as the
  // Transaction History table) with its total value -- no item lines. For
  // management; the "Detailed transactions" export above keeps the items.
  const SUMMARY_COLS = ["Date", "Type", "Order Number", "Client / Supplier", "Total Value"];

  function buildSummarySheet(groups) {
    const n = SUMMARY_COLS.length;
    const aoa = [
      ["Oryx Doors & Windows — Transaction Report"],
      [`Generated ${todayISO()}`],
      [],
      SUMMARY_COLS,
    ];
    const firstDataRow = aoa.length;
    const totals = { check_out: [0, 0], check_in: [0, 0] };
    // Newest transaction first, matching the Transaction History view.
    for (const g of [...groups].reverse()) {
      const isCheckin = g.type === "check_in";
      aoa.push([
        String(g.created_at).slice(0, 16).replace("T", " "),
        isCheckin ? "Check-in" : "Check-out",
        g.reference || "—",
        g.party || "—",
        Math.round(g.totalValue * 100) / 100,
      ]);
      const t = totals[isCheckin ? "check_in" : "check_out"];
      t[0] += 1;
      t[1] += g.totalValue;
    }
    const lastDataRow = aoa.length - 1;
    aoa.push([]);
    const totalRows = [];
    for (const [type, label] of [["check_out", "Check-out"], ["check_in", "Check-in"]]) {
      const [count, value] = totals[type];
      totalRows.push(aoa.length);
      aoa.push(["", `${label} total`, `${count} transaction${count === 1 ? "" : "s"}`, "", Math.round(value * 100) / 100]);
    }

    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: n - 1 } }];
    ws["!cols"] = [{ wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 40 }, { wch: 18 }];
    ws["!rows"] = [{ hpt: 22 }];
    ws["!autofilter"] = { ref: window.XLSX.utils.encode_range({ s: { r: firstDataRow - 1, c: 0 }, e: { r: lastDataRow, c: n - 1 } }) };
    const cell = (r, c) => {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      return ws[addr];
    };
    cell(0, 0).s = STYLE_TITLE;
    cell(1, 0).s = { font: { italic: true } };
    for (let c = 0; c < n; c++) cell(firstDataRow - 1, c).s = STYLE_HEADER;
    for (let r = firstDataRow; r <= lastDataRow; r++) cell(r, 4).z = '"AED" #,##0.00';
    for (const r of totalRows) {
      cell(r, 1).s = STYLE_LABEL;
      cell(r, 4).z = '"AED" #,##0.00';
      cell(r, 4).s = STYLE_LABEL;
    }
    return ws;
  }

  // kind "detailed": every transaction with its item lines (the original
  // export). kind "report": one summary row per transaction, no items.
  async function exportCheckoutReport(kind) {
    const isReport = kind === "report";
    const btns = [$("#miExportBtn"), $("#miReportBtn")].filter(Boolean);
    const setStatus = (text, kind) => {
      const el = $("#miExportStatus");
      el.textContent = text || "";
      el.style.color = kind === "err" ? "var(--danger)" : "";
    };
    btns.forEach((b) => { b.disabled = true; });
    setStatus("Fetching every Check-out and Check-in transaction…");
    try {
      const [txs] = await Promise.all([fetchAllTransactions(), loadXlsxLib()]);
      if (!txs.length) {
        setStatus("No transactions recorded yet — nothing to export.");
        return;
      }
      const groups = groupTransactions(txs);
      const ws = isReport ? buildSummarySheet(groups) : buildReportSheet(groups);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, isReport ? "Report" : "Transactions");
      const outName = isReport
        ? `Oryx Transaction Summary - ${todayISO()}.xlsx`
        : `Oryx Transaction Report - ${todayISO()}.xlsx`;
      window.XLSX.writeFile(wb, outName);
      setStatus(isReport
        ? `Exported a report of ${groups.length} transaction${groups.length === 1 ? "" : "s"} as ${outName}.`
        : `Exported ${groups.length} transaction${groups.length === 1 ? "" : "s"} (${txs.length} items) as ${outName}.`);
    } catch (err) {
      console.error(err);
      setStatus("Could not export: " + err.message, "err");
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { STYLE_HEADER, STYLE_LABEL, STYLE_TITLE, exportCheckoutReport, todayISO });
})();
