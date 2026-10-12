/* Master Inventory → one item's details and timeline (approved UI proposal,
 * page 11). Opens as a side panel from the Timeline button (or a row click).
 *
 * Everything shown comes from the live tables, never from a copy:
 *  - inventory_items: the item is re-read by id when the panel opens, so
 *    Stock / Unit cost / Value are exactly what Master Inventory stores.
 *  - inventory_transactions: every Check-in, Check-out and stock adjustment
 *    line for this item, newest first, 6 at a time ("Show older").
 *  - transaction_documents (documents.js): a "View PDF" link on movements
 *    whose original PDF is kept.
 *  - item_minimum_log: who last set the item's minimum level.
 * "Stock after" is worked back from the current stock: the newest movement
 * ends at today's quantity, and each older one ends where the next began.
 * Nothing here changes stock. The one thing it writes is the item's
 * "Minimum level" (inventory_items.buffer_level, the number the Low stock
 * badge compares against): Admins only, through set_item_minimum(), which
 * refuses anyone else and logs who changed it.
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

  // The "Minimum level" box: what it says for an item's stock and level.
  // Same rule as the Low stock badge in Master Inventory (stock <= level).
  function minimumState(item) {
    const level = item.buffer_level == null || item.buffer_level === "" ? null : Number(item.buffer_level);
    const qty = Number(item.current_qty);
    if (level == null) return { level: null, state: "unset" };
    if (!(qty > 0)) return { level, state: "out" };
    return { level, state: qty <= level ? "low" : "ok" };
  }

  // What was typed: "" = clear it, otherwise a number above 0.
  function parseMinimum(text) {
    const t = String(text == null ? "" : text).trim().replace(/,/g, "");
    if (t === "") return { ok: true, level: null };
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Type a number above 0, or leave it empty." };
    if (n > 1e9) return { ok: false, error: "That number is too big." };
    return { ok: true, level: n };
  }

  const MIN_ERRORS = {
    not_admin: "Only Admins can change the minimum level.",
    invalid_level: "Type a number above 0, or leave it empty.",
    no_such_item: "This item is no longer in Master Inventory.",
  };

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
        <div class="min-box" id="idMin"></div>
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

  function paintMin() {
    const s = state;
    const box = $("#idMin");
    if (!s || !box) return;
    const item = s.item;
    const unit = esc(item.unit_of_measure || "");
    const { level, state: st } = minimumState(item);
    const admin = !!(window.ORYX_AUTH && window.ORYX_AUTH.isAdmin && window.ORYX_AUTH.isAdmin());
    const warn = st === "low"
      ? `<p class="min-warn"><span class="badge warn">Low stock</span> Stock is ${num(item.current_qty)} ${unit} — at or below the minimum of ${num(level)}. Time to order.</p>`
      : st === "out" ? `<p class="min-warn"><span class="badge no">Out of stock</span> Below the minimum of ${num(level)}. Time to order.</p>` : "";
    const last = s.minLog && s.minLog.set_by_name
      ? `<p class="min-who">Set by ${esc(s.minLog.set_by_name)}, ${esc(when(s.minLog.set_at).phrase)}</p>` : "";
    const msg = s.minMsg ? `<p class="min-msg ${s.minMsg.err ? "err" : ""}" role="status">${esc(s.minMsg.text)}</p>` : "";
    if (!admin) {
      box.innerHTML = `<div class="min-top"><span class="min-label">Minimum level</span>
        <span class="min-val">${level == null ? `<span class="muted">Not set</span>` : `${num(level)} ${unit}`}</span></div>${warn}${level == null ? "" : last}`;
      return;
    }
    box.innerHTML = `<div class="min-top"><label class="min-label" for="idMinIn">Minimum level <span class="min-admin">· Admins only</span></label>
      <span class="min-in"><input id="idMinIn" type="text" inputmode="decimal" autocomplete="off" placeholder="Not set" value="${level == null ? "" : esc(String(level))}" aria-describedby="idMinHelp">
      <span class="unit">${unit}</span><button class="btn-outline" type="button" id="idMinSave"${s.minSaving ? " disabled" : ""}>${s.minSaving ? "Saving…" : "Save"}</button></span></div>
      <p class="min-help" id="idMinHelp">${level == null ? "Leave empty if you don't know yet. " : ""}When stock drops to this number, the item shows <b>Low stock</b>.${level == null ? "" : " Empty the box and Save to remove it."}</p>
      ${warn}${level == null ? "" : last}${msg}`;
    const input = box.querySelector("#idMinIn");
    input.addEventListener("input", () => { s.minDirty = true; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveMin(); } });
    box.querySelector("#idMinSave").addEventListener("click", saveMin);
  }

  async function saveMin() {
    const s = state;
    if (!s || s.minSaving) return;
    const input = $("#idMinIn");
    const parsed = parseMinimum(input ? input.value : "");
    if (!parsed.ok) { s.minMsg = { err: true, text: parsed.error }; keepTyped(paintMin); return; }
    const token = s.token;
    s.minSaving = true; s.minMsg = null; keepTyped(paintMin);
    try {
      const { data, error } = await window.ORYX_AUTH.sb.rpc("set_item_minimum", { p_item_id: s.item.id, p_level: parsed.level });
      if (error) throw error;
      if (token !== s.token) return;
      if (!data || !data.ok) { s.minMsg = { err: true, text: MIN_ERRORS[data && data.error] || "Not saved: " + ((data && data.error) || "unknown error") + "." }; return; }
      s.item = { ...s.item, buffer_level: data.buffer_level };
      s.minDirty = false;
      if (data.changed) {
        if (data.set_by_name) s.minLog = { set_by_name: data.set_by_name, set_at: data.set_at };
        s.minMsg = { text: data.buffer_level == null ? "Saved — no minimum for this item." : "Saved." };
        document.dispatchEvent(new CustomEvent("oryx-item-changed", { detail: { id: s.item.id, buffer_level: data.buffer_level } }));
      } else {
        s.minMsg = { text: "No change — that's already the minimum." };
      }
    } catch (err) {
      if (token !== s.token) return;
      console.error("minimum level", err);
      s.minMsg = { err: true, text: "Not saved: " + (err.message || err) + "." };
    } finally {
      if (token === s.token) {
        s.minSaving = false;
        if (s.minDirty) keepTyped(paintMin); else paintMin();
      }
    }
  }

  // Redraw the box without losing what the person is typing.
  function keepTyped(fn) {
    const input = $("#idMinIn");
    const typed = input ? input.value : null;
    const focused = input && document.activeElement === input;
    fn();
    const again = $("#idMinIn");
    if (again && typed != null) { again.value = typed; if (focused) again.focus(); }
  }

  // Who last set the minimum (only shown when one is set). A failure only
  // leaves the line out.
  async function loadMinLog(s, token) {
    try {
      const { data, error } = await window.ORYX_AUTH.sb.from("item_minimum_log")
        .select("set_by_name,set_at").eq("item_id", s.item.id)
        .order("set_at", { ascending: false }).order("id", { ascending: false }).limit(1);
      if (error) throw error;
      if (token !== s.token || s.minLog) return;
      s.minLog = data && data[0] ? data[0] : null;
      if (s.minLog) keepTyped(paintMin);
    } catch (err) { console.error("minimum level log", err); }
  }

  function rowHtml(r) {
    const w = when(r.t.created_at);
    return `<li class="tl-row k-${r.kind}">
      <span class="tl-dot" aria-hidden="true"></span>
      <div class="tl-line1"><b class="tl-q">${signed(r.delta)}</b> <b>${esc(r.title)}</b></div>
      ${r.kind === "count" ? `<div class="tl-detail">Set to a counted ${num(r.stockAfter)} (was ${num(r.stockBefore)})${r.detail ? " · " + esc(r.detail) : ""}</div>`
        : r.detail ? `<div class="tl-detail">${esc(r.detail)}</div>` : ""}
      <div class="tl-meta">${esc(r.who || "Before sign-in")} · ${esc(w.long)} · stock after: ${num(r.stockAfter)}</div>
      ${r.keptPdf && window.ORYX_DOCS ? `<div class="tl-doc">${window.ORYX_DOCS.links(r.t.source_document_hash)}</div>` : ""}
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
        if (s.minDirty || s.minSaving) keepTyped(paintMin); else paintMin();
        loadMinLog(s, token);
      }
      const { data, error } = await sb.from("inventory_transactions")
        .select("id,type,quantity,unit,value,unit_cost_used,job_number,client,supplier,invoice_number,po_number,source_document_name,source_document_hash,is_new_item,created_at,performed_by_name")
        .eq("item_id", s.item.id)
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(s.offset, s.offset + PAGE); // one extra row says whether there's more
      if (error) throw error;
      if (token !== s.token) return; // another item was opened meanwhile
      const page = data.slice(0, PAGE);
      const { list, next } = withStockAfter(page, s.nextAfter);
      s.rows.push(...list); s.nextAfter = next; s.offset += page.length; s.done = data.length <= PAGE;
      markKeptPdfs(s, list, token);
    } catch (err) {
      if (token !== s.token) return;
      console.error("item timeline", err);
      s.error = err.message || String(err);
    } finally {
      if (token === s.token) { s.loading = false; paint(); }
    }
  }

  // "View PDF" on movements whose original PDF is kept. Looked up after the
  // rows are shown; a failure only leaves the links out.
  async function markKeptPdfs(s, list, token) {
    const docs = window.ORYX_DOCS;
    const hashes = list.map((r) => r.t.source_document_hash).filter(Boolean);
    if (!docs || !hashes.length) return;
    try {
      const kept = await docs.lookup(hashes);
      if (token !== s.token || !kept.size) return;
      list.forEach((r) => { r.keptPdf = kept.has(r.t.source_document_hash); });
      if (!s.loading) paint();
    } catch (err) { console.error("kept PDFs", err); }
  }

  function open(item, opts = {}) {
    if (!item || !item.id) return;
    const el = shell();
    if (el.hidden) lastFocus = document.activeElement;
    state = { item, rows: [], offset: 0, done: false, loading: false, error: null, fresh: false, nextAfter: Number(item.current_qty), token: Symbol("item"),
      onAdjust: opts.onAdjust || (state && state.item.id === item.id ? state.onAdjust : null) };
    $("#idAdjust").hidden = !state.onAdjust;
    setKpis(item);
    paintMin();
    $("#idLast").textContent = "";
    $("#idTl").innerHTML = "";
    el.hidden = false;
    document.body.classList.add("drawer-open");
    el.querySelector(".drawer-x").focus();
    loadMore();
  }

  window.ORYX_ITEM = { open, close, describeTx, withStockAfter, when, minimumState, parseMinimum, currentItemId: () => (state && !$("#itemDrawer").hidden ? state.item.id : null) };
})();
