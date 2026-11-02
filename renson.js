/* Renson inventory -- ADMIN-ONLY PILOT (2026-11-02, user's request
 * "Admin-Only Testing Before System-Wide Release").
 *
 * Completely apart from the Freedom inventory: its own tables
 * (renson_items / renson_imports / renson_transactions, SQL
 * supabase/sql/renson_pilot.sql). Nothing here reads or writes a Freedom
 * table, and no Freedom page is changed.
 *
 * Who sees it: boot.js only loads this file for an Admin, and the page only
 * appears when the database says renson_access() (= Admin AND the feature
 * flag 'renson_pilot' is on). The database refuses everyone else on its own
 * (read policies + the functions), so hiding is not the protection.
 *
 * What it does (pilot): in Master Inventory, an "Inventory: Freedom / Renson
 * (pilot)" dropdown; Renson stock list with quantities and value; opening import from
 * the Renson stock Excel ("RENSON STOCK OCT 27.xlsx": sheet STOCK, header
 * row with "Part Code", stock in the dated column, "OPENING COST PER
 * PROFILE", "Total opening cost", sheet total beside "INVENTORY VALUE"),
 * reviewed before it is confirmed. Check-in / Check-out for Renson are NOT
 * built yet (user: wait for Renson sample files).
 *
 * Pure parts: window.ORYX_RENSON_CORE (tests/renson.test.js).
 */
