/* User Management (Admin only).
 *
 * Lists staff accounts, turns Allow Delete / Admin / Active on and off,
 * creates invite links, and shows the delete log. The tab is only shown to
 * Admins, but that is convenience, not security: every change goes through
 * the user-admin Edge Function, which checks the caller is an active Admin,
 * and the database refuses an Admin removing their own Admin access or the
 * last Admin. The lists come through row-level security (Admins only). */
(function () {
  const AUTH = window.ORYX_AUTH;
  if (!AUTH) return;
  const $ = (s) => document.querySelector(s);
  const FN_URL = window.ORYX_CONFIG.supabaseUrl + "/functions/v1/user-admin";
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ERRORS = {
    last_admin: "This is the only Admin. Make someone else an Admin first.",
    cannot_remove_own_admin: "You can't remove your own Admin access or turn off your own account. Another Admin has to do that.",
    cannot_remove_self: "You can't remove your own account. Another Admin has to do that.",
    not_admin: "Only an Admin can do this.",
    sign_in_required: "Your sign-in has expired. Sign in again.",
    invalid_email: "That email address doesn't look right.",
  };
  let users = [];

  function status(msg, isError) {
    const el = $("#umStatus");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isError);
  }

  async function call(body) {
    const res = await fetch(FN_URL, { method: "POST", headers: await AUTH.fnHeaders(), body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: "HTTP " + res.status }; }
    if (!data.ok) throw new Error(ERRORS[data.error] || data.detail || data.error || "The change was not saved.");
    return data;
  }

  function showLink(kind, token, who) {
    const url = `${location.origin}${location.pathname}?${kind === "reset" ? "reset" : "invite"}=${encodeURIComponent(token)}`;
    $("#umLink").value = url;
    $("#umLinkBox").hidden = false;
    status(`Send this link to ${who}. Don't open it yourself — it's for their account. It works once, for about an hour; when they open it they set their own password.`);
    $("#umLink").focus(); $("#umLink").select();
  }

  let lastActive = new Map();
  function lastActiveText(id) {
    const iso = lastActive.get(id);
    if (!iso) return `<span class="muted">Never signed in</span>`;
    return esc(window.ORYX_ITEM ? window.ORYX_ITEM.when(iso).long : new Date(iso).toLocaleString("en-GB"));
  }

  function render() {
    const me = AUTH.user && AUTH.user.id;
    $("#umRows").innerHTML = users.length ? users.map((u) => {
      const self = u.user_id === me;
      const isAdmin = u.role === "admin";
      const name = u.full_name || u.email;
      return `<tr data-id="${esc(u.user_id)}">
        <td><div class="um-person"><span class="avatar ${self ? "me" : ""}" aria-hidden="true">${esc(AUTH.initials(name))}</span>
          <div><div class="um-name">${esc(u.full_name || "—")}${self ? " (you)" : ""}</div><div class="um-email">${esc(u.email)}</div></div></div></td>
        <td>${self ? `<span class="badge dark" title="You can't remove your own Admin access">Admin</span>`
          : `<select class="um-pick ${isAdmin ? "admin" : ""}" data-set="role" aria-label="Role for ${esc(name)}"><option value="user" ${isAdmin ? "" : "selected"}>User</option><option value="admin" ${isAdmin ? "selected" : ""}>Admin</option></select>`}</td>
        <td>${isAdmin
          ? `<label class="um-toggle" title="Admins can always delete"><input type="checkbox" checked disabled> Always</label>`
          : `<label class="um-toggle"><input type="checkbox" data-set="can_delete" ${u.can_delete ? "checked" : ""} aria-label="Allow Delete for ${esc(name)}"> ${u.can_delete ? "On" : "Off"}</label>`}</td>
        <td class="um-last">${lastActiveText(u.user_id)}</td>
        <td>${self ? `<span class="badge ok">Active</span>`
          : `<select class="um-pick status ${u.active ? "" : "off"}" data-set="active" aria-label="Status for ${esc(name)}"><option value="true" ${u.active ? "selected" : ""}>Active</option><option value="false" ${u.active ? "" : "selected"}>Turned off</option></select>`}</td>
        <td class="um-actions"><button class="btn-outline btn-sm" type="button" data-link>New password link</button>${self ? "" : `<button class="btn-outline btn-sm um-remove" type="button" data-remove>Remove</button>`}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="muted">No accounts yet.</td></tr>`;

    $("#umRows").querySelectorAll("[data-set]").forEach((box) => {
      box.onchange = async () => {
        const id = box.closest("tr").dataset.id;
        const u = users.find((x) => x.user_id === id);
        const field = box.dataset.set;
        const on = box.type === "checkbox" ? box.checked : field === "role" ? box.value === "admin" : box.value === "true";
        const undo = () => { if (box.type === "checkbox") box.checked = !on; else box.value = field === "role" ? (on ? "user" : "admin") : String(!on); };
        const body = { action: "set_access", user_id: id };
        if (field === "can_delete") body.can_delete = on;
        if (field === "role") body.role = on ? "admin" : "user";
        if (field === "active") body.active = on;
        if (field === "role" && !on && !confirm(`Remove Admin access from ${u.full_name || u.email}?`)) { undo(); return; }
        if (field === "active" && !on && !confirm(`Turn off ${u.full_name || u.email}'s account? They will be signed out and can't sign in.`)) { undo(); return; }
        box.disabled = true;
        try {
          await call(body);
          const label = { can_delete: on ? "can now delete" : "can no longer delete",
                          role: on ? "is now an Admin" : "is no longer an Admin",
                          active: on ? "can sign in again" : "is turned off" }[field];
          status(`${u.full_name || u.email} ${label}.`);
          await load();
          await AUTH.refreshProfile();
        } catch (e) {
          undo();
          box.disabled = false;
          status(e.message, true);
        }
      };
    });
    $("#umRows").querySelectorAll("button[data-remove]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest("tr").dataset.id;
        const u = users.find((x) => x.user_id === id);
        const who = u.full_name || u.email;
        if (!confirm(`Remove ${who}?\n\nTheir account (${u.email}) is deleted and they can't sign in any more. ` +
          `Their name stays in the Delete log. You can invite the same email again later.`)) return;
        btn.disabled = true;
        try {
          await call({ action: "remove_user", user_id: id });
          $("#umLinkBox").hidden = true;
          status(`${who} was removed.`);
          await load();
        } catch (e) { status(e.message, true); btn.disabled = false; }
      };
    });
    $("#umRows").querySelectorAll("button[data-link]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest("tr").dataset.id;
        const u = users.find((x) => x.user_id === id);
        btn.disabled = true;
        try {
          const d = await call({ action: "reset_link", user_id: id });
          showLink(d.kind, d.token, u.full_name || u.email);
        } catch (e) { status(e.message, true); }
        btn.disabled = false;
      };
    });
  }

  // Delete log: collapsed by default; search, person, where and date filters,
  // 20 lines per page (filtered here, newest first).
  const LOG_PAGE = 20;
  let logRows = [], logPage = 0;
  const logWhen = (r) => new Date(r.happened_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const logWhat = (r) => {
    const d = r.record_detail || {};
    const what = [d.code, d.description].filter(Boolean).join(" — ") || r.record_ref || "—";
    return what + (d.qty != null ? ` (${d.qty}${d.unit ? " " + d.unit : ""})` : "");
  };
  const logWhere = (r) => {
    const d = r.record_detail || {};
    return (r.area === "checkin" ? "Check-in" : "Check-out") + (r.document_name ? ` · ${r.document_name}` : "") +
      (d.job_number ? ` · Order Number ${d.job_number}` : "") + (d.invoice_number ? ` · Order Number ${d.invoice_number}` : "");
  };
  const logWho = (r) => r.user_name || r.user_email;

  function filteredLog() {
    const q = $("#umLogSearch").value.trim().toLowerCase();
    const who = $("#umLogWho").value, area = $("#umLogArea").value;
    const from = $("#umLogFrom").value, to = $("#umLogTo").value;
    return logRows.filter((r) => {
      if (who && r.user_email !== who) return false;
      if (area && r.area !== area) return false;
      const day = new Date(r.happened_at).toLocaleDateString("en-CA"); // yyyy-mm-dd, local
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (q && ![logWhat(r), logWhere(r), r.reason || "", logWho(r)].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function drawLog() {
    const rows = filteredLog();
    const pages = Math.max(1, Math.ceil(rows.length / LOG_PAGE));
    logPage = Math.min(logPage, pages - 1);
    const shown = rows.slice(logPage * LOG_PAGE, (logPage + 1) * LOG_PAGE);
    $("#umLog").innerHTML = shown.length ? shown.map((r) => `<tr><td>${esc(logWhen(r))}</td><td>${esc(logWho(r))}</td>
        <td>${r.action === "restore" ? "<b>Restored</b> " : "<b>Deleted</b> "}${esc(logWhat(r))}</td><td>${esc(logWhere(r))}</td><td>${esc(r.reason || "")}</td></tr>`).join("")
      : `<tr><td colspan="5" class="muted">${logRows.length ? "Nothing matches these filters." : "Nothing deleted yet."}</td></tr>`;
    $("#umLogInfo").textContent = rows.length
      ? `Showing ${logPage * LOG_PAGE + 1}–${logPage * LOG_PAGE + shown.length} of ${rows.length}${rows.length !== logRows.length ? ` (filtered from ${logRows.length})` : ""}`
      : "";
    $("#umLogPage").textContent = `Page ${logPage + 1} of ${pages}`;
    $("#umLogPrev").disabled = logPage === 0;
    $("#umLogNext").disabled = logPage >= pages - 1;
  }

  const logCountText = () => {
    const el = $("#umLogCount");
    el.textContent = (el.dataset.n || "") + (!$("#umLogBox").open && logRows.length ? " · click to open" : "");
  };
  $("#umLogBox").addEventListener("toggle", logCountText);

  function renderLog(rows) {
    logRows = rows;
    $("#umLogCount").dataset.n = rows.length ? `${rows.length} ${rows.length === 1 ? "entry" : "entries"}` : "nothing yet";
    logCountText();
    const pick = $("#umLogWho"), keep = pick.value;
    const people = [...new Map(rows.map((r) => [r.user_email, logWho(r)])).entries()].sort((x, y) => x[1].localeCompare(y[1]));
    pick.innerHTML = `<option value="">Everyone</option>` + people.map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`).join("");
    if (people.some(([email]) => email === keep)) pick.value = keep;
    drawLog();
  }
  ["#umLogSearch", "#umLogWho", "#umLogArea", "#umLogFrom", "#umLogTo"].forEach((sel) =>
    $(sel).addEventListener("input", () => { logPage = 0; drawLog(); }));
  $("#umLogPrev").addEventListener("click", () => { logPage = Math.max(0, logPage - 1); drawLog(); });
  $("#umLogNext").addEventListener("click", () => { logPage += 1; drawLog(); });

  async function load() {
    if (!AUTH.isAdmin()) return;
    const [{ data: u, error: e1 }, { data: log, error: e2 }, { data: seen, error: e3 }] = await Promise.all([
      AUTH.sb.from("user_profiles").select("*").order("role").order("full_name"),
      AUTH.sb.from("delete_audit_log").select("*").order("happened_at", { ascending: false }).limit(5000),
      AUTH.sb.rpc("admin_user_last_active"),
    ]);
    if (e1) { status("Couldn't load the accounts: " + e1.message, true); return; }
    if (e3) console.error("last active", e3);
    lastActive = new Map((seen || []).map((r) => [r.user_id, r.last_sign_in_at]));
    users = u || [];
    render();
    renderLog(e2 ? [] : log || []);
  }

  $("#umInviteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#umName").value.trim(), email = $("#umEmail").value.trim();
    if (!name || !email) return;
    const btn = $("#umInviteBtn");
    btn.disabled = true;
    try {
      const d = await call({ action: "invite", email, full_name: name, can_delete: $("#umCanDelete").checked });
      $("#umInviteDialog").close();
      showLink(d.kind, d.token, name);
      if (d.existed) status(`${email} already has an account; this link lets them set a new password. Their permissions weren't changed.`);
      $("#umName").value = ""; $("#umEmail").value = ""; $("#umCanDelete").checked = false;
      await load();
    } catch (err) { status(err.message, true); $("#umInviteErr").textContent = err.message; }
    btn.disabled = false;
  });
  $("#umInviteOpen").addEventListener("click", () => { $("#umInviteErr").textContent = ""; $("#umInviteDialog").showModal(); $("#umName").focus(); });
  $("#umInviteCancel").addEventListener("click", () => $("#umInviteDialog").close());
  $("#umCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#umLink").value); $("#umCopy").textContent = "Copied"; }
    catch (e) { $("#umLink").select(); }
    setTimeout(() => { $("#umCopy").textContent = "Copy link"; }, 1500);
  });

  const nav = $("#navAdmin");
  if (nav) nav.addEventListener("click", load);
  document.addEventListener("oryx-permissions", () => { if (!AUTH.isAdmin() && $("#v-admin").classList.contains("on")) { const first = document.querySelector('nav button[data-v="ask"]'); if (first) first.click(); } });
})();
