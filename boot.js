/* Sign-in gate and data loader.
 *
 * Nothing product-related ships in this repository. On a successful sign-in
 * this file pulls the knowledge base out of Supabase, assembles it into the
 * shape app.js expects (window.ORYX_KB), signs URLs for the drawings in the
 * private bucket, and only then loads the application. */

(function () {
  const CFG = window.ORYX_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $ = (s) => document.querySelector(s);

  /* ---------------------------------------------------------------- *
   * Turn the seven tables back into the single object app.js expects.
   * Kept pure and exposed as window.assembleKB so it can be tested
   * without signing in.
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
   * Load the knowledge base
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

    // One signed URL per drawing, requested in a single call.
    const paths = drawings.map((d) => d.storage_path);
    const urls = {};
    if (paths.length) {
      const { data, error } = await sb.storage
        .from(CFG.drawingsBucket)
        .createSignedUrls(paths, CFG.signedUrlSeconds);
      if (error) throw new Error("drawings: " + error.message);
      data.forEach((r) => {
        if (r.signedUrl) urls[r.path] = r.signedUrl;
      });
    }

    return assembleKB(
      { systems, configs, options, drawings, notes, glossary, meta }, urls);
  }

  /* ---------------------------------------------------------------- *
   * Start the app once, after the data is in place
   * ---------------------------------------------------------------- */
  let started = false;
  async function start() {
    if (started) return;
    started = true;
    setStatus("Loading product data…");
    try {
      window.ORYX_KB = await loadKB();
    } catch (e) {
      started = false;
      setStatus("Could not load the product data: " + e.message, true);
      return;
    }
    const s = document.createElement("script");
    s.src = "app.js";
    s.onload = () => {
      $("#gate").hidden = true;
      $("#appShell").hidden = false;
      const email = (window.ORYX_USER && window.ORYX_USER.email) || "";
      $("#whoami").textContent = email;
    };
    s.onerror = () => setStatus("Could not load app.js.", true);
    document.body.appendChild(s);
  }

  function setStatus(msg, isError) {
    const el = $("#gateStatus");
    el.textContent = msg || "";
    el.classList.toggle("err", !!isError);
  }

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */
  $("#gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#gateEmail").value.trim();
    const password = $("#gatePassword").value;
    if (!email || !password) return setStatus("Enter your email and password.", true);
    setStatus("Signing in…");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return setStatus(error.message, true);
    window.ORYX_USER = data.user;
    $("#gatePassword").value = "";
    start();
  });

  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "signOut") {
      sb.auth.signOut().then(() => location.reload());
    }
  });

  // Resume an existing session so a reload does not ask again.
  sb.auth.getSession().then(({ data }) => {
    if (data.session) {
      window.ORYX_USER = data.session.user;
      start();
    } else {
      $("#gate").hidden = false;
      $("#gateEmail").focus();
    }
  });
})();
