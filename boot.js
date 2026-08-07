/* Data loader.
 *
 * No sign-in: the app is open to anyone who opens the page. This file pulls the
 * knowledge base out of Supabase, assembles it into the shape app.js expects
 * (window.ORYX_KB), resolves the drawing URLs, and then loads the application.
 *
 * The key in config.js is read-only. No table has an insert, update or delete
 * policy, so nothing can be changed through it. */

(function () {
  const CFG = window.ORYX_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $ = (s) => document.querySelector(s);

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
    s.src = "app.js";
    s.onload = () => {
      $("#loading").hidden = true;
      $("#appShell").hidden = false;
    };
    s.onerror = () => fail("Could not load app.js.");
    document.body.appendChild(s);
  }

  function fail(msg) {
    $("#loadingMsg").textContent = "Could not load the product data.";
    $("#loadingDetail").textContent = msg;
    $("#loading").classList.add("err");
  }

  start();
})();
