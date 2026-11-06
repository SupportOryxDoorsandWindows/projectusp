/* Allocated Materials (2026-11-06, owner's "Feature Request: Allocated
 * Materials in Master Inventory" + answers). Reserve stock for a job before
 * it is checked out:
 *   - from a job list: the Check-out page reads it as usual and "Allocate
 *     instead" (fp-checkout.js) opens this file's allocate window;
 *   - by hand on this page ("+ Allocate by hand").
 * Available = stock - open allocations; allocating more than Available is
 * refused by the server (allocation_create), so the window caps short lines.
 * After a Check-out is saved, fp-checkout.js calls afterCheckout(): the
 * server (allocation_sync) moves that job's checked-out quantities from
 * "reserved" to "checked out", each stock line once.
 * NEVER stock: nothing here changes inventory quantities.
 * Pure part: window.ORYX_ALLOC_CORE (tests/allocations.test.js).
 */
(function (root) {
  "use strict";
  const round = (v, d = 4) => Math.round((Number(v) || 0) * 10 ** d) / 10 ** d;
  const jobKey = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const STATUS = { open: "Open", closed: "Checked out", cancelled: "Cancelled" };
  const itemKey = (l) => String(l.inventory === "renson" ? l.renson_item_id : l.freedom_item_id);

  // Per Master item: open (reserved) quantity of OPEN allocations, with the jobs.
  function allocatedByItem(allocs, lines, kind) {
    const open = new Map(allocs.filter((a) => a.status === "open").map((a) => [String(a.id), a]));
    const out = new Map();
    for (const l of lines) {
      const a = open.get(String(l.allocation_id)), q = Number(l.qty_open) || 0;
      if (!a || l.inventory !== kind || q <= 0) continue;
      const k = itemKey(l);
      let e = out.get(k);
      if (!e) out.set(k, e = { qty: 0, jobs: [] });
      e.qty = round(e.qty + q);
      e.jobs.push({ job: a.job_number, client: a.client || "", qty: q, unit: l.unit || "" });
    }
    for (const e of out.values()) e.jobs.sort((x, y) => String(x.job).localeCompare(String(y.job), undefined, { numeric: true }));
    return out;
  }
  const n = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });
  function allocTitle(e) {
    return "Reserved for jobs (not checked out yet):\n" + e.jobs.map((j) => `Job ${j.job}${j.client ? " (" + j.client + ")" : ""} · ${n(j.qty)}${j.unit ? " " + j.unit : ""}`).join("\n")
      + "\nClick to open Allocated Materials.";
  }
  // Master Inventory lists. Applies saved Check-outs first (never twice),
  // never throws: no access / not installed = no figures.
  async function loadAllocatedByItem(sb, kind) {
    try {
      try { await sb.rpc("allocation_sync", { p_job: null }); } catch (e) { /* reading still works */ }
      const [a, l] = await Promise.all([
        sb.from("allocations").select("id, job_number, client, status").eq("status", "open").order("id").range(0, 4999),
        sb.from("allocation_lines").select("id, allocation_id, inventory, freedom_item_id, renson_item_id, qty_open, unit").gt("qty_open", 0).order("id").range(0, 9999),
      ]);
      if (a.error || l.error) throw a.error || l.error;
      return allocatedByItem(a.data || [], l.data || [], kind);
    } catch (e) { console.error("allocated", e); return new Map(); }
  }

  // One row per job, newest first by default.
  function groupByJob(allocs, lines) {
    const by = new Map(allocs.map((a) => [String(a.id), { ...a, lines: [], open: 0, allocated: 0, out: 0, released: 0, openLines: 0 }]));
    for (const l of lines) {
      const g = by.get(String(l.allocation_id));
      if (!g) continue;
      g.lines.push(l);
      g.allocated = round(g.allocated + Number(l.qty_allocated)); g.out = round(g.out + Number(l.qty_checked_out));
      g.released = round(g.released + Number(l.qty_released)); g.open = round(g.open + Number(l.qty_open));
      if (Number(l.qty_open) > 0) g.openLines += 1;
    }
    return [...by.values()];
  }
  function filterJobs(jobs, f) {
    const q = String(f.search || "").trim().toLowerCase();
    return jobs.map((g) => {
      if (f.status && f.status !== "all" && g.status !== f.status) return null;
      let lines = g.lines;
      if (f.inventory) lines = lines.filter((l) => l.inventory === f.inventory);
      if (q && !`${g.job_number} ${g.client || ""}`.toLowerCase().includes(q)) lines = lines.filter((l) => `${l.item_code || ""} ${l.description || ""}`.toLowerCase().includes(q));
      if (!lines.length) return null;
      return { ...g, shown: lines };
    }).filter(Boolean);
  }

  // Allocate window: the job list's lines, summed per item, capped at what is
  // available. take = what will be reserved; short = needed but not available.
  function capLines(lines, available) {
    const by = new Map();
    for (const l of lines) {
      const k = l.inventory + ":" + l.item_id;
      const g = by.get(k);
      if (g) g.need = round(g.need + Number(l.qty)); else by.set(k, { ...l, need: round(Number(l.qty)) });
    }
    return [...by.values()].map((l) => {
      const av = Math.max(0, round(Number(available.get(l.inventory + ":" + l.item_id)) || 0));
      const take = Math.min(l.need, av);
      return { ...l, available: av, take, short: round(l.need - take), on: take > 0 };
    });
  }

  root.ORYX_ALLOC_CORE = { STATUS, jobKey, allocatedByItem, allocTitle, loadAllocatedByItem, groupByJob, filterJobs, capLines };
  if (typeof document === "undefined" || !root.ORYX_AUTH) return;

  /* ================================ page ================================ */
  const AUTH = root.ORYX_AUTH, sb = AUTH.sb;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const aed = (v) => "AED " + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (v) => v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const badge = (s) => `<span class="badge ${s === "open" ? "warn" : s === "closed" ? "ok" : "grey"}">${esc(STATUS[s] || s)}</span>`;
  const ERR = {
    not_allowed: "Your account can't do this (signed out or switched off).", job_number_missing: "Enter the job number.",
    lines_missing: "Choose at least one material.", line_qty_invalid: "Every quantity must be more than 0.", line_invalid: "A material is not a Master Inventory item.",
    item_not_found: "A material is no longer in Master Inventory.", reason_missing: "A reason is required.", allocation_closed: "This allocation is already closed.",
    nothing_to_release: "Nothing to release.", allocation_not_found: "Allocation not found.",
  };
  function errText(e) {
    const m = String((e && e.message) || e);
    let x = m.match(/more_than_available: (\S+) \(available ([^,]+), asked ([^)]+)\)/);
    if (x) return `Not enough available for ${x[1]}: ${x[2]} available, ${x[3]} asked. Someone may have just reserved it; nothing was saved.`;
    x = m.match(/more_than_open: (.*)/);
    if (x) return "More than is still reserved: " + x[1];
    const k = Object.keys(ERR).find((key) => m.includes(key));
    return k ? ERR[k] : m;
  }
  function go(view) {
    const b = document.querySelector(`nav button[data-v="${view}"]`);
    if (b) b.click(); else if (root.ORYX_SHOW_VIEW) root.ORYX_SHOW_VIEW(view);
  }

  const ui = { allocs: [], lines: [], log: [], f: { status: "open" }, expanded: new Set(), page: {}, freedom: null, renson: null, open: null, rows: null, loaded: false };

  // Stock + open allocations per item, for Available.
  async function masterItems() {
    const [f, r] = await Promise.all([
      sb.from("inventory_items").select("id, item_code, description, bar_length_mm, unit_of_measure, unit_cost, current_qty, status").order("item_code").range(0, 4999),
      sb.from("renson_items").select("id, item_code, description, unit, unit_cost, current_qty").order("item_code").range(0, 4999),
    ]);
    ui.freedom = (f.data || []).filter((i) => !(i.status === "inactive" && Number(i.current_qty) === 0));
    ui.renson = r.data || [];
  }
  function item(inv, id) { return (inv === "renson" ? ui.renson : ui.freedom || []).find((i) => String(i.id) === String(id)) || null; }
  function availableMap() {
    const m = new Map();
    for (const i of ui.freedom || []) m.set("freedom:" + i.id, Number(i.current_qty) || 0);
    for (const i of ui.renson || []) m.set("renson:" + i.id, Number(i.current_qty) || 0);
    const open = new Set(ui.allocs.filter((a) => a.status === "open").map((a) => a.id));
    for (const l of ui.lines) if (open.has(l.allocation_id)) { const k = l.inventory + ":" + itemKey(l); m.set(k, round((m.get(k) || 0) - Number(l.qty_open))); }
    return m;
  }

  async function load() {
    const st = $("#alStatus"); if (st) st.textContent = "Loading…";
    try {
      try { await sb.rpc("allocation_sync", { p_job: null }); } catch (e) { /* still show */ }
      const all = (q) => q.then(({ data, error }) => { if (error) throw error; return data || []; });
      const [allocs, lines] = await Promise.all([
        all(sb.from("allocations").select("*").order("id", { ascending: false }).range(0, 4999)),
        all(sb.from("allocation_lines").select("*").order("id").range(0, 9999)),
        masterItems(),
      ]);
      Object.assign(ui, { allocs, lines, loaded: true });
      if (st) st.textContent = "";
      draw();
    } catch (e) {
      if (st) st.textContent = "Could not read Allocated Materials: " + (e.message || e) + (/allocation/.test(e.message || "") ? " (the database part may not be installed yet)" : "");
    }
  }

  function draw() {
    const jobs = groupByJob(ui.allocs, ui.lines);
    const open = jobs.filter((g) => g.status === "open");
    const value = open.reduce((s, g) => s + g.lines.reduce((t, l) => { const it = item(l.inventory, itemKey(l)); return t + Number(l.qty_open) * (Number(it && it.unit_cost) || 0); }, 0), 0);
    $("#alCards").innerHTML = `
      <div class="db-tile dark"><div class="db-k">Reserved value</div><div class="db-v"><small>AED</small>${Math.round(value).toLocaleString("en-US")}</div><div class="db-sub">Open allocations at today's cost · still in stock</div></div>
      <div class="db-tile"><div class="db-k">Open allocations</div><div class="db-v">${open.length}</div><div class="db-sub">Jobs with materials reserved</div></div>
      <div class="db-tile"><div class="db-k">Materials reserved</div><div class="db-v">${open.reduce((s, g) => s + g.openLines, 0)}</div><div class="db-sub">Lines still waiting for Check-out</div></div>
      <div class="db-tile"><div class="db-k">Checked out from allocations</div><div class="db-v">${fmtN(jobs.reduce((s, g) => s + g.out, 0))}</div><div class="db-sub">Quantity, all allocations</div></div>`;
    const f = ui.f;
    const opt = (v, t, cur) => `<option value="${esc(v)}"${String(cur || "") === String(v) ? " selected" : ""}>${esc(t)}</option>`;
    $("#alFilters").innerHTML = `
      <div><label class="field-label" for="alSearch">Search</label><input id="alSearch" type="search" value="${esc(f.search || "")}" placeholder="Job, client, code, description…" autocomplete="off"></div>
      <div><label class="field-label" for="alFStatus">Status</label><select id="alFStatus">${opt("open", "Open", f.status)}${opt("closed", "Checked out", f.status)}${opt("cancelled", "Cancelled", f.status)}${opt("all", "All", f.status)}</select></div>
      <div><label class="field-label" for="alFInv">Inventory</label><select id="alFInv">${opt("", "Freedom and Renson", f.inventory)}${opt("freedom", "Freedom", f.inventory)}${opt("renson", "Renson", f.inventory)}</select></div>`;
    drawTable();
  }

  const LINES_PER_PAGE = 10;
  function drawTable() {
    const jobs = filterJobs(groupByJob(ui.allocs, ui.lines), ui.f);
    if (!ui.allocs.length) {
      $("#alTable").innerHTML = `<div class="tr-empty"><b>Nothing allocated yet.</b><p>Reserve stock for a job with <b>Allocate a job list</b> (read the job list on the Check-out page and press <b>Allocate instead</b>) or <b>+ Allocate by hand</b>. Allocating never changes the stock; Available goes down until the job is checked out.</p></div>`;
      return;
    }
    const searching = !!String(ui.f.search || "").trim();
    $("#alTable").innerHTML = `<div class="tr-count small muted">${jobs.length} job${jobs.length === 1 ? "" : "s"} · click a job to see its materials</div>
      <div class="tr-scroll"><table class="mi-table tr-table tr-po-table"><thead><tr><th class="tr-exp-h"><span class="sr-only">Open</span></th>
        <th>Job</th><th>Client</th><th class="num">Materials</th><th class="num">Reserved now</th><th class="num">Checked out</th><th>Status</th><th>Allocated by</th><th>Last updated</th></tr></thead>
      <tbody>${jobs.map((g) => { const open = ui.expanded.has(g.id) || searching;
        return `<tr class="tr-po-row${open ? " open" : ""}" data-al-toggle="${g.id}" tabindex="0" aria-expanded="${open}">
          <td class="tr-exp">${open ? "▾" : "▸"}</td><td><b>${esc(g.job_number)}</b></td><td>${esc(g.client || "—")}</td>
          <td class="num">${g.openLines} open of ${g.lines.length}</td><td class="num"><b>${fmtN(g.open)}</b></td><td class="num">${fmtN(g.out)}</td>
          <td>${badge(g.status)}</td><td>${esc(g.created_by_name || "—")}</td><td class="small">${day(g.updated_at)}</td></tr>${open ? linesBlock(g) : ""}`; }).join("")
        || `<tr><td colspan="9" class="muted">Nothing matches these filters.</td></tr>`}</tbody></table></div>`;
  }
  function linesBlock(g) {
    const list = g.shown, pages = Math.max(1, Math.ceil(list.length / LINES_PER_PAGE));
    const p = Math.min(Math.max(0, ui.page[g.id] || 0), pages - 1);
    const items = list.slice(p * LINES_PER_PAGE, (p + 1) * LINES_PER_PAGE), av = availableMap();
    return `<tr class="tr-sub"><td colspan="9"><div class="tr-sub-in">
      <table class="tr-table tr-lines-view"><thead><tr><th>Code</th><th>Description</th><th>Inventory</th><th class="num">Allocated</th><th class="num">Checked out</th><th class="num">Released</th><th class="num">Reserved now</th><th class="num">Total stock</th><th class="num">Available</th></tr></thead>
      <tbody>${items.map((l) => { const it = item(l.inventory, itemKey(l));
        return `<tr data-al-open="${g.id}" tabindex="0"><td><code>${esc(l.item_code || "—")}</code></td><td>${esc(l.description || "")}</td><td>${l.inventory === "renson" ? "Renson" : "Freedom"}</td>
        <td class="num">${fmtN(l.qty_allocated)} ${esc(l.unit || "")}</td><td class="num">${fmtN(l.qty_checked_out)}</td><td class="num">${fmtN(l.qty_released)}</td><td class="num"><b>${fmtN(l.qty_open)}</b></td>
        <td class="num">${it ? fmtN(it.current_qty) : "—"}</td><td class="num">${it ? fmtN(av.get(l.inventory + ":" + itemKey(l))) : "—"}</td></tr>`; }).join("")}</tbody></table>
      <div class="tr-pager"><span class="small muted">Materials ${list.length ? p * LINES_PER_PAGE + 1 : 0}–${Math.min(list.length, (p + 1) * LINES_PER_PAGE)} of ${list.length}</span>
        ${pages > 1 ? `<button type="button" class="btn-outline btn-sm" data-al-page="${g.id}:${p - 1}"${p === 0 ? " disabled" : ""}>‹ Previous</button><span class="small">Page ${p + 1} of ${pages}</span>
        <button type="button" class="btn-outline btn-sm" data-al-page="${g.id}:${p + 1}"${p >= pages - 1 ? " disabled" : ""}>Next ›</button>` : ""}
        <button type="button" class="db-link" data-al-open="${g.id}">Open details${g.status === "open" ? " · release" : ""}</button></div></div></td></tr>`;
  }

  /* ----------------------------- one job ----------------------------- */
  const dlg = () => $("#alDlg");
  async function openJob(id) {
    const g = ui.allocs.find((a) => String(a.id) === String(id));
    if (!g) return;
    ui.open = g.id;
    const { data } = await sb.from("allocation_log").select("*").eq("allocation_id", g.id).order("id");
    ui.log = data || [];
    drawJob();
    if (!dlg().open) dlg().showModal();
  }
  function logText(x) {
    const d = x.detail || {};
    const lines = (d.lines && Array.isArray(d.lines)) ? d.lines.map((l) => `${l.code} × ${fmtN(l.qty)}`).join(", ") : "";
    if (x.action === "checked_out") return `${d.lines} line(s), ${fmtN(d.qty)} matched to a Check-out of this job`;
    if (x.action === "released") return `${d.all ? "all open quantities" : lines}. Reason: ${d.reason || "—"}`;
    return `${lines}${d.source ? ` · ${d.source === "job_list" ? "from a job list" : "by hand"}` : ""}${d.document_name ? ` (${d.document_name})` : ""}`;
  }
  function drawJob() {
    const g = groupByJob(ui.allocs, ui.lines).find((x) => x.id === ui.open);
    if (!g) { dlg().close(); return; }
    const isOpen = g.status === "open", av = availableMap();
    dlg().innerHTML = `<div class="bar"><b>Job ${esc(g.job_number)}</b> ${badge(g.status)}<button type="button" class="btn-outline btn-sm" data-al-close>Close</button></div>
    <div class="tr-dlg-body">
      <div class="tr-facts"><div><span class="db-sub">Client</span><b>${esc(g.client || "—")}</b></div><div><span class="db-sub">Allocated by</span><b>${esc(g.created_by_name || "—")}</b><span class="small muted">${day(g.created_at)}</span></div>
        <div><span class="db-sub">Reserved now</span><b>${fmtN(g.open)}</b></div><div><span class="db-sub">Checked out</span><b>${fmtN(g.out)}</b></div></div>
      ${g.notes ? `<p class="small">${esc(g.notes)}</p>` : ""}
      <p class="small muted">Reserved quantities stay in stock (and in the stock value) but are not Available to other jobs. When this job is checked out, what is checked out is taken off the reservation by itself.</p>
      <div class="tr-scroll"><table class="mi-table tr-table"><thead><tr><th>Code</th><th>Description</th><th class="num">Allocated</th><th class="num">Checked out</th><th class="num">Released</th><th class="num">Reserved now</th><th class="num">Available</th>${isOpen ? `<th class="num">Release</th>` : ""}</tr></thead><tbody>
      ${g.lines.map((l) => `<tr><td><code>${esc(l.item_code || "—")}</code><div class="small muted">${l.inventory === "renson" ? "Renson" : "Freedom"}</div></td><td>${esc(l.description || "")}</td>
        <td class="num">${fmtN(l.qty_allocated)} ${esc(l.unit || "")}</td><td class="num">${fmtN(l.qty_checked_out)}</td><td class="num">${fmtN(l.qty_released)}</td><td class="num"><b>${fmtN(l.qty_open)}</b></td>
        <td class="num">${fmtN(av.get(l.inventory + ":" + itemKey(l)))}</td>
        ${isOpen ? `<td class="num">${Number(l.qty_open) > 0 ? `<input class="al-rel" data-al-rel="${l.id}" inputmode="decimal" placeholder="0" aria-label="Release from ${esc(l.item_code)}" size="6">` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>
      ${isOpen ? `<form class="tr-edit" id="alRelForm">
        <div class="tr-wide"><label class="field-label" for="alReason">Reason (required)</label><input id="alReason" maxlength="300" placeholder="e.g. Job changed, fewer screens"></div>
        <div class="tr-edit-act"><button type="submit" class="btn-outline btn-sm">Release the quantities typed</button>
          <button type="button" class="btn-outline btn-sm al-danger" data-al-cancel>Cancel the whole allocation</button><span id="alRelMsg" class="small" role="status"></span></div>
      </form>` : ""}
      <details class="tr-log"><summary>History of changes (${ui.log.length})</summary><ul>${ui.log.map((x) => `<li><b>${day(x.created_at)}</b> ${esc(x.action.replace(/_/g, " "))} by ${esc(x.by_name || "—")} <span class="small muted">${esc(logText(x))}</span></li>`).join("")}</ul></details>
    </div>`;
  }
  async function release(all) {
    const m = $("#alRelMsg"), reason = ($("#alReason").value || "").trim();
    const lines = [...dlg().querySelectorAll("[data-al-rel]")].map((i) => ({ line_id: Number(i.dataset.alRel), qty: Number(String(i.value).replace(/,/g, "")) })).filter((x) => x.qty);
    m.className = "small error";
    if (!reason) { m.textContent = "Enter the reason first."; $("#alReason").focus(); return; }
    if (!all && !lines.length) { m.textContent = "Type a quantity to release on at least one line, or cancel the whole allocation."; return; }
    if (lines.some((x) => !(x.qty > 0))) { m.textContent = "Quantities must be more than 0."; return; }
    if (all && !confirm("Cancel the whole allocation? Everything still reserved goes back to Available.")) return;
    m.className = "small"; m.textContent = "Saving…";
    const { error } = await sb.rpc("allocation_release", { p: all ? { allocation_id: ui.open, reason, all: true } : { allocation_id: ui.open, reason, lines } });
    if (error) { m.className = "small error"; m.textContent = errText(error); return; }
    await load(); await openJob(ui.open);
    const m2 = $("#alRelMsg") || $("#alDlg .bar"); if (m2 && m2.id === "alRelMsg") { m2.className = "small ok"; m2.textContent = "Released."; }
  }

  /* --------------------- allocate window (job list / by hand) --------------------- */
  const ad = () => $("#alNewDlg");
  // From the Check-out page: ctx = {job, client, documentName, documentHash,
  // freedom: [{item_id, qty}], renson: [{item_code, qty}], done(res)}.
  async function fromCheckout(ctx) {
    await load();
    const lines = [];
    for (const l of ctx.freedom || []) { const it = item("freedom", l.item_id); if (it) lines.push({ inventory: "freedom", item_id: it.id, code: it.item_code, description: it.description + (it.bar_length_mm ? ` · ${it.bar_length_mm} mm` : ""), unit: it.unit_of_measure || "", qty: l.qty }); }
    for (const l of ctx.renson || []) { const it = (ui.renson || []).find((i) => String(i.item_code).toUpperCase() === String(l.item_code).toUpperCase()); if (it) lines.push({ inventory: "renson", item_id: it.id, code: it.item_code, description: it.description, unit: it.unit || "", qty: l.qty }); }
    ui.rows = capLines(lines, availableMap());
    ui.ctx = { ...ctx, source: "job_list" };
    drawAllocate();
    if (!ad().open) ad().showModal();
  }
  function openManual() {
    ui.ctx = { source: "manual", job: "", client: "" };
    ui.rows = [];
    ui.manual = [{ inventory: "freedom", item_id: "", qty: "" }];
    masterItems().then(() => { drawAllocate(); if (!ad().open) ad().showModal(); });
  }
  function itemOptions(inv) {
    return (inv === "renson" ? ui.renson : ui.freedom).map((i) => `<option value="${esc(i.item_code + " — " + i.description + (i.bar_length_mm ? ` · ${i.bar_length_mm} mm` : "") + " #" + i.id)}"></option>`).join("");
  }
  function drawAllocate() {
    const c = ui.ctx, manual = c.source === "manual", av = availableMap();
    const rows = manual ? ui.manual : ui.rows;
    const taking = manual ? rows.filter((r) => r.item_id && Number(r.qty) > 0) : rows.filter((r) => r.on && r.take > 0);
    const short = manual ? [] : rows.filter((r) => r.short > 0);
    ad().innerHTML = `<div class="bar"><b>${manual ? "Allocate by hand" : "Allocate this job list"}</b><button type="button" class="btn-outline btn-sm" data-al-nclose>Close</button></div>
    <div class="tr-dlg-body">
      <p class="small muted">Allocating reserves the stock for this job: it stays in stock, but other jobs can't reserve it. Nothing is taken off until the job is checked out.</p>
      <div class="tr-edit">
        <div><label class="field-label" for="alJob">Job number *</label><input id="alJob" value="${esc(c.job || "")}" maxlength="60"${manual ? "" : " readonly"}></div>
        <div><label class="field-label" for="alClient">Client</label><input id="alClient" value="${esc(c.client || "")}" maxlength="200"${manual ? "" : " readonly"}></div>
        <div class="tr-wide"><label class="field-label" for="alNotes">Notes</label><input id="alNotes" value="${esc(c.notes || "")}" maxlength="2000"></div>
      </div>
      ${c.documentName ? `<p class="small">Job list: <b>${esc(c.documentName)}</b></p>` : ""}
      <div class="tr-scroll"><table class="mi-table tr-table"><thead><tr>${manual
        ? `<th>Inventory</th><th>Material (code or name)</th><th class="num">Available</th><th class="num">Allocate</th><th></th>`
        : `<th>Allocate</th><th>Code</th><th>Description</th><th class="num">Needed</th><th class="num">Available</th><th class="num">Will allocate</th>`}</tr></thead><tbody>
      ${manual ? rows.map((r, i) => { const it = r.item_id ? item(r.inventory, r.item_id) : null;
        return `<tr><td><select data-al-m="inventory" data-i="${i}" aria-label="Inventory, line ${i + 1}"><option value="freedom"${r.inventory === "freedom" ? " selected" : ""}>Freedom</option><option value="renson"${r.inventory === "renson" ? " selected" : ""}>Renson</option></select></td>
          <td><input data-al-m="pick" data-i="${i}" list="alList${r.inventory}" value="${esc(it ? `${it.item_code} — ${it.description}${it.bar_length_mm ? ` · ${it.bar_length_mm} mm` : ""} #${it.id}` : r.text || "")}" placeholder="Type a code or name" aria-label="Material, line ${i + 1}" size="40"></td>
          <td class="num">${it ? fmtN(av.get(r.inventory + ":" + it.id)) + " " + esc(it.unit_of_measure || it.unit || "") : "—"}</td>
          <td class="num"><input data-al-m="qty" data-i="${i}" value="${esc(r.qty)}" inputmode="decimal" size="7" aria-label="Quantity, line ${i + 1}"></td>
          <td><button type="button" class="db-link" data-al-del="${i}" aria-label="Remove line ${i + 1}">Remove</button></td></tr>`; }).join("")
        : rows.map((r, i) => `<tr class="${r.on ? "" : "rn-zero"}"><td><input type="checkbox" data-al-on="${i}"${r.on ? " checked" : ""}${r.take > 0 ? "" : " disabled"} aria-label="Allocate ${esc(r.code)}"></td>
          <td><code>${esc(r.code)}</code><div class="small muted">${r.inventory === "renson" ? "Renson" : "Freedom"}</div></td><td>${esc(r.description)}</td>
          <td class="num">${fmtN(r.need)} ${esc(r.unit)}</td><td class="num">${fmtN(r.available)}</td>
          <td class="num"><b>${fmtN(r.on ? r.take : 0)}</b>${r.short > 0 ? `<div><span class="badge no">${fmtN(r.short)} short</span></div>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="6" class="muted">No Master Inventory items on this job list.</td></tr>`}</tbody></table></div>
      ${manual ? `<datalist id="alListfreedom">${itemOptions("freedom")}</datalist><datalist id="alListrenson">${itemOptions("renson")}</datalist>
        <p><button type="button" class="btn-outline btn-sm" data-al-add>+ Add line</button></p>` : ""}
      ${short.length ? `<p class="small error">${short.length} material${short.length === 1 ? " is" : "s are"} short: only what is available is reserved. The rest can be allocated later (same job number) when stock arrives.</p>` : ""}
      <div class="tr-edit-act"><button type="button" class="btn-yellow" data-al-save${taking.length ? "" : " disabled"}>Allocate ${taking.length} material${taking.length === 1 ? "" : "s"}</button><span id="alNMsg" class="small" role="status"></span></div>
    </div>`;
  }
  async function saveAllocate() {
    const c = ui.ctx, manual = c.source === "manual", m = $("#alNMsg");
    const job = ($("#alJob").value || "").trim();
    const lines = manual
      ? ui.manual.filter((r) => r.item_id && Number(r.qty) > 0).map((r) => ({ inventory: r.inventory, item_id: String(r.item_id), qty: Number(r.qty) }))
      : ui.rows.filter((r) => r.on && r.take > 0).map((r) => ({ inventory: r.inventory, item_id: String(r.item_id), qty: r.take }));
    m.className = "small error";
    if (!job) { m.textContent = "Enter the job number."; $("#alJob").focus(); return; }
    if (!lines.length) { m.textContent = "Nothing to allocate."; return; }
    if (manual && ui.manual.some((r) => (r.text || r.item_id) && (!r.item_id || !(Number(r.qty) > 0)))) { m.textContent = "Every line needs a Master Inventory material (pick it from the list) and a quantity above 0."; return; }
    m.className = "small"; m.textContent = "Allocating…";
    const btn = ad().querySelector("[data-al-save]"); if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc("allocation_create", { p: { job_number: job, client: ($("#alClient").value || "").trim() || null, notes: ($("#alNotes").value || "").trim() || null,
      source: c.source, document_name: c.documentName || null, document_hash: c.documentHash || null, lines } });
    if (error) { m.className = "small error"; m.textContent = errText(error); if (btn) btn.disabled = false; await masterItems(); return; }
    ad().close();
    await load();
    if (c.done) c.done(data);
  }

  /* ---------------------------- after Check-out ---------------------------- */
  // Called by fp-checkout.js after a Check-out was saved. Never throws; says
  // nothing when the job has no allocation (the Check-out screen stays as before).
  async function afterCheckout({ job, container }) {
    try {
      if (!job) return;
      const { data, error } = await sb.rpc("allocation_sync", { p_job: job });
      if (error || !data || !data.updated || !data.updated.length) return;
      const u = data.updated[0];
      if (container) {
        const p = document.createElement("p");
        p.className = "small al-done-note";
        p.innerHTML = `<b>Allocation:</b> job ${esc(u.job_number)} — ${fmtN(u.qty)} checked out from its reservation (${u.lines} material${u.lines === 1 ? "" : "s"})${u.status === "open" ? ", the rest is still reserved" : ", nothing left reserved"}. <button type="button" class="db-link" data-al-goto>Open Allocated Materials</button>`;
        container.appendChild(p);
        p.querySelector("[data-al-goto]").onclick = () => go("allocations");
      }
    } catch (e) { console.error("allocation after check-out", e); }
  }

  /* ------------------------------- wiring ------------------------------- */
  function onFilter(e) {
    const t = e.target, map = { alSearch: "search", alFStatus: "status", alFInv: "inventory" };
    if (!map[t.id]) return;
    if (e.type === "input" && t.id !== "alSearch") return;
    if ((ui.f[map[t.id]] || "") === t.value) return;   // e.g. "change" when leaving the search box: no redraw (it ate the next click)
    ui.f[map[t.id]] = t.value; ui.page = {};
    drawTable();
  }
  function showItem(code) {
    ui.f = { status: "open", search: String(code || "") };
    ui.expanded.clear(); ui.page = {};
    go("allocations");
  }
  function mount() {
    const v = $("#v-allocations");
    if (!v) return;
    ["#alDlg", "#alNewDlg"].forEach((id) => { const d = $(id); if (d) document.body.appendChild(d); });
    v.addEventListener("input", onFilter);
    v.addEventListener("change", onFilter);
    v.addEventListener("click", (e) => {
      const t = e.target;
      const pg = t.closest("[data-al-page]");
      if (pg) { const [id, p] = pg.dataset.alPage.split(":"); ui.page[Number(id)] = Number(p); drawTable(); return; }
      const op = t.closest("[data-al-open]");
      if (op) { openJob(op.dataset.alOpen); return; }
      const tg = t.closest("[data-al-toggle]");
      if (tg) { const id = Number(tg.dataset.alToggle); if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id); drawTable(); return; }
      if (t.id === "alManual") openManual();
      if (t.id === "alFromList") { go("fp"); const s = $("#fpStatus"); if (s) s.textContent = "Read the job list, then press \"Allocate instead\" (next to Confirm Check-out). Nothing is taken off."; }
      if (t.id === "alReload") load();
    });
    v.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (/^(BUTTON|INPUT|SELECT)$/.test(e.target.tagName)) return;
      const tg = e.target.closest && e.target.closest("tr[data-al-toggle]");
      if (tg) { e.preventDefault(); tg.click(); }
      const op = e.target.closest && e.target.closest("tr[data-al-open]");
      if (op) { e.preventDefault(); openJob(op.dataset.alOpen); }
    });
    dlg().addEventListener("click", (e) => {
      if (e.target.closest("[data-al-close]")) dlg().close();
      if (e.target.closest("[data-al-cancel]")) release(true);
    });
    dlg().addEventListener("submit", (e) => { e.preventDefault(); if (e.target.id === "alRelForm") release(false); });
    ad().addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-al-nclose]")) ad().close();
      if (t.closest("[data-al-save]")) saveAllocate();
      if (t.closest("[data-al-add]")) { ui.manual.push({ inventory: "freedom", item_id: "", qty: "" }); drawAllocate(); }
      const d = t.closest("[data-al-del]"); if (d) { ui.manual.splice(Number(d.dataset.alDel), 1); if (!ui.manual.length) ui.manual.push({ inventory: "freedom", item_id: "", qty: "" }); drawAllocate(); }
    });
    ad().addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.alOn != null) { const r = ui.rows[Number(t.dataset.alOn)]; r.on = t.checked; drawAllocate(); return; }
      if (t.dataset.alM) {
        const r = ui.manual[Number(t.dataset.i)];
        if (t.dataset.alM === "inventory") { r.inventory = t.value; r.item_id = ""; r.text = ""; }
        if (t.dataset.alM === "pick") { const m = String(t.value).match(/#(\S+)$/); r.text = t.value; r.item_id = m && item(r.inventory, m[1]) ? m[1] : ""; }
        if (t.dataset.alM === "qty") r.qty = String(t.value).replace(/,/g, "").trim();
        ui.ctx.job = $("#alJob").value; ui.ctx.client = $("#alClient").value; ui.ctx.notes = $("#alNotes").value;
        drawAllocate();
      }
    });
    const nav = document.querySelector('nav button[data-v="allocations"]');
    if (nav) nav.addEventListener("click", () => load());
    if (v.classList.contains("on")) load();
  }

  root.ORYX_ALLOC = { fromCheckout, afterCheckout, showItem, reload: load };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})(typeof window !== "undefined" ? window : globalThis);
