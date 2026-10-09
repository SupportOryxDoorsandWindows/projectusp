/* Master Inventory → one item's details and timeline (approved UI proposal,
 * page 11). Opens as a side panel from the Timeline button (or a row click).
 *
 * Everything shown comes from the live tables, never from a copy:
 *  - inventory_items: the item is re-read by id when the panel opens, so
 *    Stock / Unit cost / Value are exactly what Master Inventory stores.
 *  - inventory_transactions: every Check-in, Check-out and stock adjustment
 *    line for this item, newest first, 6 at a time ("Show older").
 * "Stock after" is worked back from the current stock: the newest movement
 * ends at today's quantity, and each older one ends where the next began.
 * Reads only; nothing here changes stock.
 */
(function () {
  const PAGE = 6;
  const MANUAL = "Manual correction";
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const aed = (n) => (n == null ? "—" : "AED " + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + num(Math.abs(n));

  function when(iso, now = new Date()) {
    const d = new Date(iso);
    const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return { short: t, long: `Today ${t}`, phrase: `today ${t}` };
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return { short: `Yesterday ${t}`, long: `Yesterday ${t}`, phrase: `yesterday ${t}` };
    const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    return { short: day, long: `${day} ${t}`, phrase: `${day} ${t}` };
  }

  // One transaction line → what the timeline shows. Same reading of the
  // records as the Activity tab: a "Manual correction" party is an Adjust,
  // and "Stock count: <reason>" marks a counted stock (Set stock to…).
  function describeTx(t) {
    const out = t.type === "check_out";
    const delta = (out ? -1 : 1) * Number(t.quantity || 0);
    const manual = (out ? t.client : t.supplier) === MANUAL;
    const ref = String((out ? t.job_number : t.invoice_number || t.po_number) || "");
    const parts = [];
    let kind, title;
    if (manual) {
      const count = /^stock count:/i.test(ref);
      const reason = ref.replace(/^stock count:\s*/i, "");
      kind = count ? "count" : out ? "out" : "in";
      title = count ? "Stock count" : out ? "Taken out by hand" : "Added by hand";
      if (!count) parts.push(MANUAL);
      if (reason) parts.push(`Reason: ${reason}`);
    } else if (out) {
      kind = "out"; title = "Check-out";
      if (ref) parts.push(`Order Number ${ref}`);
      if (t.client) parts.push(`Client ${t.client}`);
    } else {
      kind = "in"; title = t.is_new_item ? "Check-in · new item" : "Check-in";
      if (ref) parts.push(`Order Number ${ref}`);
      if (t.supplier) parts.push(t.supplier);
    }
    if (!manual && t.source_document_name) parts.push(t.source_document_name);
    return { kind, title, delta, detail: parts.join(" · "), who: t.performed_by_name || null };
  }

  // Newest first: the first row ends at `after` (today's stock for page 1);
  // returns the rows with stockAfter/stockBefore and where the next page starts.
  function withStockAfter(rows, after) {
    let cur = Number(after);
    const list = rows.map((t) => {
      const d = describeTx(t);
      const row = { t, ...d, stockAfter: cur, stockBefore: Math.round((cur - d.delta) * 1e6) / 1e6 };
      cur = row.stockBefore;
      return row;
    });
    return { list, next: cur };
  }

  /* ------------------------------------------------------------ panel */
  const $ = (s) => document.querySelector(s);
  let state = null; // { item, rows: [], nextAfter, offset, done, token }
  let lastFocus = null;

  function shell() {
    let el = $("#itemDrawer");
    if (el) return el;
    el = document.createElement("div");
    el.id = "itemDrawer";
    el.className = "drawer-wrap";
    el.hidden = true;
    el.innerHTML = `
      <div class="drawer-backdrop" data-close></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="idTitle">
        <div class="drawer-head">
          <div class="drawer-titles">
            <div class="mono" id="idCode"></div>
            <h2 id="idTitle"></h2>
          </div>
          <button class="drawer-x" type="button" data-close aria-label="Close">×</button>
        </div>
        <div class="drawer-kpis">
          <div class="kpi"><span>Stock</span><b id="idQty">—</b></div>
          <div class="kpi"><span>Unit cost</span><b id="idCost">—</b></div>
          <div class="kpi"><span>Value</span><b id="idValue">—</b></div>
        </div>
        <p class="drawer-last" id="idLast"></p>
        <div class="drawer-body">
          <div class="tl-h"><span>Timeline</span></div>
          <ol class="tl" id="idTl"></ol>
          <div id="idState" class="tl-state" role="status" aria-live="polite"></div>
        </div>
        <div class="drawer-foot">
          <span id="idCount" class="muted"></span>
          <span class="drawer-foot-btns">
            <button class="btn-outline" type="button" id="idAdjust" hidden>Adjust stock</button>
            <button class="btn-outline" type="button" id="idOlder">Show older</button>
          </span>
        </div>
      </aside>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
    el.querySelector("#idOlder").addEventListener("click", () => loadMore());
    // Same Adjust dialog as the list's Adjust button, for the item as just re-read.
    el.querySelector("#idAdjust").addEventListener("click", () => { if (state && state.onAdjust) state.onAdjust(state.item); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) close(); });
    // The list stays usable behind the panel (it's only dimmed): clicking
    // another item switches the panel to it; a click anywhere else outside
    // the panel -- another page, the background -- closes it.
    document.addEventListener("click", (e) => {
      if (el.hidden) return;
      // The path is fixed when the click starts, so a button the panel has
      // just redrawn (e.g. "Try again") still counts as inside it.
      const inside = e.composedPath().some((n) => n.nodeType === 1 &&
        (n.classList.contains("drawer") || n.hasAttribute("data-mi-row") || n.tagName === "DIALOG"));
      if (!inside) close();
    });
    return el;
  }

  function close() {
    const el = $("#itemDrawer");
    if (!el || el.hidden) return;
    el.hidden = true;
    document.body.classList.remove("drawer-open");
    if (state) state.token = null; // ignore answers that arrive after closing
    document.dispatchEvent(new CustomEvent("oryx-item-closed"));
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function setKpis(item) {
    $("#idCode").textContent = item.item_code + (item.bar_length_mm ? ` · ${num(item.bar_length_mm)} mm` : "");
    $("#idTitle").textContent = item.description || item.item_code;
    $("#idQty").textContent = num(item.current_qty);
    $("#idCost").textContent = aed(item.unit_cost);
    $("#idValue").textContent = item.current_value == null ? "—" : "AED " + Number(item.current_value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function rowHtml(r) {
    const w = when(r.t.created_at);
    return `<li class="tl-row k-${r.kind}">
      <span class="tl-dot" aria-hidden="true"></span>
      <div class="tl-line1"><b class="tl-q">${signed(r.delta)}</b> <b>${esc(r.title)}</b></div>
      ${r.kind === "count" ? `<div class="tl-detail">Set to a counted ${num(r.stockAfter)} (was ${num(r.stockBefore)})${r.detail ? " · " + esc(r.detail) : ""}</div>`
        : r.detail ? `<div class="tl-detail">${esc(r.detail)}</div>` : ""}
      <div class="tl-meta">${esc(r.who || "Before sign-in")} · ${esc(w.long)} · stock after: ${num(r.stockAfter)}</div>
    </li>`;
  }

  function paint() {
    const s = state;
    $("#idTl").innerHTML = s.rows.map(rowHtml).join("");
    const first = s.rows[0];
    $("#idLast").innerHTML = first
      ? (first.who ? `Last change by <b>${esc(first.who)}</b>, ${esc(when(first.t.created_at).phrase)}`
        : `Last change ${esc(when(first.t.created_at).phrase)} <span class="muted">(before names were recorded)</span>`)
      : s.done ? "No changes recorded yet." : "";
    $("#idCount").textContent = s.rows.length ? `Last ${s.rows.length} change${s.rows.length === 1 ? "" : "s"}` : "";
    const older = $("#idOlder");
    older.hidden = s.done || !s.rows.length;
    older.disabled = !!s.loading;
    older.textContent = s.loading && s.rows.length ? "Loading…" : "Show older";
    const st = $("#idState");
    if (s.error) st.innerHTML = `<p class="tl-err">Couldn't load the history: ${esc(s.error)}</p><button class="btn-outline" type="button" id="idRetry">Try again</button>`;
    else if (s.loading && !s.rows.length) st.innerHTML = `<p class="muted">Loading history…</p>`;
    else if (s.done && !s.rows.length) st.innerHTML = `<p class="muted">No movements recorded for this item yet. Check-ins, Check-outs and adjustments will show here.</p>`;
    else if (s.done && s.rows.length) st.innerHTML = `<p class="muted small">That's the full history.</p>`;
    else st.innerHTML = "";
    const retry = $("#idRetry");
    if (retry) retry.onclick = () => (s.item ? loadMore() : null);
  }

  async function loadMore() {
    const s = state;
    if (!s || s.loading || s.done) return;
    const sb = window.ORYX_AUTH && window.ORYX_AUTH.sb;
    s.loading = true; s.error = null; paint();
    const token = s.token;
    try {
      if (!s.fresh) {
        // Re-read the item itself first so the panel matches Master Inventory.
        const { data, error } = await sb.from("inventory_items").select("*").eq("id", s.item.id).maybeSingle();
        if (error) throw error;
        if (token !== s.token) return;
        if (!data) throw new Error("this item is no longer in Master Inventory");
        s.item = data; s.fresh = true; s.nextAfter = Number(data.current_qty); setKpis(data);
      }
      const { data, error } = await sb.from("inventory_transactions")
        .select("id,type,quantity,unit,value,unit_cost_used,job_number,client,supplier,invoice_number,po_number,source_document_name,is_new_item,created_at,performed_by_name")
        .eq("item_id", s.item.id)
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(s.offset, s.offset + PAGE); // one extra row says whether there's more
      if (error) throw error;
      if (token !== s.token) return; // another item was opened meanwhile
      const page = data.slice(0, PAGE);
      const { list, next } = withStockAfter(page, s.nextAfter);
      s.rows.push(...list); s.nextAfter = next; s.offset += page.length; s.done = data.length <= PAGE;
    } catch (err) {
      if (token !== s.token) return;
      console.error("item timeline", err);
      s.error = err.message || String(err);
    } finally {
      if (token === s.token) { s.loading = false; paint(); }
    }
  }

  function open(item, opts = {}) {
    if (!item || !item.id) return;
    const el = shell();
    if (el.hidden) lastFocus = document.activeElement;
    state = { item, rows: [], offset: 0, done: false, loading: false, error: null, fresh: false, nextAfter: Number(item.current_qty), token: Symbol("item"),
      onAdjust: opts.onAdjust || (state && state.item.id === item.id ? state.onAdjust : null) };
    $("#idAdjust").hidden = !state.onAdjust;
    setKpis(item);
    $("#idLast").textContent = "";
    $("#idTl").innerHTML = "";
    el.hidden = false;
    document.body.classList.add("drawer-open");
    el.querySelector(".drawer-x").focus();
    loadMore();
  }

  window.ORYX_ITEM = { open, close, describeTx, withStockAfter, when, currentItemId: () => (state && !$("#itemDrawer").hidden ? state.item.id : null) };
})();