(function () {
  "use strict";
  const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const EXCEL_ERR = /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|NULL!)$/i;

  // "2405 (P6028425)-Spline Ø 6 mm"       -> 2405, alt P6028425, "Spline Ø 6 mm"
  // "1465-G6020837-End piece ... white"   -> 1465, alt G6020837, "End piece ... white"
  // "D6110097-Sergé SC0140 ..."           -> D6110097
  // "910005R-Pet Mesh 3000mm Roll ..."    -> 910005R
  function splitPartCode(text) {
    const t = norm(text);
    const m = /^([A-Za-z]{0,2}\d{2,}[A-Za-z]?)\s*(?:\(\s*([A-Za-z0-9]+)\s*\))?\s*-\s*(.*)$/.exec(t);
    if (!m) return null;
    let alt = m[2] || "";
    let desc = norm(m[3]);
    const second = /^([A-Za-z]\d{5,})\s*-\s*(.+)$/.exec(desc);
    if (!alt && second) { alt = second[1]; desc = norm(second[2]); }
    return { code: m[1].toUpperCase(), alt: alt.toUpperCase(), description: desc || m[1] };
  }

  function excelDate(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (isNum(v) && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
    return "";
  }

  // rows = the sheet as an array of rows (XLSX sheet_to_json header:1, raw).
  // Returns {ok, error?, header, stockDate, sheetTotal, items[], issues[],
  // totals}. issues: {kind: "error"|"warning"|"note", row, code, text};
  // any error blocks the import.
  function parseRensonSheet(rows) {
    const out = { ok: false, items: [], issues: [], stockDate: "", sheetTotal: null, totals: { items: 0, withStock: 0, value: 0, noCount: 0 } };
    const low = (v) => norm(v).toLowerCase();
    const h = rows.findIndex((r) => Array.isArray(r) && r.some((c) => low(c) === "part code"));
    if (h < 0) { out.error = 'No header row with "Part Code" was found. Is this the Renson STOCK sheet?'; return out; }
    const hdr = rows[h];
    const col = (name) => hdr.findIndex((c) => low(c) === name);
    const C = {
      product: col("product"), colour: col("blk/wht"), part: col("part code"),
      composite: hdr.findIndex((c) => /^composite/.test(low(c))), unit: col("length"),
      cost: col("opening cost per profile"), value: col("total opening cost"),
    };
    if (C.cost < 0 || C.value < 0) { out.error = 'The columns "OPENING COST PER PROFILE" and "Total opening cost" were not found.'; return out; }
    C.qty = C.cost - 1;                       // the stock column (headed with the count date)
    C.type = C.product >= 0 ? C.product + 1 : -1;
    out.stockDate = excelDate(hdr[C.qty]);
    if (!out.stockDate && !/stock|qty|count/i.test(norm(hdr[C.qty]))) {
      out.error = 'The stock column (just before "OPENING COST PER PROFILE") has no date or "stock" heading.';
      return out;
    }
    out.header = { row: h + 1, columns: C };
    for (let i = 0; i < h; i++) {
      const r = rows[i] || [];
      const k = r.findIndex((c) => low(c) === "inventory value");
      if (k >= 0) { const v = r.slice(k + 1).find(isNum); if (v != null) out.sheetTotal = v; }
    }

    const seen = new Map();
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const text = norm(r[C.part]);
      if (!text || EXCEL_ERR.test(text)) continue;
      const rowNo = i + 1;
      const p = splitPartCode(text);
      if (!p) { out.issues.push({ kind: "error", row: rowNo, code: "", text: `No item code at the start of "${text}".` }); continue; }
      const issue = (kind, t) => out.issues.push({ kind, row: rowNo, code: p.code, text: t });
      const qv = r[C.qty], cv = r[C.cost], vv = r[C.value];
      let qty = 0;
      if (isNum(qv)) qty = qv;
      else if (qv == null || norm(qv) === "") { qty = 0; out.totals.noCount++; }
      else { issue("error", `Stock "${norm(qv)}" is not a number.`); continue; }
      if (qty < 0) { issue("error", `Stock is negative (${qty}).`); continue; }
      let cost = null;
      if (isNum(cv)) cost = cv;
      else if (cv != null && norm(cv) !== "") { issue("error", `Unit cost "${norm(cv)}" is not a number.`); continue; }
      if (cost != null && cost < 0) { issue("error", `Unit cost is negative (${cost}).`); continue; }
      if (seen.has(p.code)) { issue("error", `Item code ${p.code} is also on row ${seen.get(p.code)}.`); continue; }
      seen.set(p.code, rowNo);
      const value = round2(qty * (cost || 0));
      if (qty > 0 && cost == null) issue("warning", "Has stock but no unit cost: its value counts as 0.");
      if (qty === 0 && cost != null && cost > 0) issue("note", "Has a unit cost but no stock.");
      if (isNum(vv) && Math.abs(vv - value) > 0.01) issue("warning", `The file's total (${vv}) is not stock × unit cost (${value}).`);
      const product = norm(r[C.product]), type = C.type >= 0 ? norm(r[C.type]) : "";
      out.items.push({
        item_code: p.code, alt_codes: p.alt, description: p.description, source_text: text,
        product_size: EXCEL_ERR.test(product) ? "" : product, part_type: EXCEL_ERR.test(type) ? "" : type,
        colour: EXCEL_ERR.test(norm(r[C.colour])) ? "" : norm(r[C.colour]),
        qty_per_set: isNum(r[C.composite]) ? r[C.composite] : null,
        unit: EXCEL_ERR.test(norm(r[C.unit])) ? "" : norm(r[C.unit]),
        qty, unit_cost: cost, value, source_row: rowNo,
      });
      out.totals.value = round2(out.totals.value + value);
      if (qty > 0) out.totals.withStock++;
    }
    out.totals.items = out.items.length;
    if (!out.items.length) out.error = "No Renson items were found under the header row.";
    out.totalMatches = out.sheetTotal == null ? null : Math.abs(out.sheetTotal - out.totals.value) <= 0.01;
    out.ok = !out.error && !out.issues.some((x) => x.kind === "error");
    return out;
  }

  window.ORYX_RENSON_CORE = { splitPartCode, parseRensonSheet, excelDate };
})();

