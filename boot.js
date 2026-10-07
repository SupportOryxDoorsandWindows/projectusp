/* Staff sign-in, permissions, and data loader.
 *
 * Every staff member signs in (accounts are created by an Admin, who sends
 * them a one-time link to set their own password). Only after that, this file
 * pulls the knowledge base out of Supabase, assembles it into the shape app.js
 * expects (window.ORYX_KB), resolves the drawing URLs, and loads the app.
 *
 * window.ORYX_AUTH is the one place the rest of the app asks "who is this and
 * what may they do": the shared Supabase client (signed in), the person's
 * profile (role, can_delete), the headers for Edge Function calls, and
 * requestDelete() -- the confirmation dialog plus the SERVER-SIDE permission
 * check (record_line_delete) behind every Delete button. Hiding a button is
 * never the only protection: the database refuses a delete from anyone who
 * isn't an Admin or doesn't have Allow Delete. */

(function () {
  const CFG = window.ORYX_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $ = (s) => document.querySelector(s);

  /* ---------------------------------------------------------------- *
   * Who is signed in, and what they may do
   * ---------------------------------------------------------------- */
  const AUTH = {
    sb,
    user: null,
    profile: null,
    isAdmin() { return !!(this.profile && this.profile.active && this.profile.role === "admin"); },
    canDelete() { return !!(this.profile && this.profile.active && (this.profile.role === "admin" || this.profile.can_delete)); },
    // Headers for the Edge Functions: the person's own (fresh) sign-in token.
    async fnHeaders() {
      const { data } = await sb.auth.getSession();
      const token = data && data.session ? data.session.access_token : "";
      return { "Content-Type": "application/json", "Authorization": "Bearer " + token, "apikey": CFG.supabaseKey };
    },
    // Re-reads the profile (Admin changes apply at once); tells the app when
    // something changed so Delete buttons are redrawn.
    async refreshProfile() {
      if (!this.user) return null;
      const { data, error } = await sb.from("user_profiles").select("*").eq("user_id", this.user.id).maybeSingle();
      if (error) return this.profile;
      const before = JSON.stringify(this.profile);
      this.profile = data || null;
      if (JSON.stringify(this.profile) !== before) {
        document.dispatchEvent(new CustomEvent("oryx-permissions"));
        if (this.profile && !this.profile.active) { sb.auth.signOut().then(() => location.reload()); }
        const nav = $("#navAdmin"); if (nav) nav.hidden = !this.isAdmin();
      }
      return this.profile;
    },
    deleteDeniedMessage: "You don't have permission to delete this record. Please contact an administrator.",
    /* The Delete flow for one line. `what` = a short label, `area` =
     * "checkin" | "checkout", `ref`/`detail`/`documentName` go to the delete
     * log. Resolves true only when the person confirmed AND the server
     * allowed and logged it -- the caller removes the line only then. */
    async requestDelete({ what, area, ref, detail, documentName, note }) {
      // Current permission, not the one from page load (an Admin may have
      // just changed it). The server checks again when Delete is pressed.
      await AUTH.refreshProfile();
      return new Promise((resolve) => {
        const dlg = $("#delDialog");
        const go = $("#delGo"), cancel = $("#delCancel"), err = $("#delError"), reason = $("#delReason");
        const denied = () => {
          $("#delTitle").textContent = "Can't delete";
          $("#delText").textContent = AUTH.deleteDeniedMessage;
          $("#delWhat").textContent = what || "";
          $("#delReasonBox").hidden = true; go.hidden = true; cancel.textContent = "OK";
        };
        err.textContent = ""; reason.value = ""; go.disabled = false; go.hidden = false;
        $("#delReasonBox").hidden = false; cancel.textContent = "Cancel";
        $("#delTitle").textContent = "Delete Record?";
        $("#delText").textContent = "Are you sure you want to delete this record?" + (note ? " " + note : " This action cannot be undone.");
        $("#delWhat").textContent = what || "";
        if (!AUTH.canDelete()) denied();
        let done = false;
        const finish = (val) => { if (done) return; done = true; go.onclick = cancel.onclick = null; dlg.removeEventListener("close", onClose); if (dlg.open) dlg.close(); resolve(val); };
        const onClose = () => finish(false);
        dlg.addEventListener("close", onClose);
        cancel.onclick = () => finish(false);
        go.onclick = async () => {
          go.disabled = true; err.textContent = "";
          const { data, error } = await sb.rpc("record_line_delete", {
            p_area: area, p_record_ref: String(ref || what || "").slice(0, 300), p_detail: detail || {},
            p_document: documentName || null, p_reason: reason.value, p_action: "delete",
          });
          if (!error && data && data.ok) { finish(true); return; }
          const code = data && data.error;
          if (code === "no_delete_permission" || code === "no_account" || code === "not_signed_in") {
            await AUTH.refreshProfile();
            denied();
            return;
          }
          go.disabled = false;
          err.textContent = "Couldn't delete: " + ((error && error.message) || code || "no answer from the server") + ". Nothing was removed.";
        };
        dlg.showModal();
        (AUTH.canDelete() ? reason : cancel).focus();
      });
    },
    // Restoring a deleted line is open to everyone; it's only logged.
    logRestore({ area, ref, detail, documentName }) {
      sb.rpc("record_line_delete", { p_area: area, p_record_ref: String(ref || "").slice(0, 300), p_detail: detail || {},
        p_document: documentName || null, p_reason: null, p_action: "restore" }).then(() => {}, () => {});
    },
  };
  window.ORYX_AUTH = AUTH;

  /* ---------------------------------------------------------------- *
   * Turn the seven tables back into the single object app.js expects.
   * Kept pure and exposed as window.assembleKB so it can be tested
   * independently of the network.
   * ---------------------------------------------------------------- */
  function assembleKB(t, urls) {
    const byId = (rows) => {
      const m = {};
      (rows || []).forEach((r) => (m[r.system_id] = m[r.system_id] || []).push(r));
      return m;
    };
    const cfgBy = byId(t.configs), optBy = byId(t.options),
          drwBy = byId(t.drawings), noteBy = byId(t.notes);

    const kindMap = (rows, kind) => {
      const o = {};
      (rows || []).filter((r) => r.kind === kind)
        .forEach((r) => (o[r.label] = r.supported));
      return o;
    };

    const engineering = {};
    Object.entries(noteBy).forEach(([sysId, rows]) => {
      engineering[sysId] = {};
      rows.forEach((r) => (engineering[sysId][r.key] = r.value));
    });

    const meta = (t.meta && t.meta[0]) || {};
    return {
      source: meta.source || "Supabase",
      updated_at: meta.updated_at,
      systems: t.systems.map((s) => ({
        id: s.id, name: s.name, family: s.family,
        sash_w_min: s.sash_w_min, sash_w_max: s.sash_w_max,
        sash_h_min: s.sash_h_min, sash_h_max: s.sash_h_max,
        sash_sqm_max: s.sash_sqm_max,
        glass: s.glass, automation: s.automation, locking: s.locking,
        any_config: s.any_config, tracks: s.tracks || [],
        configs: (cfgBy[s.id] || []).map((c) => ({
          label: c.label, leaves: c.leaves, operable: c.operable, tracks: c.tracks,
        })),
        thresholds: kindMap(optBy[s.id], "threshold"),
        drainage: kindMap(optBy[s.id], "drainage"),
        sightlines: kindMap(optBy[s.id], "sightline"),
        drawings: (drwBy[s.id] || []).map((d) => ({
          kind: d.kind, label: d.label, cell: d.cell,
          file: d.storage_path, url: (urls && urls[d.storage_path]) || "",
        })),
      })),
      engineering,
      glossary: Object.fromEntries((t.glossary || []).map((g) => [g.term, g.meaning])),
    };
  }
  window.assembleKB = assembleKB;

  /* ---------------------------------------------------------------- *
   * Fetch
   * ---------------------------------------------------------------- */
  async function loadKB() {
    const get = async (table, order) => {
      const q = sb.from(table).select("*");
      const { data, error } = order ? await q.order(order) : await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      return data;
    };

    const [systems, configs, options, drawings, notes, glossary, meta] =
      await Promise.all([
        get("systems", "sort_order"),
        get("configurations", "sort_order"),
        get("system_options"),
        get("drawings", "sort_order"),
        get("engineering_notes", "sort_order"),
        get("glossary"),
        get("kb_meta"),
      ]);

    if (!systems.length) {
      throw new Error(
        "No systems came back. If the sign-in was removed recently, " +
        "open-read-access.sql still needs running in the Supabase SQL editor.");
    }

    // Public bucket, so these URLs are permanent and need no refreshing.
    const urls = {};
    drawings.forEach((d) => {
      urls[d.storage_path] = sb.storage
        .from(CFG.drawingsBucket)
        .getPublicUrl(d.storage_path).data.publicUrl;
    });

    return assembleKB(
      { systems, configs, options, drawings, notes, glossary, meta }, urls);
  }

  /* ---------------------------------------------------------------- *
   * Start
   * ---------------------------------------------------------------- */
  async function start() {
    try {
      window.ORYX_KB = await loadKB();
    } catch (e) {
      fail(e.message);
      return;
    }
    const s = document.createElement("script");
    // Cache-buster: GitHub Pages and browsers cache "app.js" aggressively, so a
    // plain filename can keep running old logic after a deploy. A per-load query
    // string forces the current version every time. app.js is small, so the
    // cost is negligible and correctness is guaranteed.
    s.src = "app.js?v=" + Date.now();
    s.onload = () => {
      $("#loading").hidden = true;
      $("#appShell").hidden = false;
      // fp-pro.js runs the FP Pro Optimization tab. Loaded after app.js
      // so it can hook into the main event loop; cache-busted the same way
      // as app.js so a redeploy takes effect on the next page load.
      const f = document.createElement("script");
      f.src = "fp-pro.js?v=" + Date.now();
      document.body.appendChild(f);
      // User Management (Admins only -- the server checks again).
      const a = document.createElement("script");
      a.src = "admin.js?v=" + Date.now();
      document.body.appendChild(a);
    };
    s.onerror = () => fail("Could not load app.js.");
    document.body.appendChild(s);
  }

  function fail(msg) {
    $("#loadingMsg").textContent = "Could not load the product data.";
    $("#loadingDetail").textContent = msg;
    $("#loading").classList.add("err");
  }

  /* ---------------------------------------------------------------- *
   * Sign-in
   * ---------------------------------------------------------------- */
  function gateStatus(msg, isError) {
    const el = $("#gateStatus");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isError);
  }
  function showGate(mode) {
    $("#loading").hidden = true;
    $("#appShell").hidden = true;
    $("#gate").hidden = false;
    $("#gateForm").hidden = mode !== "signin";
    $("#gateSetForm").hidden = mode !== "set";
    $("#gateSub").textContent = mode === "set" ? "Set your password" : "Oryx staff sign-in";
    if (mode === "signin") $("#gateEmail").focus();
    if (mode === "set") $("#gateNewPassword").focus();
  }

  // "Get help signing in": a new email to the Admin in config.js, with the
  // person's email (if typed) already in the message. Outlook on the web
  // (new tab) when outlookWeb is set, otherwise the computer's mail app.
  const contact = CFG.adminContact || {};
  if (contact.email) {
    const message = () => {
      const mine = ($("#gateEmail").value || $("#gateNewEmail").value || "").trim();
      return {
        subject: "Product Selector - sign-in help",
        body: `Hello${contact.name ? " " + contact.name : ""},\n\nI need help signing in to the Oryx Product Selector ` +
          `(new account / new password link).\n\nMy work email: ${mine || "(please write it here)"}\n\nThank you.`,
      };
    };
    const outlookUrl = () => {
      const m = message();
      return "https://outlook.office.com/mail/deeplink/compose?to=" + encodeURIComponent(contact.email) +
        "&subject=" + encodeURIComponent(m.subject) + "&body=" + encodeURIComponent(m.body);
    };
    const mailtoUrl = () => {
      const m = message();
      return `mailto:${contact.email}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
    };
    // The link's address is refreshed just before it's followed, so it
    // carries whatever email was typed.
    const btn = $("#gateContact");
    if (contact.outlookWeb) {
      const refresh = () => { btn.href = outlookUrl(); };
      ["mousedown", "focus", "touchstart"].forEach((ev) => btn.addEventListener(ev, refresh));
      btn.addEventListener("click", refresh);
      refresh();
    } else {
      btn.removeAttribute("target");
      btn.addEventListener("click", (e) => { e.preventDefault(); location.href = mailtoUrl(); });
    }
  } else {
    $("#gateFoot").hidden = true;
  }

  let started = false;
  async function enter(user) {
    AUTH.user = user;
    const profile = await AUTH.refreshProfile();
    if (!profile || !profile.active) {
      await sb.auth.signOut();
      AUTH.user = null; AUTH.profile = null;
      showGate("signin");
      gateStatus("This account doesn't have access to the system. Please contact an administrator.", true);
      return;
    }
    $("#whoami").textContent = (profile.full_name || profile.email) + (AUTH.isAdmin() ? " · Admin" : "");
    $("#navAdmin").hidden = !AUTH.isAdmin();
    $("#gate").hidden = true;
    $("#loading").hidden = false;
    if (started) return;
    started = true;
    // Admin changes apply straight away: re-read on return to the tab and
    // every minute (the server checks on every delete regardless).
    window.addEventListener("focus", () => AUTH.refreshProfile());
    setInterval(() => AUTH.refreshProfile(), 60000);
    start();
  }

  $("#gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#gateEmail").value.trim();
    const password = $("#gatePassword").value;
    if (!email || !password) return gateStatus("Enter your email and password.", true);
    gateStatus("Signing in…");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    $("#gatePassword").value = "";
    if (error) return gateStatus(/banned/i.test(error.message) ? "This account has been turned off. Please contact an administrator."
      : /invalid/i.test(error.message) ? "Wrong email or password." : error.message, true);
    gateStatus("");
    enter(data.user);
  });

  $("#gateSetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = $("#gateNewPassword").value, b = $("#gateNewPassword2").value;
    if (a.length < 8) return gateStatus("Use at least 8 characters.", true);
    if (a !== b) return gateStatus("The two passwords don't match.", true);
    gateStatus("Saving…");
    const { data, error } = await sb.auth.updateUser({ password: a });
    if (error) return gateStatus(error.message, true);
    $("#gateNewPassword").value = $("#gateNewPassword2").value = "";
    gateStatus("");
    enter(data.user);
  });

  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "signOut") sb.auth.signOut().then(() => location.reload());
  });

  (async () => {
    // An invite or reset link from an Admin: ?invite=<token> / ?reset=<token>.
    const params = new URLSearchParams(location.search);
    const linkToken = params.get("invite") || params.get("reset");
    if (linkToken) {
      history.replaceState(null, "", location.pathname + location.hash);
      await sb.auth.signOut().catch(() => {});
      showGate("set");
      gateStatus("Checking your link…");
      const { data, error } = await sb.auth.verifyOtp({ token_hash: linkToken, type: params.get("invite") ? "invite" : "recovery" });
      if (error || !data || !data.user) {
        showGate("signin");
        gateStatus("This link has expired or was already used. Ask an Admin for a new one.", true);
        return;
      }
      $("#gateNewEmail").value = data.user.email || "";
      gateStatus("");
      return;
    }
    // Resume an existing session so a reload doesn't ask again.
    const { data } = await sb.auth.getSession();
    if (data.session) enter(data.session.user);
    else showGate("signin");
  })();
})();
