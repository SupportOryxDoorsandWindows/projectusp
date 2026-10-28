/* Dashboard (tab "Dashboard"): stock at a glance.
 *
 * Reads, never writes: inventory_items, inventory_transactions (the last 60
 * days of Check-ins / Check-outs) and the item photo list. Stock counts and
 * Adjust ("Manual correction") are not usage or deliveries, so they are left
 * out of every figure here except the stock itself.
 * The numbers are worked out by summarise() (window.ORYX_DASH_CORE, tested in
 * tests/dashboard.test.js); the Kanban state comes from kanban.js.
 */
(function () {
  const DAY = 86400000;
  const USE_DAYS = 60; // usage window for "Running out soon"
  const RECENT_DAYS = 30; // tiles + "Most used"

  const isManual = (t) => t.supplier === "Manual correction" || t.client === "Manual correction";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // Product line from the description's first word (CLAUDE.md: families).
  function productLine(it) {
    const w = String(it.description || "").trim().split(/[\s-]+/)[0].toUpperCase();
    if (w === "ZLS1" || w === "ZLS") return "Flyscreen (ZLS1)";
    if (w === "ZLS2") return "Flyscreen (ZLS2)";
    if (w === "SMB1" || w === "SMB") return "Smartscreen (SMB1)";
    if (w === "ZLX" || w === "IZLX") return "ZLX / IZLX";
    return "Other & shared parts";
  }

  function itemLabel(it) {
    const len = num(it.bar_length_mm);
    return String(it.description || it.item_code) + (len > 0 ? ` · ${Math.round(len / 100) / 10} m` : "");
  }

  // items: inventory_items rows. txs: check_in / check_out rows of at least
  // the last 60 days. firstTxAt: the first movement ever recorded (usage is
  // spread over min(60 days, time since then)). kanbanState: kanban.js.
  function summarise({ items, txs, firstTxAt, photos, now, kanbanState }) {
    now = now ? new Date(now) : new Date();
    const since = (days) => now.getTime() - days * DAY;
    const real = (txs || []).filter((t) => !isManual(t));
    const recentOut = real.filter((t) => t.type === "check_out" && new Date(t.created_at).getTime() >= since(RECENT_DAYS));
    const recentIn = real.filter((t) => t.type === "check_in" && new Date(t.created_at).getTime() >= since(RECENT_DAYS));
    const useStart = Math.max(since(USE_DAYS), firstTxAt ? new Date(firstTxAt).getTime() : since(USE_DAYS));
    const useDays = Math.max(1, Math.round((now.getTime() - useStart) / DAY));
    const used = new Map(); // item_id -> qty used in the usage window
    for (const t of real) {
      if (t.type !== "check_out" || new Date(t.created_at).getTime() < useStart) continue;
      used.set(t.item_id, (used.get(t.item_id) || 0) + Math.abs(num(t.quantity)));
    }

    const stockValue = items.reduce((s, it) => s + num(it.current_value), 0);
    const out = items.filter((it) => num(it.current_qty) <= 0);
    const reorder = out.filter((it) => used.get(it.id) > 0)
      .sort((a, b) => used.get(b.id) - used.get(a.id));
    const kanban = (it) => (kanbanState ? kanbanState(it).state : "unset");
    const inStock = items.filter((it) => num(it.current_qty) > 0);
    // Same counts as Master Inventory's "Critical stock" / "Low stock" choices.
    const critical = items.filter((it) => kanban(it) === "critical");
    const low = items.filter((it) => kanban(it) === "low");
    const noCost = inStock.filter((it) => !(num(it.unit_cost) > 0));
    const codes = new Set(items.map((it) => String(it.item_code).toUpperCase()));
    const noPhoto = photos ? [...codes].filter((c) => !photos.has(c)).length : 0;
    const anyTrigger = items.some((it) => num(it.buffer_level) > 0);

    const attention = [];
    for (const it of reorder.slice(0, 3)) {
      attention.push({ kind: "reorder", tone: "red", item: it,
        title: `Reorder: ${itemLabel(it)}`, code: it.item_code,
        text: `${fmt(num(it.current_qty))} left · ${fmt(used.get(it.id))} ${it.unit_of_measure || ""} used in the last ${useDays} days` });
    }
    if (reorder.length > 3) attention.push({ kind: "filter", filter: "out", tone: "red", title: `${reorder.length - 3} more used items are out of stock`, text: "Used recently and now at 0", link: "See list" });
    if (critical.length) attention.push({ kind: "filter", filter: "critical", tone: "red", title: `${critical.length} item${critical.length === 1 ? " is" : "s are"} at the critical level`, text: "At or below the critical level set in Kanban", link: "See items" });
    if (low.length) attention.push({ kind: "filter", filter: "low", tone: "amber", title: `${low.length} item${low.length === 1 ? " is" : "s are"} low on stock`, text: "At or below the Kanban trigger level", link: "See items" });
    const quietOut = out.length - reorder.length;
    if (quietOut > 0) attention.push({ kind: "filter", filter: "out", tone: "blue", title: `${quietOut} other item${quietOut === 1 ? " is" : "s are"} out of stock`, text: "Not used lately: check if they still need reordering", link: "See list" });
    if (noCost.length) attention.push({ kind: "filter", filter: "nocost", tone: "amber", title: `${noCost.length} item${noCost.length === 1 ? "" : "s"} in stock ${noCost.length === 1 ? "has" : "have"} no cost`, text: "The stock value is missing their value", link: "Add costs" });
    if (noPhoto) attention.push({ kind: "filter", filter: "nophoto", tone: "blue", title: `${noPhoto} item code${noPhoto === 1 ? " has" : "s have"} no photo`, text: "Photos help staff pick the right part", link: "See items" });
    if (!anyTrigger) attention.push({ kind: "filter", filter: "all", tone: "blue", title: "Low-stock warnings are off", text: "No item has a Kanban trigger level yet", link: "Set levels" });

    const lines = new Map();
    for (const it of items) {
      const name = productLine(it);
      const l = lines.get(name) || { name, value: 0, items: 0, out: 0 };
      l.value += num(it.current_value); l.items += 1; if (num(it.current_qty) <= 0) l.out += 1;
      lines.set(name, l);
    }
    const ORDER = ["Flyscreen (ZLS1)", "Flyscreen (ZLS2)", "Smartscreen (SMB1)", "ZLX / IZLX", "Other & shared parts"];
    const families = [...lines.values()].sort((a, b) => b.value - a.value || ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
    const top = Math.max(1, ...families.map((f) => f.value));
    for (const f of families) { f.share = stockValue > 0 ? f.value / stockValue : 0; f.pct = f.value / top; }

    const byId = new Map(items.map((it) => [it.id, it]));
    const usage = new Map(); // last 30 days: item_id -> {qty, jobs}
    for (const t of recentOut) {
      const u = usage.get(t.item_id) || { qty: 0, jobs: new Set() };
      u.qty += Math.abs(num(t.quantity)); u.jobs.add(t.job_number || t.created_at);
      usage.set(t.item_id, u);
    }
    const mostUsed = [...usage].filter(([id]) => byId.has(id))
      .map(([id, u]) => ({ item: byId.get(id), qty: u.qty, jobs: u.jobs.size }))
      .sort((a, b) => b.jobs - a.jobs || b.qty - a.qty || String(a.item.item_code).localeCompare(String(b.item.item_code)))
      .slice(0, 6);

    const runningOut = inStock.filter((it) => used.get(it.id) > 0).map((it) => {
      const perDay = used.get(it.id) / useDays;
      return { item: it, perWeek: perDay * 7, daysLeft: Math.floor(num(it.current_qty) / perDay) };
    }).sort((a, b) => a.daysLeft - b.daysLeft || String(a.item.item_code).localeCompare(String(b.item.item_code))).slice(0, 6);

    const jobs = new Set(recentOut.map((t) => `${t.job_number}|${t.created_at}`));
    const deliveries = new Set(recentIn.map((t) => `${t.supplier}|${t.invoice_number || t.po_number || ""}|${t.created_at}`));
    return {
      stockValue, itemCount: items.length, inStockCount: inStock.length,
      outCount: out.length, outUsed: reorder.length, useDays,
      checkedOut: { value: recentOut.reduce((s, t) => s + num(t.value), 0), jobs: jobs.size, lines: recentOut.length },
      checkedIn: { value: recentIn.reduce((s, t) => s + num(t.value), 0), deliveries: deliveries.size, lines: recentIn.length },
      attention, families, mostUsed, runningOut,
    };
  }

  function fmt(n) { return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }

  const core = { summarise, productLine, itemLabel, isManual, USE_DAYS, RECENT_DAYS };
  (typeof window !== "undefined" ? window : globalThis).ORYX_DASH_CORE = core;

  /* ------------------------------------------------------------ screen */
  const AUTH = typeof window !== "undefined" && window.ORYX_AUTH;
  if (!AUTH || typeof document === "undefined") return;
  const sb = AUTH.sb;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const aed0 = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
  const pct = (x) => `${Math.round(x * 100)}%`;
  const ICON = { red: "!", amber: "$", blue: "i" };
  let loading = null;

  async function readAll(build, max) {
    const PAGE = 1000, all = [];
    for (let from = 0; from < max; from += PAGE) {
      const { data, error } = await build().range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  async function photosMap() {
    try {
      const res = await fetch("assets/items/index.json");
      const map = res.ok ? await res.json() : {};
      return new Set(Object.keys(map || {}).map((c) => c.toUpperCase()));
    } catch { return null; }
  }

  async function load() {
    if (loading) return loading;
    $("#dbStatus").textContent = "Loading…";
    loading = (async () => {
      try {
        const from = new Date(Date.now() - USE_DAYS * DAY).toISOString();
        const [items, txs, first, photos] = await Promise.all([
          readAll(() => sb.from("inventory_items").select("id,item_code,description,bar_length_mm,current_qty,unit_cost,current_value,unit_of_measure,buffer_level,critical_level").order("item_code").order("id"), 20000),
          readAll(() => sb.from("inventory_transactions").select("type,item_id,quantity,value,job_number,client,supplier,invoice_number,po_number,created_at")
            .in("type", ["check_in", "check_out"]).gte("created_at", from).order("created_at", { ascending: false }).order("id", { ascending: false }), 50000),
          sb.from("inventory_transactions").select("created_at").order("created_at", { ascending: true }).limit(1),
          photosMap(),
        ]);
        if (first.error) throw first.error;
        const s = summarise({ items, txs, firstTxAt: first.data[0] && first.data[0].created_at, photos,
          kanbanState: window.ORYX_KANBAN && window.ORYX_KANBAN.kanbanState });
        render(s);
        $("#dbStatus").textContent = "";
      } catch (err) {
        console.error(err);
        $("#dbStatus").textContent = "Could not load the dashboard: " + (err.message || err);
      } finally { loading = null; }
    })();
    return loading;
  }

  function render(s) {
    $("#dbDate").textContent = " · " + new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $("#dbTiles").innerHTML = `
      <div class="db-tile dark"><div class="db-k">Stock value</div><div class="db-v"><small>AED</small>${aed0(s.stockValue)}</div>
        <div class="db-sub">${s.itemCount} items in Master Inventory · ${s.inStockCount} in stock</div></div>
      <div class="db-tile${s.outCount ? " bad" : ""}"><div class="db-k">Out of stock</div><div class="db-v">${s.outCount} <small>items</small></div>
        <div class="db-sub">${s.outUsed} of them used in the last ${s.useDays} days</div></div>
      <div class="db-tile"><div class="db-k">→ Checked out · last 30 days</div><div class="db-v"><small>AED</small>${aed0(s.checkedOut.value)}</div>
        <div class="db-sub">${s.checkedOut.jobs} job${s.checkedOut.jobs === 1 ? "" : "s"} · ${s.checkedOut.lines} lines</div></div>
      <div class="db-tile"><div class="db-k">← Checked in · last 30 days</div><div class="db-v"><small>AED</small>${aed0(s.checkedIn.value)}</div>
        <div class="db-sub">${s.checkedIn.deliveries ? `${s.checkedIn.deliveries} supplier deliver${s.checkedIn.deliveries === 1 ? "y" : "ies"}` : "No supplier deliveries"}</div></div>`;

    $("#dbAttnCount").textContent = s.attention.length ? `${s.attention.length} thing${s.attention.length === 1 ? "" : "s"} to sort out` : "";
    $("#dbAttn").innerHTML = s.attention.length ? s.attention.map((a, n) => `
      <div class="db-attn"><span class="db-ic ${a.tone}" aria-hidden="true">${ICON[a.tone]}</span>
        <div class="db-attn-t"><b>${esc(a.title)}${a.code ? ` <code>${esc(a.code)}</code>` : ""}</b><span>${esc(a.text)}</span></div>
        ${a.kind === "reorder" ? `<button type="button" class="db-link" data-db-attn="${n}" data-mi-row="${esc(a.item.id)}">Open item</button>`
          : `<button type="button" class="db-link" data-db-filter="${esc(a.filter)}">${esc(a.link)}</button>`}
      </div>`).join("") : `<div class="db-ok">Nothing to sort out right now.</div>`;
    document.querySelectorAll("#dbAttn [data-db-attn]").forEach((b) => {
      b.onclick = () => openItem(s.attention[+b.dataset.dbAttn].item);
    });

    $("#dbFam").innerHTML = s.families.map((f) => `
      <div class="db-fam"><div class="db-fam-1"><span>${esc(f.name)}</span><span>AED ${aed0(f.value)}<small>${pct(f.share)}</small></span></div>
        <div class="db-bar"><i style="width:${Math.max(0.5, f.pct * 100).toFixed(1)}%"></i></div>
        <div class="db-fam-2">${f.items} items${f.out ? ` · <em>${f.out} out of stock</em>` : ""}</div></div>`).join("") +
      `<div class="db-total"><span>Total</span><b>AED ${aed0(s.stockValue)}</b></div>`;

    $("#dbUsed").innerHTML = s.mostUsed.length ? `
      <table class="db-table"><thead><tr><th>Item</th><th class="num db-hide-sm">Jobs</th><th class="num">Used</th></tr></thead><tbody>
      ${s.mostUsed.map((u, n) => `<tr class="db-item" data-db-used="${n}" data-mi-row="${esc(u.item.id)}"><td><b>${esc(itemLabel(u.item))}</b><br><code>${esc(u.item.item_code)}</code></td>
        <td class="num db-hide-sm">${u.jobs}</td><td class="num"><b>${fmt(u.qty)} ${esc(u.item.unit_of_measure || "")}</b></td></tr>`).join("")}
      </tbody></table>` : `<div class="db-ok">No Check-outs in the last 30 days.</div>`;
    document.querySelectorAll("#dbUsed [data-db-used]").forEach((tr) => { tr.onclick = () => openItem(s.mostUsed[+tr.dataset.dbUsed].item); });

    const tone = (d) => (d <= 14 ? "red" : d <= 30 ? "amber" : "");
    $("#dbSoon").innerHTML = s.runningOut.length ? `
      <table class="db-table"><thead><tr><th>Item</th><th class="num">In stock</th><th class="num db-hide-sm">Used / week</th><th class="num">Runs out in</th></tr></thead><tbody>
      ${s.runningOut.map((r, n) => `<tr class="db-item" data-db-soon="${n}" data-mi-row="${esc(r.item.id)}"><td><b>${esc(itemLabel(r.item))}</b><br><code>${esc(r.item.item_code)}</code></td>
        <td class="num">${fmt(r.item.current_qty)} ${esc(r.item.unit_of_measure || "")}</td>
        <td class="num db-hide-sm">${fmt(Math.round(r.perWeek * 10) / 10)} ${esc(r.item.unit_of_measure || "")}</td>
        <td class="num"><span class="db-days ${tone(r.daysLeft)}">~${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}</span></td></tr>`).join("")}
      </tbody></table>` : `<div class="db-ok">No item in stock has been used in the last ${s.useDays} days.</div>`;
    $("#dbSoon").insertAdjacentHTML("beforeend", `<div class="db-note">Worked out from the last ${s.useDays} days of Check-outs (stock counts and adjustments not included). Red = 2 weeks or less, amber = within a month. Items already at 0 are under Needs attention.</div>`);
    document.querySelectorAll("#dbSoon [data-db-soon]").forEach((tr) => { tr.onclick = () => openItem(s.runningOut[+tr.dataset.dbSoon].item); });
  }

  // Rows carry data-mi-row so the item panel's "click outside closes it" rule
  // (item-timeline.js) treats them like Master Inventory rows.
  function openItem(item) {
    if (window.ORYX_ITEM && item) window.ORYX_ITEM.open(item);
  }

  // Master Inventory with a "Show" choice: the option is put in first so the
  // list keeps it when it fills the dropdown (drawFilter keeps the current one).
  function showInventory(filter) {
    const sel = $("#miFilter"), search = $("#miSearch");
    if (sel) { sel.innerHTML = `<option value="${esc(filter)}"></option>`; sel.value = filter; }
    if (search) search.value = "";
    const nav = document.querySelector('nav button[data-v="master-inventory"]');
    if (nav) nav.click();
  }

  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-db-go]");
    if (go) { const nav = document.querySelector(`nav button[data-v="${go.dataset.dbGo}"]`); if (nav) nav.click(); return; }
    const f = e.target.closest("[data-db-filter]");
    if (f && f.closest("#v-dashboard")) showInventory(f.dataset.dbFilter);
  });
  const nav = $("#navDashboard");
  if (nav) nav.addEventListener("click", () => { load(); });
  // Read again every time the Dashboard is opened (stock changes elsewhere).
  window.ORYX_DASH = { reload: load };
  // The Dashboard is the first page after sign-in (user's request
  // 2026-10-29): read it now unless the person already went elsewhere.
  const view = $("#v-dashboard");
  if (view && view.classList.contains("on")) load();
})();