// ======================================================================
// The page (Admins only, while the pilot flag is on). Tests load the core
// above without a document.
// ======================================================================
(function () {
  "use strict";
  if (typeof document === "undefined" || !window.ORYX_AUTH) return;
  const AUTH = window.ORYX_AUTH;
  if (!AUTH.isAdmin()) return;                 // boot.js already skips non-Admins
  const R = window.ORYX_RENSON_CORE;
  const sb = AUTH.sb;
  const $ = (s, root) => (root || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
  const MAX_FILE = 15 * 1024 * 1024;
  const aed = (x) => "AED " + Number(x || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (x) => Number(x || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

  const ui = { tab: "inventory", items: [], lastImport: null, loading: false, loadError: "", q: "", file: null, hash: "", parsed: null, msg: null, busy: false };

  // Ask the database first: Admin AND pilot flag on. Anything else = nothing appears.
  sb.rpc("renson_access").then(({ data, error }) => {
    if (error || data !== true) return;
    mount();
  });

  function mount() {
    const style = document.createElement("style");
    style.textContent = `
.rn-pick{display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; color:var(--brand)}
.rn-pick select{border:1px solid #C5D0D4; border-radius:10px; padding:8px 10px; font:inherit; font-weight:600; background:var(--white); color:var(--brand)}
#v-master-inventory.rn-on .page-body > :not(#rnBody), #v-master-inventory.rn-on #miExtractBtn{display:none !important}
#v-master-inventory:not(.rn-on) #rnBody{display:none}
.rn-pill{display:inline-block; margin-left:8px; padding:2px 10px; border-radius:999px; background:#FEF3C7; color:#92400E; font-size:12px; font-weight:600; vertical-align:middle}
.rn-tabs{display:flex; gap:8px; margin:0 0 18px; flex-wrap:wrap}
.rn-tabs button{border:1px solid #C5D0D4; background:var(--white); color:var(--brand); border-radius:10px; padding:8px 14px; font:inherit; cursor:pointer}
.rn-tabs button.on{background:var(--brand); color:#fff; border-color:var(--brand)}
.rn-kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr)); gap:12px; margin-bottom:16px}
.rn-kpis .kpi{background:var(--white); border:1px solid #DCE3E6}
.rn-tools{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px}
.rn-tools input[type=search]{flex:1 1 240px; border:1px solid #C5D0D4; border-radius:10px; padding:9px 12px; font:inherit}
.rn-wrap{overflow:auto; border:1px solid #DCE3E6; border-radius:12px; background:var(--white)}
.rn-table{width:100%; border-collapse:collapse; font-size:14px}
.rn-table th,.rn-table td{padding:9px 12px; border-bottom:1px solid #EEF2F4; text-align:left; vertical-align:top}
.rn-table th{font-size:12.5px; color:var(--text-muted); font-weight:600; background:#F7F9FA; position:sticky; top:0}
.rn-table td.r,.rn-table th.r{text-align:right; white-space:nowrap}
.rn-table tfoot td{font-weight:700; background:#F7F9FA}
.rn-table .rn-alt{display:block; font-size:12px; color:var(--text-muted)}
.rn-table tr.rn-zero td{color:var(--text-muted)}
.rn-msg{border-radius:12px; padding:12px 14px; margin:0 0 14px}
.rn-msg.ok{background:#DCFCE7; color:#166534}.rn-msg.bad{background:#FEE2E2; color:#991B1B}.rn-msg.info{background:#E0F2FE; color:#075985}
.rn-issues{list-style:none; padding:0; margin:0 0 14px; display:grid; gap:6px}
.rn-issues li{border-radius:10px; padding:8px 12px; font-size:14px}
.rn-issues li.error{background:#FEE2E2; color:#991B1B}.rn-issues li.warning{background:#FEF3C7; color:#92400E}.rn-issues li.note{background:#F0F3F5; color:#334155}
.rn-file{display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:14px}
.rn-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:14px}
.rn-danger{background:none; border:none; color:var(--danger); text-decoration:underline; cursor:pointer; font:inherit; padding:0}
`;
    document.head.appendChild(style);

    // Master Inventory gets an "Inventory: Freedom / Renson (pilot)" dropdown
    // (user, 2026-11-02: "add it to the master inventory"). Renson is drawn in
    // its own box inside the page; the Freedom list underneath is only hidden
    // while Renson is chosen, never changed.
    const view = $("#v-master-inventory");
    const head = view && $(".page-head", view), pageBody = view && $(".page-body", view);
    if (!head || !pageBody) return;
    const pick = document.createElement("label");
    pick.className = "rn-pick";
    pick.innerHTML = `Inventory <select id="rnInventory" aria-label="Inventory"><option value="freedom">Freedom</option><option value="renson">Renson (pilot)</option></select>`;
    const actions = $(".page-actions", head);
    if (actions) actions.insertBefore(pick, actions.firstChild); else head.appendChild(pick);
    const box = document.createElement("div");
    box.id = "rnBody";
    pageBody.insertBefore(box, pageBody.firstChild);
    const sub = $(".page-head p", view);
    const freedomSub = sub ? sub.textContent : "";

    const select = $("#rnInventory");
    const show = (which) => {
      const ren = which === "renson";
      select.value = ren ? "renson" : "freedom";
      view.classList.toggle("rn-on", ren);
      if (sub) sub.innerHTML = ren ? `Renson stock <span class="rn-pill">Pilot · Admins only</span> Kept apart from Freedom; nothing here changes Freedom stock.` : esc(freedomSub);
      try { sessionStorage.setItem("oryx_mi_inventory", ren ? "renson" : "freedom"); } catch (e) { /* private mode */ }
      if (ren) load();
    };
    select.addEventListener("change", () => show(select.value));
    box.addEventListener("click", onClick);
    box.addEventListener("input", onInput);
    box.addEventListener("change", onChange);

    let last = null;
    try { last = sessionStorage.getItem("oryx_mi_inventory"); } catch (e) { last = null; }
    if (last === "renson") show("renson");
  }

  async function load() {
    ui.loading = true; ui.loadError = ""; render();
    const [items, imports] = await Promise.all([
      sb.from("renson_items").select("*").order("item_code").order("id"),
      sb.from("renson_imports").select("*").order("created_at", { ascending: false }).limit(1),
    ]);
    ui.loading = false;
    if (items.error || imports.error) { ui.loadError = (items.error || imports.error).message; return render(); }
    ui.items = items.data || [];
    ui.lastImport = (imports.data || [])[0] || null;
    if (!ui.items.length && ui.tab === "inventory" && !ui.parsed) ui.tab = "import";
    render();
  }

  // ------------------------------------------------------------ render
  const tile = (label, value, note) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<span class="kpi-note">${esc(note)}</span>` : ""}</div>`;

  function render() {
    const body = $("#rnBody");
    if (!body) return;
    const tabs = `<div class="rn-tabs" role="tablist">
      <button type="button" data-rn-tab="inventory" class="${ui.tab === "inventory" ? "on" : ""}">Inventory</button>
      <button type="button" data-rn-tab="import" class="${ui.tab === "import" ? "on" : ""}">Import stock file</button></div>`;
    const msg = ui.msg ? `<div class="rn-msg ${ui.msg[0]}">${esc(ui.msg[1])}</div>` : "";
    if (ui.loading) { body.innerHTML = tabs + `<div class="card">Loading Renson inventory…</div>`; return; }
    if (ui.loadError) { body.innerHTML = tabs + `<div class="rn-msg bad">Could not read the Renson inventory: ${esc(ui.loadError)}</div>`; return; }
    body.innerHTML = tabs + msg + (ui.tab === "inventory" ? inventoryHtml() : importHtml());
  }

  function inventoryHtml() {
    const all = ui.items;
    if (!all.length) {
      return `<div class="card"><p>No Renson items yet.</p><p class="muted">Import the Renson stock file to start the pilot.</p>
        <div class="rn-actions"><button type="button" class="btn-yellow" data-rn-tab="import">Import stock file</button></div></div>`;
    }
    const value = all.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const withStock = all.filter((i) => Number(i.current_qty) > 0);
    const noCost = withStock.filter((i) => i.unit_cost == null).length;
    const q = ui.q.toLowerCase();
    const rows = q ? all.filter((i) => [i.item_code, i.alt_codes, i.description, i.product_size, i.colour].join(" ").toLowerCase().includes(q)) : all;
    const shownValue = rows.reduce((s, i) => s + Number(i.current_value || 0), 0);
    const imp = ui.lastImport;
    return `<div class="rn-kpis">
        ${tile("Stock value", aed(value), "stock × unit cost")}
        ${tile("Items", String(all.length), withStock.length + " with stock")}
        ${tile("Out of stock", String(all.length - withStock.length))}
        ${tile("Stock without a cost", String(noCost), noCost ? "value counted as 0" : "")}
      </div>
      ${imp ? `<p class="muted">Opening stock from <b>${esc(imp.file_name)}</b>, imported ${esc(when(imp.created_at))} by ${esc(imp.imported_by_name || "—")}.</p>` : ""}
      <div class="rn-tools"><input type="search" id="rnSearch" placeholder="Search code, description, size, colour" value="${esc(ui.q)}" aria-label="Search Renson items">
        <span class="muted">${rows.length} of ${all.length} items</span></div>
      <div class="rn-wrap"><table class="rn-table"><thead><tr>
        <th>Code</th><th>Description</th><th>Size</th><th>Colour</th><th>Unit</th><th class="r">Stock</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
        <tbody>${rows.map((i) => `<tr class="${Number(i.current_qty) > 0 ? "" : "rn-zero"}">
          <td class="mono">${esc(i.item_code)}</td>
          <td>${esc(i.description)}${i.alt_codes ? `<span class="rn-alt">Also ${esc(i.alt_codes)}</span>` : ""}</td>
          <td>${esc(i.product_size || "")}</td><td>${esc(i.colour || "")}</td><td>${esc(i.unit || "")}</td>
          <td class="r">${qtyFmt(i.current_qty)}</td>
          <td class="r">${i.unit_cost == null ? `<span class="muted">No cost</span>` : aed(i.unit_cost)}</td>
          <td class="r">${aed(i.current_value)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="7">${q ? "Total of the items shown" : "Total stock value"}</td><td class="r">${aed(shownValue)}</td></tr></tfoot>
      </table></div>`;
  }

  function importHtml() {
    const has = ui.items.length > 0;
    let h = "";
    if (has) {
      h += `<div class="rn-msg info">The opening stock is already imported (${ui.items.length} items). To import again, first clear the Renson pilot data below. This clears Renson only.</div>`;
    }
    h += `<div class="card"><div class="rn-file">
        <input type="file" id="rnFile" accept=".xlsx,.xlsm,.xls" ${has ? "disabled" : ""} aria-label="Renson stock file">
        ${ui.file ? `<span class="muted">${esc(ui.file.name)}</span>` : `<span class="muted">Choose the Renson stock Excel (sheet STOCK).</span>`}
      </div>`;
    const p = ui.parsed;
    if (p) {
      if (p.error) h += `<div class="rn-msg bad">${esc(p.error)}</div>`;
      else {
        const errors = p.issues.filter((x) => x.kind === "error");
        const warns = p.issues.filter((x) => x.kind !== "error");
        h += `<div class="rn-kpis">
          ${tile("Items found", String(p.totals.items), p.totals.withStock + " with stock")}
          ${tile("No count in the file", String(p.totals.noCount), "imported with 0 stock")}
          ${tile("Stock value", aed(p.totals.value), "stock × unit cost")}
          ${tile("File's own INVENTORY VALUE", p.sheetTotal == null ? "Not found" : aed(p.sheetTotal), p.totalMatches == null ? "" : p.totalMatches ? "✓ matches" : "✗ does not match")}
        </div>
        <p class="muted">Sheet ${esc(p.sheet || "")}, header on row ${p.header.row}${p.stockDate ? ", stock counted " + esc(p.stockDate) : ""}.</p>`;
        if (errors.length) h += `<div class="rn-msg bad">${errors.length} problem(s) must be fixed in the file before it can be imported:</div>`;
        if (errors.length || warns.length) {
          h += `<ul class="rn-issues">${[...errors, ...warns].map((x) => `<li class="${x.kind}">Row ${x.row}${x.code ? " · " + esc(x.code) : ""}: ${esc(x.text)}</li>`).join("")}</ul>`;
        }
        h += `<div class="rn-wrap"><table class="rn-table"><thead><tr><th class="r">Row</th><th>Code</th><th>Description</th><th>Size</th><th>Colour</th><th>Unit</th>
          <th class="r">Stock</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead><tbody>
          ${p.items.map((i) => `<tr class="${i.qty > 0 ? "" : "rn-zero"}"><td class="r muted">${i.source_row}</td><td class="mono">${esc(i.item_code)}</td>
            <td>${esc(i.description)}${i.alt_codes ? `<span class="rn-alt">Also ${esc(i.alt_codes)}</span>` : ""}</td>
            <td>${esc(i.product_size)}</td><td>${esc(i.colour)}</td><td>${esc(i.unit)}</td>
            <td class="r">${qtyFmt(i.qty)}</td><td class="r">${i.unit_cost == null ? `<span class="muted">No cost</span>` : aed(i.unit_cost)}</td><td class="r">${aed(i.value)}</td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="8">Total stock value</td><td class="r">${aed(p.totals.value)}</td></tr></tfoot></table></div>
          <div class="rn-actions">
            <button type="button" class="btn-yellow" data-rn-act="confirm" ${p.ok && !has && !ui.busy ? "" : "disabled"}>${ui.busy ? "Importing…" : `Confirm import of ${p.totals.items} items`}</button>
            <button type="button" class="btn-outline" data-rn-act="cancel" ${ui.busy ? "disabled" : ""}>Cancel</button>
          </div>`;
      }
    }
    h += `</div>`;
    if (has) h += `<p style="margin-top:18px"><button type="button" class="rn-danger" data-rn-act="reset">Clear Renson pilot data…</button></p>`;
    return h;
  }

  // ------------------------------------------------------------ events
  function onClick(e) {
    const t = e.target.closest("[data-rn-tab],[data-rn-act]");
    if (!t) return;
    if (t.dataset.rnTab) { ui.tab = t.dataset.rnTab; ui.msg = null; return render(); }
    const act = t.dataset.rnAct;
    if (act === "cancel") { ui.file = null; ui.parsed = null; ui.hash = ""; ui.msg = null; return render(); }
    if (act === "confirm") return confirmImport();
    if (act === "reset") return resetPilot();
  }
  function onInput(e) {
    if (e.target.id === "rnSearch") {
      ui.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("#rnSearch"); if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    }
  }
  function onChange(e) {
    if (e.target.id === "rnFile" && e.target.files && e.target.files[0]) readFile(e.target.files[0]);
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = XLSX_SRC; s.onload = res; s.onerror = () => rej(new Error("couldn't load the Excel library"));
      document.head.appendChild(s);
    });
  }

  async function readFile(f) {
    ui.msg = null; ui.parsed = null; ui.file = f;
    if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) { ui.msg = ["bad", "Choose an Excel file (.xlsx or .xls)."]; ui.file = null; return render(); }
    if (f.size > MAX_FILE) { ui.msg = ["bad", "The file is larger than 15 MB."]; ui.file = null; return render(); }
    render();
    try {
      await loadXlsx();
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      ui.hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const book = window.XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
      const name = book.SheetNames.find((n) => n.trim().toUpperCase() === "STOCK") || book.SheetNames[0];
      const rows = window.XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      ui.parsed = R.parseRensonSheet(rows);
      ui.parsed.sheet = name;
    } catch (err) {
      ui.msg = ["bad", "Could not read the file: " + (err && err.message ? err.message : err)];
      ui.file = null;
    }
    render();
  }

  async function confirmImport() {
    const p = ui.parsed;
    if (!p || !p.ok || ui.busy) return;
    if (!window.confirm(`Import ${p.totals.items} Renson items (stock value ${aed(p.totals.value)})?\n\nThis is the Renson pilot only. Freedom stock is not changed.`)) return;
    ui.busy = true; render();
    const payload = {
      file_name: ui.file.name, file_hash: ui.hash, sheet: p.sheet, sheet_total: p.sheetTotal,
      items: p.items.map(({ value, ...i }) => i),
    };
    const { data, error } = await sb.rpc("renson_import_stock", { p: payload });
    ui.busy = false;
    if (error) {
      const m = /renson_already_imported/.test(error.message) ? "The opening stock was already imported."
        : /renson_not_allowed/.test(error.message) ? "Not allowed: the Renson pilot is for Admins only (or is switched off)."
        : "The import was refused: " + error.message;
      ui.msg = ["bad", m + " Nothing was saved."];
      return render();
    }
    ui.msg = ["ok", `Imported ${data.items} items (${data.items_with_stock} with stock), stock value ${aed(data.total_value)}.`];
    ui.file = null; ui.parsed = null; ui.hash = ""; ui.tab = "inventory";
    await load();
  }

  async function resetPilot() {
    const typed = window.prompt('This deletes ALL Renson pilot data (items, import, lines). Freedom is not touched.\n\nType RESET RENSON to continue.');
    if (typed == null) return;
    if (typed.trim() !== "RESET RENSON") { ui.msg = ["bad", "Not cleared: the words did not match."]; return render(); }
    const { data, error } = await sb.rpc("renson_reset_pilot", { p_confirm: "RESET RENSON" });
    ui.msg = error ? ["bad", "Not cleared: " + error.message] : ["ok", `Renson pilot data cleared (${data.items_removed} items).`];
    ui.tab = "import";
    await load();
  }
})();
