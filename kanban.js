/* Kanban replenishment: the ONE rule for an item's stock status, used by the
 * Master Inventory rows (colour, badge, chips, Extract) and the item panel.
 *
 *  - Kanban trigger level = inventory_items.buffer_level (was "Minimum level").
 *  - Critical level       = inventory_items.critical_level (optional, below
 *                           the trigger; set_item_kanban_levels() enforces it).
 *
 *  no trigger set              -> "unset"    (default row, no Kanban warning)
 *  stock > trigger             -> "normal"   (default row)
 *  critical set, stock <= it   -> "critical" (light red row)
 *  otherwise stock <= trigger  -> "low"      (light yellow row)
 *
 * No critical level = never "critical" (we don't invent one). Stock is
 * always the stored current_qty -- nothing is worked out here.
 * Loaded before boot.js (index.html), so it is there for every other script.
 */
(function (root) {
  const level = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function kanbanState(item) {
    const trigger = level(item && item.buffer_level);
    if (trigger == null) return { trigger: null, critical: null, state: "unset" };
    const critical = level(item.critical_level);
    const qty = Number(item.current_qty) || 0;
    if (critical != null && qty <= critical) return { trigger, critical, state: "critical" };
    return { trigger, critical, state: qty <= trigger ? "low" : "normal" };
  }

  // What was typed in a level box: "" or 0 = none (people type 0 to mean
  // "none"), otherwise a number above 0.
  function parseLevel(text) {
    const t = String(text == null ? "" : text).trim().replace(/,/g, "");
    if (t === "") return { ok: true, level: null };
    const n = Number(t);
    if (n === 0) return { ok: true, level: null };
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Not saved — type a number above 0, or leave it empty." };
    if (n > 1e9) return { ok: false, error: "That number is too big." };
    return { ok: true, level: n };
  }

  // Both boxes together, checked the same way the server checks them.
  function parseLevels(triggerText, criticalText) {
    const t = parseLevel(triggerText);
    if (!t.ok) return { ok: false, error: t.error.replace("Not saved — ", "Not saved — trigger level: ") };
    const c = parseLevel(criticalText);
    if (!c.ok) return { ok: false, error: c.error.replace("Not saved — ", "Not saved — critical level: ") };
    if (c.level != null && t.level == null) return { ok: false, error: "Not saved — set the trigger level first, or leave the critical level empty." };
    if (c.level != null && c.level >= t.level) return { ok: false, error: "Not saved — the critical level must be below the trigger level." };
    return { ok: true, trigger: t.level, critical: c.level };
  }

  const BADGE = {
    critical: `<span class="badge no">Critical stock</span>`,
    low: `<span class="badge warn">Low stock</span>`,
  };

  root.ORYX_KANBAN = { kanbanState, parseLevel, parseLevels, BADGE };
})(typeof window !== "undefined" ? window : this);
