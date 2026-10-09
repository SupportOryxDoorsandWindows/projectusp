/* Activity timeline (tab "Activity").
 *
 * Reads, never writes:
 *  - inventory_transactions: every Check-out / Check-in / stock adjustment
 *    line. Since the timeline was added, each row carries performed_by_name
 *    (stamped on the server from the signed-in person); older rows have none
 *    and show "Not recorded".
 *  - delete_audit_log and account_activity_log: Admins only (row-level
 *    security returns nothing to everyone else).
 * Lines written by one save share one timestamp, so they are grouped back into
 * one event per (type, reference, party, time).
 */
(function () {
  const AUTH = window.ORYX_AUTH;
  if (!AUTH) return;
  const sb = AUTH.sb;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => (n == null ? "" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const aed = (n) => (n == null ? "—" : "AED " + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const timeOf = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => d.toLocaleDateString("en-CA"); // yyyy-mm-dd, local
  const dayLabel = (d) => {
    const today = new Date(), y = new Date(Date.now() - 86400000);
    const base = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return d.toDateString() === today.toDateString() ? `Today · ${base}` : d.toDateString() === y.toDateString() ? `Yesterday · ${base}` : base;
  };
  const initials = (name) => (name || "").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  const NOT_RECORDED = "Before sign-in";

  /* ------------------------------------------------------------ data */
  async function pagedSelect(table, cols, orderCol, max) {
    const PAGE = 1000, all = [];
    for (let from = 0; from < max; from += PAGE) {
      const { data, error } = await sb.from(table).select(cols).order(orderCol, { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  }

  const isManual = (t) => t.supplier === "Manual correction" || t.client === "Manual correction";

  function txEvents(txs) {
    const groups = new Map();
    for (const t of txs) {
      const isIn = t.type === "check_in";
      const ref = isIn ? (t.invoice_number || t.po_number || "") : (t.job_number || "");
      const party = isIn ? t.supplier : t.client;
      const key = `${t.type}|${ref}|${party}|${t.created_at}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, at: new Date(t.created_at), txType: t.type, ref, party, doc: t.source_document_name || "", lines: [],
          who: t.performed_by_name || null, whoEmail: t.performed_by_email || "", value: 0 };
        groups.set(key, g);
      }
      g.lines.push(t);
      g.value += Number(t.value) || 0;
    }
    return [...groups.values()].map((g) => {
      const n = g.lines.length, first = g.lines[0];
      const items = `${n} item${n === 1 ? "" : "s"}`;
      if (isManual(first)) {
        const count = /^Stock count:/i.test(g.ref);
        const reason = g.ref.replace(/^Stock count:\s*/i, "");
        const line = n === 1 ? `${first.item_code} ${g.txType === "check_in" ? "+" : "−"}${num(first.quantity)}` : items;
        return { ...g, kind: "adj", tag: "Adjustment",
          did: count ? `corrected stock by count · ${line}` : g.txType === "check_in" ? `added to stock by hand · ${line}` : `took out of stock by hand · ${line}`,
          detail: [n === 1 ? first.description : "", reason ? `Reason: ${reason}` : ""].filter(Boolean).join(" · ") };
      }
      if (g.txType === "check_in") {
        return { ...g, kind: "in", tag: "Check-in", did: `checked in ${items}`,
          detail: [g.party, g.ref ? `Order Number ${g.ref}` : "", g.doc, aed(g.value)].filter(Boolean).join(" · ") };
      }
      return { ...g, kind: "out", tag: "Check-out", did: `checked out ${items}`,
        detail: [g.ref ? `Order Number ${g.ref}` : "", g.party ? `Client ${g.party}` : "", g.doc, aed(g.value)].filter(Boolean).join(" · ") };
    });
  }

  function deleteEvents(rows) {
    const groups = new Map();
    for (const r of rows) {
      const at = new Date(r.happened_at);
      const key = `${r.action}|${r.user_email}|${r.area}|${r.document_name}|${at.toISOString().slice(0, 16)}`;
      let g = groups.get(key);
      if (!g) { g = { key, at, rows: [], r }; groups.set(key, g); }
      g.rows.push(r);
    }
    return [...groups.values()].map((g) => {
      const n = g.rows.length, r = g.r, d = r.record_detail || {};
      const verb = r.action === "restore" ? "restored" : "deleted";
      const one = [d.code, d.description].filter(Boolean).join(" ");
      return { key: "del|" + g.key, at: g.at, kind: "del", tag: r.action === "restore" ? "Restored line" : "Deleted line",
        who: r.user_name || r.user_email, whoEmail: r.user_email,
        did: n === 1 ? `${verb} ${one || "a line"}` : `${verb} ${n} lines before confirming`,
        detail: [(r.area === "checkin" ? "Check-in" : "Check-out"), d.job_number ? `Order Number ${d.job_number}` : "", d.invoice_number ? `Order Number ${d.invoice_number}` : "",
          r.document_name || "", r.reason ? `Reason: ${r.reason}` : ""].filter(Boolean).join(" · "),
        lines: g.rows.map((x) => ({ item_code: (x.record_detail || {}).code || x.record_ref, description: (x.record_detail || {}).description || "", quantity: (x.record_detail || {}).qty, unit: (x.record_detail || {}).unit })) };
    });
  }

  function accountEvents(rows) {
    const label = { invite: "invited", password_link: "made a new password link for", access_changed: "changed access for", removed: "removed", first_admin: "set up the first Admin" };
    return rows.map((r) => {
      const d = r.detail || {};
      const bits = [];
      if (typeof d.can_delete === "boolean") bits.push(`Allow Delete ${d.can_delete ? "on" : "off"}`);
      if (d.role) bits.push(d.role === "admin" ? "made Admin" : "Admin removed");
      if (typeof d.active === "boolean") bits.push(d.active ? "turned on" : "turned off");
      return { key: "acc|" + r.id, at: new Date(r.happened_at), kind: "acc", tag: "Account",
        who: r.actor_name || r.actor_email || "System", whoEmail: r.actor_email || "",
        did: `${label[r.action] || r.action} ${r.target_name || r.target_email || ""}`.trim(),
        detail: [r.target_email, bits.join(", ")].filter(Boolean).join(" · "), lines: [] };
    });
  }

  /* ------------------------------------------------------------ Activity tab */
  const PAGE = 25;
  const TYPES = [["", "All"], ["out", "Check-out"], ["in", "Check-in"], ["adj", "Adjustments"], ["del", "Deleted lines"], ["acc", "Accounts"]];
  let events = [], page = 0, type = "", loaded = false, loading = null;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      $("#actList").innerHTML = `<p class="small muted">Loading…</p>`;
      const admin = AUTH.isAdmin();
      $("#actAdminNote").hidden = !admin;
      try {
        const [txs, dels, accs] = await Promise.all([
          pagedSelect("inventory_transactions", "type, item_id, item_code, description, quantity, unit, value, job_number, client, supplier, invoice_number, po_number, source_document_name, created_at, performed_by_name, performed_by_email", "created_at", 20000),
          admin ? pagedSelect("delete_audit_log", "*", "happened_at", 10000).catch(() => []) : [],
          admin ? pagedSelect("account_activity_log", "*", "happened_at", 5000).catch(() => []) : [],
        ]);
        events = [...txEvents(txs), ...deleteEvents(dels), ...accountEvents(accs)].sort((a, b) => b.at - a.at);
        loaded = true;
        fillPeople();
        drawTypes();
        draw();
      } catch (e) {
        console.error(e);
        $("#actList").innerHTML = `<p class="small" style="color:var(--danger)">Couldn't load the activity: ${esc(e.message)}</p>`;
      } finally { loading = null; }
    })();
    return loading;
  }

  function fillPeople() {
    const sel = $("#actWho"), keep = sel.value;
    const names = [...new Set(events.map((e) => e.who || NOT_RECORDED))].sort((a, b) => (a === NOT_RECORDED) - (b === NOT_RECORDED) || a.localeCompare(b));
    sel.innerHTML = `<option value="">Everyone</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    if (names.includes(keep)) sel.value = keep;
  }

  function drawTypes() {
    const admin = AUTH.isAdmin();
    $("#actTypes").innerHTML = TYPES.filter(([k]) => admin || (k !== "del" && k !== "acc"))
      .map(([k, l]) => `<button type="button" class="pill ${k === type ? "on" : ""}" data-type="${k}" aria-pressed="${k === type}">${l}</button>`).join("");
    $("#actTypes").querySelectorAll("button").forEach((b) => { b.onclick = () => { type = b.dataset.type; page = 0; drawTypes(); draw(); }; });
  }

  function filtered() {
    const q = $("#actSearch").value.trim().toLowerCase();
    const who = $("#actWho").value, from = $("#actFrom").value, to = $("#actTo").value;
    return events.filter((e) => {
      if (type && e.kind !== type) return false;
      if (who && (e.who || NOT_RECORDED) !== who) return false;
      const d = dayKey(e.at);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (q) {
        const hay = [e.who, e.did, e.detail, e.tag, ...(e.lines || []).map((l) => `${l.item_code} ${l.description}`)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function drawStats(list) {
    const today = dayKey(new Date());
    const t = list.filter((e) => dayKey(e.at) === today);
    const c = (k) => t.filter((e) => e.kind === k).length;
    const jobs = c("out");
    const stats = [["Check-outs today", `${jobs} job${jobs === 1 ? "" : "s"}`], ["Check-ins today", c("in")], ["Stock adjustments today", c("adj")]];
    if (AUTH.isAdmin()) stats.push(["Deleted lines today", t.filter((e) => e.kind === "del" && e.tag === "Deleted line").reduce((s, e) => s + e.lines.length, 0), "red"]);
    $("#actStats").innerHTML = stats.map(([l, n, cls]) => `<div class="act-stat ${cls || ""}"><span>${l}</span><strong>${n}</strong></div>`).join("");
  }

  function eventHtml(e) {
    const who = e.who ? `<span class="act-who">${esc(e.who)}</span>` : `<span class="act-who none">${NOT_RECORDED}</span>`;
    const lines = (e.lines || []).length && e.kind !== "acc" ? `<table class="act-items"><tbody>${e.lines.map((l) => `<tr>
        <td class="code">${esc(l.item_code || "")}</td><td>${esc(l.description || "")}</td>
        <td class="num">${l.quantity != null ? (e.kind === "out" || (e.kind === "adj" && e.txType === "check_out") ? "−" : e.kind === "del" ? "" : "+") + num(l.quantity) + (l.unit ? " " + esc(l.unit) : "") : ""}</td>
        <td class="num">${l.value != null ? aed(l.value) : ""}</td></tr>`).join("")}</tbody></table>` : "";
    const head = `<div class="act-line"><span class="act-tag ${e.kind}">${esc(e.tag)}</span>${who}<span>${esc(e.did)}</span></div>
      ${e.detail ? `<div class="act-detail">${esc(e.detail)}</div>` : ""}`;
    return `<li class="act-ev">
      <span class="act-time">${esc(timeOf(e.at))}</span>
      <span class="act-rail"><span class="act-dot ${e.who ? "" : "none"} ${isMe(e) ? "me" : ""}" aria-hidden="true">${e.who ? esc(AUTH.initials ? AUTH.initials(e.who) : initials(e.who)) : "?"}</span></span>
      ${lines ? `<details class="act-card"><summary>${head}</summary>${lines}</details>` : `<div class="act-card">${head}</div>`}
    </li>`;
  }

  const isMe = (e) => !!(e.whoEmail && AUTH.profile && e.whoEmail === AUTH.profile.email);

  function draw() {
    if (!loaded) return;
    const list = filtered();
    drawStats(events);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.min(page, pages - 1);
    const shown = list.slice(page * PAGE, (page + 1) * PAGE);
    let html = "", day = null;
    const perDay = new Map();
    for (const e of list) perDay.set(dayKey(e.at), (perDay.get(dayKey(e.at)) || 0) + 1);
    for (const e of shown) {
      const d = dayKey(e.at);
      if (d !== day) {
        if (day) html += "</ol>";
        const n = perDay.get(d);
        html += `<div class="act-day"><span>${esc(dayLabel(e.at))}</span><span class="act-day-n">${n} event${n === 1 ? "" : "s"}</span></div><ol>`;
        day = d;
      }
      html += eventHtml(e);
    }
    if (day) html += "</ol>";
    $("#actList").innerHTML = html || `<p class="small muted">${events.length ? "Nothing matches these filters." : "No activity yet."}</p>`;
    $("#actInfo").textContent = list.length ? `Showing ${page * PAGE + 1}–${page * PAGE + shown.length} of ${list.length}${list.length !== events.length ? ` (filtered from ${events.length})` : ""}` : "";
    $("#actPage").textContent = `Page ${page + 1} of ${pages}`;
    $("#actPrev").disabled = page === 0;
    $("#actNext").disabled = page >= pages - 1;
  }

  // Export (.xlsx): exactly what the filters show (every page), one row per event.
  async function exportActivity() {
    const btn = $("#actExport"), st = $("#actExportStatus");
    const list = filtered();
    if (!loaded) { st.textContent = "The activity hasn't loaded yet — try again in a moment."; return; }
    if (!list.length) { st.textContent = "Nothing matches these filters — nothing to export."; return; }
    btn.disabled = true; st.textContent = "Preparing the Excel file…";
    try {
      if (!window.XLSX) await new Promise((res, rej) => {
        const sc = document.createElement("script");
        sc.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
        sc.onload = res; sc.onerror = () => rej(new Error("couldn't load the Excel library"));
        document.head.appendChild(sc);
      });
      const head = ["Date", "Time", "Type", "Person", "What", "Details", "Items", "Value (AED)"];
      const rows = list.map((e) => [dayKey(e.at), timeOf(e.at), e.tag, e.who || NOT_RECORDED, e.did, e.detail || "",
        (e.lines || []).length || "", e.value != null ? Math.round(e.value * 100) / 100 : ""]);
      const ws = window.XLSX.utils.aoa_to_sheet([["Oryx Doors & Windows — Activity"], [`Exported ${dayKey(new Date())}`], [], head, ...rows]);
      ws["!cols"] = [{ wch: 12 }, { wch: 7 }, { wch: 14 }, { wch: 20 }, { wch: 40 }, { wch: 60 }, { wch: 7 }, { wch: 14 }];
      ws["!autofilter"] = { ref: window.XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + rows.length, c: head.length - 1 } }) };
      for (let c = 0; c < head.length; c++) {
        const a = window.XLSX.utils.encode_cell({ r: 3, c });
        ws[a].s = { fill: { fgColor: { rgb: "A9A9A9" } }, font: { bold: true, color: { rgb: "FFFFFF" } } };
      }
      ws.A1.s = { font: { bold: true, sz: 14 } };
      for (let r = 4; r < 4 + rows.length; r++) { const a = window.XLSX.utils.encode_cell({ r, c: 7 }); if (ws[a] && typeof ws[a].v === "number") ws[a].z = '"AED" #,##0.00'; }
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Activity");
      const name = `Oryx Activity - ${dayKey(new Date())}.xlsx`;
      window.XLSX.writeFile(wb, name);
      st.textContent = `Exported ${list.length} event${list.length === 1 ? "" : "s"} as ${name}.`;
    } catch (err) {
      console.error(err); st.textContent = "Could not export: " + err.message;
    } finally { btn.disabled = false; }
  }
  $("#actExport").addEventListener("click", exportActivity);

  ["#actSearch", "#actWho", "#actFrom", "#actTo"].forEach((s) => $(s).addEventListener("input", () => { page = 0; draw(); }));
  $("#actPrev").addEventListener("click", () => { page = Math.max(0, page - 1); draw(); $("#v-activity").scrollIntoView({ block: "start" }); });
  $("#actNext").addEventListener("click", () => { page += 1; draw(); $("#v-activity").scrollIntoView({ block: "start" }); });
  // Fresh every time the tab is opened.
  $("#navActivity").addEventListener("click", () => { load(); });
  document.addEventListener("oryx-permissions", () => { if (loaded) load(); });

  window.ORYX_ACTIVITY = { reload: load };
})();
