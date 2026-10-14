/* What's New & Updates: the bell (top-right), its panel, the details view,
 * the full history page (#v-updates) and the Admin publishing form.
 *
 * It tells people what changed in the SYSTEM (new features, improvements,
 * bug fixes, announcements). What people did with stock stays in Activity
 * and the audit logs -- nothing here reads or changes those.
 *
 * Data (supabase/sql/system_updates.sql):
 *  - system_updates: everyone signed in reads PUBLISHED rows; Admins also
 *    see drafts and are the only ones who can add / edit / delete. The
 *    database sets who published it and when -- this file never sends them.
 *  - system_update_reads: "I have read this", one row per person per update,
 *    written only for yourself. Read status therefore follows the person
 *    across browsers and sign-ins.
 * Hiding the Admin buttons is convenience only; the database refuses
 * anyone else (row-level security).
 */
(function (root) {
  const CATEGORIES = {
    new_feature: { label: "New feature", plural: "New Features" },
    improvement: { label: "Improvement", plural: "Improvements" },
    bug_fix: { label: "Bug fix", plural: "Bug Fixes" },
    important: { label: "Important", plural: "Important" },
  };
  const LIMITS = { title: 150, summary: 500, details: 10000, version: 40 };
  const PAGE = 12;
  const PANEL_COUNT = 6;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------------------------------------------- pure helpers */

  // Published updates this person hasn't read yet (newest first).
  function unreadOf(published, readIds) {
    return published.filter((u) => u.status === "published" && !readIds.has(u.id));
  }

  // Search (title or short/full description, any case) + category.
  function filterUpdates(list, { q = "", cat = "all" } = {}) {
    const needle = String(q).trim().toLowerCase();
    return list.filter((u) => {
      if (cat !== "all" && u.category !== cat) return false;
      if (!needle) return true;
      return [u.title, u.summary, u.details].some((t) => String(t || "").toLowerCase().includes(needle));
    });
  }

  // What the form would save. intent: "draft" | "publish" | "save".
  function validateForm(f, intent) {
    const out = {
      title: String(f.title || "").trim(),
      category: f.category,
      summary: String(f.summary || "").trim(),
      details: String(f.details || "").trim() || null,
      version: String(f.version || "").trim() || null,
    };
    const errors = [];
    if (!out.title) errors.push("Add a title.");
    if (out.title.length > LIMITS.title) errors.push(`Keep the title under ${LIMITS.title} characters.`);
    if (!CATEGORIES[out.category]) errors.push("Choose a category.");
    if (!out.summary) errors.push("Add a short description.");
    if (out.summary.length > LIMITS.summary) errors.push(`Keep the short description under ${LIMITS.summary} characters.`);
    if (out.details && out.details.length > LIMITS.details) errors.push("The full description is too long.");
    if (out.version && out.version.length > LIMITS.version) errors.push(`Keep the version under ${LIMITS.version} characters.`);
    if (intent === "publish" && !f.live) errors.push("Tick “This change is already live for everyone” before publishing — only announce what people can use now.");
    return { ok: !errors.length, errors, row: out };
  }

  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " +
      d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  const catBadge = (c) => `<span class="upd-cat upd-cat-${esc(c)}">${esc((CATEGORIES[c] || { label: c }).label)}</span>`;
  const paragraphs = (text) => String(text || "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

  root.ORYX_UPDATES_CORE = { CATEGORIES, LIMITS, unreadOf, filterUpdates, validateForm, when };

  /* ------------------------------------------------------- the screens */
  const AUTH = root.ORYX_AUTH;
  if (!AUTH || typeof document === "undefined") return;
  const sb = AUTH.sb;
  const $ = (s) => document.querySelector(s);
  const isAdmin = () => !!(AUTH.isAdmin && AUTH.isAdmin());

  const st = {
    published: [],      // newest first
    drafts: [],         // Admins only
    readIds: new Set(),
    loaded: false,
    loadError: null,
    page: { q: "", cat: "all", show: "published", shown: PAGE },
    editing: null,      // update being edited in the form (null = new)
  };

  const COLS = "id,title,category,summary,details,version,status,publisher_name,published_at,created_at,updated_at";

  async function load() {
    try {
      const [pub, reads, drafts] = await Promise.all([
        sb.from("system_updates").select(COLS).eq("status", "published")
          .order("published_at", { ascending: false }).limit(1000),
        sb.from("system_update_reads").select("update_id").limit(5000),
        isAdmin()
          ? sb.from("system_updates").select(COLS).eq("status", "draft").order("updated_at", { ascending: false }).limit(500)
          : Promise.resolve({ data: [] }),
      ]);
      if (pub.error) throw pub.error;
      if (reads.error) throw reads.error;
      if (drafts.error) throw drafts.error;
      st.published = pub.data || [];
      st.readIds = new Set((reads.data || []).map((r) => r.update_id));
      st.drafts = drafts.data || [];
      st.loaded = true; st.loadError = null;
    } catch (err) {
      console.error("updates", err);
      st.loadError = err.message || String(err);
    }
    drawAll();
  }

  // Marks updates read for the signed-in person only (the database fills in
  // user_id and refuses anything else). Already read = nothing to do.
  async function markRead(ids) {
    const fresh = ids.filter((id) => !st.readIds.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => st.readIds.add(id));
    drawAll();
    const { error } = await sb.from("system_update_reads")
      .upsert(fresh.map((update_id) => ({ update_id })), { onConflict: "update_id,user_id", ignoreDuplicates: true });
    if (error) {
      console.error("mark read", error);
      fresh.forEach((id) => st.readIds.delete(id));
      drawAll();
    }
  }

  function drawAll() { drawBell(); if (isPanelOpen()) drawPanel(); if (isPageOn()) drawPage(); }

  /* ------------------------------------------------------------ bell */
  function shell() {
    if ($("#updBell")) return;
    const bell = document.createElement("button");
    bell.type = "button"; bell.id = "updBell"; bell.className = "upd-bell";
    bell.setAttribute("aria-haspopup", "dialog"); bell.setAttribute("aria-expanded", "false"); bell.setAttribute("aria-controls", "updPanel");
    bell.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>
      <span class="upd-badge" id="updBadge" hidden></span>`;
    const host = document.querySelector(".side-user");
    host.insertBefore(bell, host.firstChild);

    const panel = document.createElement("div");
    panel.id = "updPanel"; panel.className = "upd-panel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "What's New & Updates");
    document.body.appendChild(panel);

    bell.addEventListener("click", (e) => { e.stopPropagation(); isPanelOpen() ? closePanel() : openPanel(); });
    document.addEventListener("click", (e) => {
      if (!isPanelOpen()) return;
      if (e.composedPath().some((n) => n === panel || n === bell)) return;
      closePanel();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isPanelOpen()) { closePanel(); bell.focus(); } });
    panel.addEventListener("click", onPanelClick);
  }

  function drawBell() {
    const n = unreadOf(st.published, st.readIds).length;
    const badge = $("#updBadge"), bell = $("#updBell");
    if (!badge) return;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
    bell.setAttribute("aria-label", n ? `What's New & Updates, ${n} unread` : "What's New & Updates");
    bell.title = n ? `${n} new update${n === 1 ? "" : "s"}` : "What's New & Updates";
  }

  /* ----------------------------------------------------------- panel */
  const isPanelOpen = () => { const p = $("#updPanel"); return !!p && !p.hidden; };
  function openPanel() {
    $("#updPanel").hidden = false; $("#updBell").setAttribute("aria-expanded", "true");
    drawPanel();
    if (!st.loaded) load();
  }
  function closePanel() { const p = $("#updPanel"); if (!p) return; p.hidden = true; $("#updBell").setAttribute("aria-expanded", "false"); }

  function itemHtml(u, { compact } = {}) {
    const unread = u.status === "published" && !st.readIds.has(u.id);
    const meta = [u.status === "draft" ? `Draft · last saved ${when(u.updated_at)}` : when(u.published_at),
      u.status === "published" && u.publisher_name ? `by ${esc(u.publisher_name)}` : "",
      u.version ? `v${esc(u.version)}` : ""].filter(Boolean).join(" · ");
    return `<li class="upd-item ${unread ? "unread" : "read"} ${compact ? "compact" : ""}">
      <button type="button" class="upd-open" data-upd-open="${esc(u.id)}">
        <span class="upd-dot" aria-hidden="true"></span>
        <span class="upd-text">
          <span class="upd-line1">${catBadge(u.category)}${unread ? `<span class="upd-new">New</span>` : ""}${u.status === "draft" ? `<span class="upd-draft">Draft</span>` : ""}</span>
          <span class="upd-title">${esc(u.title)}</span>
          <span class="upd-summary">${esc(u.summary)}</span>
          <span class="upd-meta">${meta}</span>
        </span>
        <span class="sr-only">${unread ? "Unread" : "Read"}</span>
      </button>
    </li>`;
  }

  function drawPanel() {
    const p = $("#updPanel");
    const unread = unreadOf(st.published, st.readIds);
    const list = st.published.slice(0, PANEL_COUNT);
    let body;
    if (st.loadError) body = `<p class="upd-empty err">Couldn't load updates: ${esc(st.loadError)} <button type="button" class="btn-link" data-upd-retry>Try again</button></p>`;
    else if (!st.loaded) body = `<p class="upd-empty">Loading…</p>`;
    else if (!list.length) body = `<div class="upd-empty"><b>You're all caught up.</b><br>New features, improvements and fixes will show up here.</div>`;
    else body = `<ul class="upd-list">${list.map((u) => itemHtml(u, { compact: true })).join("")}</ul>`;
    p.innerHTML = `
      <div class="upd-panel-head">
        <div><h2>What's New &amp; Updates</h2><p>See the latest improvements to your inventory system.</p></div>
        ${unread.length ? `<button type="button" class="btn-link" data-upd-markall>Mark all as read</button>` : ""}
      </div>
      <div class="upd-panel-body">${body}</div>
      <div class="upd-panel-foot"><button type="button" class="btn-link" data-upd-all>View all updates</button></div>`;
  }

  function onPanelClick(e) {
    const open = e.target.closest("[data-upd-open]");
    if (open) { openDetails(open.dataset.updOpen); return; }
    if (e.target.closest("[data-upd-markall]")) { markRead(unreadOf(st.published, st.readIds).map((u) => u.id)); return; }
    if (e.target.closest("[data-upd-all]")) { closePanel(); showPage(); return; }
    if (e.target.closest("[data-upd-retry]")) { st.loadError = null; drawPanel(); load(); }
  }

  /* --------------------------------------------------------- details */
  function findUpdate(id) { return st.published.find((u) => u.id === id) || st.drafts.find((u) => u.id === id); }

  function detailsHtml(u, { preview } = {}) {
    return `
      <div class="upd-detail-head">
        <div class="upd-line1">${catBadge(u.category)}${u.status === "draft" && !preview ? `<span class="upd-draft">Draft — not visible to staff</span>` : ""}${u.version ? `<span class="upd-version">v${esc(u.version)}</span>` : ""}</div>
        <h2 id="updDetailTitle">${esc(u.title)}</h2>
        <p class="upd-meta">${u.status === "published" || preview ? `${preview ? "Will show the publish date" : esc(when(u.published_at))}${u.publisher_name || preview ? ` · by ${esc(preview ? (AUTH.profile && (AUTH.profile.full_name || AUTH.profile.email)) || "you" : u.publisher_name)}` : ""}` : `Last saved ${esc(when(u.updated_at))}`}</p>
      </div>
      <div class="upd-detail-body"><p class="upd-lead">${esc(u.summary)}</p>${u.details ? paragraphs(u.details) : ""}</div>`;
  }

  function openDetails(id) {
    const u = findUpdate(id);
    if (!u) return;
    let dlg = $("#updDetail");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "updDetail"; dlg.className = "upd-dialog";
      dlg.setAttribute("aria-labelledby", "updDetailTitle");
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-upd-close]")) dlg.close();
        const ed = e.target.closest("[data-upd-edit]");
        if (ed) { dlg.close(); openForm(findUpdate(ed.dataset.updEdit)); }
      });
    }
    dlg.innerHTML = `<div class="upd-dialog-inner">${detailsHtml(u)}
      <div class="upd-dialog-foot">
        ${isAdmin() ? `<button type="button" class="btn-outline" data-upd-edit="${esc(u.id)}">Edit</button>` : ""}
        <button type="button" class="btn-dark" data-upd-close>Close</button>
      </div></div>`;
    if (!dlg.open) dlg.showModal();
    if (u.status === "published") markRead([u.id]);
  }

  /* ------------------------------------------------- full history page */
  function pageShell() {
    if ($("#v-updates")) return;
    const sec = document.createElement("section");
    sec.id = "v-updates"; sec.className = "view";
    sec.innerHTML = `
      <div class="page-head">
        <div><h1>What's New &amp; Updates</h1><p>See the latest improvements to your inventory system.</p></div>
        <div class="page-actions">
          <button class="btn-outline" type="button" id="updMarkAllPage" hidden>Mark all as read</button>
          <button class="btn-yellow" type="button" id="updNew" hidden>New update</button>
        </div>
      </div>
      <div class="page-body">
        <div class="upd-toolbar">
          <div class="pill-row" id="updCats" role="group" aria-label="Category"></div>
          <input id="updSearch" type="search" autocomplete="off" placeholder="Search updates" aria-label="Search updates by title or description">
        </div>
        <div class="seg seg-sm upd-show" id="updShow" hidden role="group" aria-label="Show">
          <button type="button" data-show="published" class="on">Published</button>
          <button type="button" data-show="draft">Drafts</button>
        </div>
        <p class="small muted" id="updCount" role="status" aria-live="polite"></p>
        <ul class="upd-list upd-page-list" id="updList"></ul>
        <div class="upd-more"><button type="button" class="btn-outline" id="updMore" hidden>Load more</button></div>
      </div>`;
    document.querySelector("main").appendChild(sec);
    $("#updSearch").addEventListener("input", (e) => { st.page.q = e.target.value; st.page.shown = PAGE; drawPage(); });
    $("#updCats").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b) return;
      st.page.cat = b.dataset.cat; st.page.shown = PAGE; drawPage();
    });
    $("#updShow").addEventListener("click", (e) => {
      const b = e.target.closest("[data-show]"); if (!b) return;
      st.page.show = b.dataset.show; st.page.shown = PAGE; drawPage();
    });
    $("#updMore").addEventListener("click", () => { st.page.shown += PAGE; drawPage(); });
    $("#updList").addEventListener("click", (e) => { const o = e.target.closest("[data-upd-open]"); if (o) openDetails(o.dataset.updOpen); });
    $("#updNew").addEventListener("click", () => openForm(null));
    $("#updMarkAllPage").addEventListener("click", () => markRead(unreadOf(st.published, st.readIds).map((u) => u.id)));
  }

  const isPageOn = () => { const v = $("#v-updates"); return !!v && v.classList.contains("on"); };
  function showPage() {
    pageShell();
    if (root.ORYX_SHOW_VIEW) root.ORYX_SHOW_VIEW("updates");
    drawPage();
    if (!st.loaded) load();
  }

  function drawPage() {
    const admin = isAdmin();
    if (!admin && st.page.show === "draft") st.page.show = "published";
    $("#updNew").hidden = !admin;
    $("#updShow").hidden = !admin;
    for (const b of $("#updShow").querySelectorAll("[data-show]")) b.classList.toggle("on", b.dataset.show === st.page.show);
    const source = st.page.show === "draft" ? st.drafts : st.published;
    const cats = [["all", "All"], ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.plural])];
    $("#updCats").innerHTML = cats.map(([k, label]) =>
      `<button type="button" class="pill ${k === st.page.cat ? "on" : ""}" data-cat="${k}" aria-pressed="${k === st.page.cat}">${esc(label)}</button>`).join("");
    const unreadN = unreadOf(st.published, st.readIds).length;
    $("#updMarkAllPage").hidden = !unreadN;

    const list = filterUpdates(source, st.page);
    const shown = list.slice(0, st.page.shown);
    if (st.loadError) {
      $("#updList").innerHTML = `<li class="upd-empty err">Couldn't load updates: ${esc(st.loadError)}</li>`;
      $("#updCount").textContent = "";
    } else if (!st.loaded) {
      $("#updList").innerHTML = `<li class="upd-empty">Loading…</li>`;
      $("#updCount").textContent = "";
    } else if (!list.length) {
      const filtered = st.page.q.trim() || st.page.cat !== "all";
      $("#updList").innerHTML = `<li class="upd-empty">${filtered ? "No updates match your search." :
        st.page.show === "draft" ? "No drafts. Use “New update” to start one." : "<b>No updates yet.</b><br>New features, improvements and fixes will show up here."}</li>`;
      $("#updCount").textContent = "";
    } else {
      $("#updList").innerHTML = shown.map((u) => itemHtml(u)).join("");
      $("#updCount").textContent = `${list.length} ${st.page.show === "draft" ? "draft" : "update"}${list.length === 1 ? "" : "s"}` +
        (st.page.show === "published" && unreadN ? ` · ${unreadN} unread` : "");
    }
    $("#updMore").hidden = !(st.loaded && shown.length < list.length);
  }

  /* ---------------------------------------------- Admin publishing form */
  function formShell() {
    let dlg = $("#updForm");
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "updForm"; dlg.className = "upd-dialog upd-form";
    dlg.setAttribute("aria-labelledby", "updFormTitle");
    dlg.innerHTML = `<form class="upd-dialog-inner" novalidate>
      <h2 id="updFormTitle">New update</h2>
      <p class="small muted" id="updFormNote"></p>
      <div class="upd-fields" id="updFields">
        <label class="upd-field"><span>Update title <b class="req">*</b></span>
          <input name="title" maxlength="${LIMITS.title}" required autocomplete="off"></label>
        <div class="upd-row">
          <label class="upd-field"><span>Category <b class="req">*</b></span>
            <select name="category" required><option value="">Choose…</option>
              ${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${esc(c.label.toUpperCase())}</option>`).join("")}</select></label>
          <label class="upd-field"><span>Version <span class="opt">(optional)</span></span>
            <input name="version" maxlength="${LIMITS.version}" autocomplete="off" placeholder="e.g. 1.4"></label>
        </div>
        <label class="upd-field"><span>Short description <b class="req">*</b> <span class="opt" id="updSumCount"></span></span>
          <textarea name="summary" rows="2" maxlength="${LIMITS.summary}" required></textarea></label>
        <label class="upd-field"><span>Full description <span class="opt">(optional)</span></span>
          <textarea name="details" rows="6" maxlength="${LIMITS.details}" placeholder="What changed, who it affects, and anything people need to do."></textarea></label>
        <label class="upd-live"><input type="checkbox" name="live"> This change is already live for everyone <span class="opt">(needed to publish — only announce what people can use now)</span></label>
      </div>
      <div class="upd-preview" id="updPreview" hidden></div>
      <p class="upd-form-msg" id="updFormMsg" role="alert"></p>
      <div class="upd-dialog-foot">
        <button type="button" class="btn-outline upd-del" id="updDelete" hidden>Delete</button>
        <span class="upd-foot-gap"></span>
        <button type="button" class="btn-outline" id="updCancel">Cancel</button>
        <button type="button" class="btn-outline" id="updPreviewBtn">Preview</button>
        <button type="button" class="btn-outline" id="updDraftBtn">Save draft</button>
        <button type="button" class="btn-dark" id="updPublishBtn">Publish</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);
    const f = dlg.querySelector("form");
    f.summary.addEventListener("input", () => { $("#updSumCount").textContent = `${f.summary.value.length}/${LIMITS.summary}`; });
    $("#updCancel").addEventListener("click", () => dlg.close());
    $("#updPreviewBtn").addEventListener("click", togglePreview);
    $("#updDraftBtn").addEventListener("click", () => save("draft"));
    $("#updPublishBtn").addEventListener("click", () => save(st.editing && st.editing.status === "published" ? "save" : "publish"));
    $("#updDelete").addEventListener("click", remove);
    dlg.addEventListener("close", () => { st.editing = null; });
    return dlg;
  }

  function formValues() {
    const f = $("#updForm form");
    return { title: f.title.value, category: f.category.value, summary: f.summary.value, details: f.details.value, version: f.version.value, live: f.live.checked };
  }
  function formMsg(text, ok) { const m = $("#updFormMsg"); m.textContent = text || ""; m.classList.toggle("ok", !!ok); }

  function openForm(u) {
    if (!isAdmin()) return;
    const dlg = formShell();
    const f = dlg.querySelector("form");
    st.editing = u || null;
    f.reset();
    if (u) { f.title.value = u.title; f.category.value = u.category; f.summary.value = u.summary; f.details.value = u.details || ""; f.version.value = u.version || ""; }
    const published = !!(u && u.status === "published");
    $("#updFormTitle").textContent = u ? "Edit update" : "New update";
    $("#updFormNote").textContent = published
      ? `Published ${when(u.published_at)}${u.publisher_name ? " by " + u.publisher_name : ""}. Changes show to everyone straight away; the publish date stays the same.`
      : "Drafts are only visible to Admins. Publishing shows it to everyone and adds it to their bell.";
    $("#updDraftBtn").textContent = published ? "Move back to draft" : "Save draft";
    $("#updPublishBtn").textContent = published ? "Save changes" : "Publish";
    f.querySelector(".upd-live").hidden = published;
    $("#updDelete").hidden = !u;
    $("#updSumCount").textContent = `${f.summary.value.length}/${LIMITS.summary}`;
    $("#updPreview").hidden = true; $("#updFields").hidden = false; $("#updPreviewBtn").textContent = "Preview";
    formMsg("");
    if (!dlg.open) dlg.showModal();
    f.title.focus();
  }

  function togglePreview() {
    const showing = !$("#updPreview").hidden;
    if (showing) { $("#updPreview").hidden = true; $("#updFields").hidden = false; $("#updPreviewBtn").textContent = "Preview"; return; }
    const v = validateForm(formValues(), "draft");
    if (!v.ok) { formMsg(v.errors.join(" ")); return; }
    formMsg("");
    const u = { ...v.row, status: "published", publisher_name: null };
    $("#updPreview").innerHTML = `<p class="small muted">How it will look for staff:</p>
      <ul class="upd-list">${itemHtml({ ...u, id: "preview", published_at: new Date().toISOString() }, { compact: true }).replace(/data-upd-open="[^"]*"/, "disabled")}</ul>
      <div class="upd-preview-detail">${detailsHtml(u, { preview: true })}</div>`;
    $("#updPreview").hidden = false; $("#updFields").hidden = true; $("#updPreviewBtn").textContent = "Back to edit";
  }

  async function save(intent) {
    const vals = formValues();
    const editingPublished = st.editing && st.editing.status === "published";
    const v = validateForm(vals, intent === "publish" ? "publish" : "draft");
    if (!v.ok) { formMsg(v.errors.join(" ")); if (!$("#updPreview").hidden) togglePreview(); return; }
    const status = intent === "draft" ? "draft" : intent === "publish" ? "published" : (editingPublished ? "published" : "draft");
    if (intent === "draft" && editingPublished &&
        !confirm("Move this update back to draft? Staff will no longer see it until it is published again.")) return;
    const row = { ...v.row, status };
    const btns = $("#updForm").querySelectorAll(".upd-dialog-foot button");
    btns.forEach((b) => { b.disabled = true; });
    formMsg(intent === "publish" ? "Publishing…" : "Saving…", true);
    try {
      const q = st.editing
        ? sb.from("system_updates").update(row).eq("id", st.editing.id).select(COLS).maybeSingle()
        : sb.from("system_updates").insert(row).select(COLS).maybeSingle();
      const { data, error } = await q;
      if (error) throw error;
      if (!data) throw new Error("Not saved — only Admins can publish or change updates.");
      $("#updForm").close();
      await load();
      // The person who published it has obviously seen it.
      if (data.status === "published") await markRead([data.id]);
      if (isPageOn()) { st.page.show = data.status === "draft" ? "draft" : "published"; drawPage(); }
      flash(data.status === "published" ? (intent === "publish" ? "Published — everyone will see it in their bell." : "Saved.") : "Saved as a draft. Only Admins can see it.");
    } catch (err) {
      console.error("save update", err);
      formMsg(/row-level security|permission denied/i.test(err.message || "") ? "Not saved — only Admins can publish or change updates." : "Not saved: " + (err.message || err));
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  async function remove() {
    const u = st.editing;
    if (!u) return;
    if (!confirm(`Delete “${u.title}”? This can't be undone${u.status === "published" ? ", and it disappears from everyone's updates" : ""}.`)) return;
    const { data, error } = await sb.from("system_updates").delete().eq("id", u.id).select("id");
    if (error || !data || !data.length) { formMsg(error ? "Not deleted: " + error.message : "Not deleted — only Admins can delete updates."); return; }
    $("#updForm").close();
    await load();
    flash("Deleted.");
  }

  function flash(text) {
    let el = $("#updFlash");
    if (!el) { el = document.createElement("div"); el.id = "updFlash"; el.className = "upd-flash"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = text; el.hidden = false;
    clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  /* ------------------------------------------------------------ start */
  function start() {
    shell();
    pageShell();
    drawBell();
    load();
    // Instant: the database tells this page the moment an update is
    // published, edited or removed (Supabase Realtime on system_updates).
    // Row-level security still decides what each person receives, and the
    // page then re-reads the list the normal way.
    live();
    // Back-up in case the live connection is blocked or drops: re-read when
    // the tab comes back and every 5 minutes.
    let last = Date.now();
    root.addEventListener("focus", () => { if (Date.now() - last > 60000) { last = Date.now(); load(); } });
    setInterval(() => { last = Date.now(); load(); }, 5 * 60 * 1000);
  }

  function live() {
    if (!sb.channel) return;
    let timer = null, joinedBefore = false;
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
    sb.channel("system-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "system_updates" }, soon)
      .subscribe((status) => {
        // Re-joined after a dropped connection: catch up on anything missed.
        if (status === "SUBSCRIBED") { if (joinedBefore) soon(); joinedBefore = true; }
      });
  }

  root.ORYX_UPDATES = { open: showPage, openDetails, reload: load, unreadCount: () => unreadOf(st.published, st.readIds).length };
  start();
})(typeof window !== "undefined" ? window : globalThis);
