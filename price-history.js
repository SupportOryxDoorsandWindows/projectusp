/* Purchase price history: what an item was bought at before.
 *
 * A Check-in never changes an existing item's Master Inventory unit cost;
 * the price paid is kept on each inventory_transactions line instead
 * (unit_cost_used = AED per unit as stored, landed; original_unit_cost +
 * original_currency = the supplier's own price). This file reads those lines
 * back as a price history. Used by the Check-in preview ("last bought at")
 * and the item panel ("Purchase prices"). Pure helpers, no database calls;
 * tested in tests/price-history.test.js.
 *
 * A purchase is a check_in line with a document price: Adjust / stock-count
 * lines ("Manual correction") and lines that fell back to the Master cost
 * (no original_unit_cost) are never purchases.
 */
(function () {
  const MANUAL = "Manual correction";
  // AED comparisons (different currency from last time) move with the
  // exchange rate; a change smaller than this is shown as "about the same".
  const AED_TOLERANCE = 0.005;

  const pos = (v) => v != null && v !== "" && Number(v) > 0;

  function isPurchase(t) {
    return !!t && t.type === "check_in" && t.supplier !== MANUAL &&
      pos(t.original_unit_cost) && pos(t.unit_cost_used);
  }

  const time = (t) => new Date(t.created_at).getTime() || 0;

  // Newest purchase per item id. Input in any order.
  function lastPurchaseByItem(txs) {
    const out = new Map();
    for (const t of txs || []) {
      if (!isPurchase(t)) continue;
      const cur = out.get(t.item_id);
      if (!cur || time(t) > time(cur)) out.set(t.item_id, t);
    }
    return out;
  }

  const sameUnit = (a, b) => !a || !b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // before -> after on one basis. Supplier currency when both lines are in
  // the same currency (the supplier's own price, unaffected by rates or
  // shipping); otherwise AED as stored. null when not comparable.
  // now: { currency, unitCost (supplier price), aed (stored AED / unit), unit }
  function compare(now, last) {
    if (!now || !last || !sameUnit(now.unit, last.unit)) return null;
    let basis, before, after;
    if (now.currency && last.original_currency === now.currency && pos(now.unitCost) && pos(last.original_unit_cost)) {
      basis = "supplier"; before = Number(last.original_unit_cost); after = Number(now.unitCost);
    } else if (pos(now.aed) && pos(last.unit_cost_used)) {
      basis = "aed"; before = Number(last.unit_cost_used); after = Number(now.aed);
    } else return null;
    const pct = (after - before) / before;
    const same = basis === "supplier"
      ? Math.round(after * 10000) === Math.round(before * 10000)
      : Math.abs(pct) < AED_TOLERANCE;
    return { basis, currency: basis === "supplier" ? now.currency : "AED", before, after,
      pct: same ? 0 : pct, change: same ? "same" : pct > 0 ? "up" : "down" };
  }

  // The item's purchases, newest first, each with its change from the
  // purchase before it (null for the oldest, or when not comparable).
  function withPriceChanges(txs) {
    const list = (txs || []).filter(isPurchase).sort((a, b) => time(b) - time(a));
    return list.map((t, i) => {
      const prev = list[i + 1];
      const change = prev ? compare({ currency: t.original_currency, unitCost: t.original_unit_cost, aed: t.unit_cost_used, unit: t.unit }, prev) : null;
      return { t, change };
    });
  }

  // "+100%" / "−20%" / "same".
  function pctText(c) {
    if (!c || c.change === "same") return "same";
    const p = Math.abs(c.pct) * 100;
    const shown = p >= 10 ? Math.round(p) : Math.round(p * 10) / 10;
    return (c.pct > 0 ? "+" : "−") + shown + "%";
  }

  window.ORYX_PRICES = { isPurchase, lastPurchaseByItem, compare, withPriceChanges, pctText, AED_TOLERANCE };
})();
