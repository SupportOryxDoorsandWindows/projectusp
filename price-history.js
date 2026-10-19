/* Purchase price history: what an item was bought at before.
 *
 * The price paid is kept on each inventory_transactions line
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

  // ---- Export (price-export.js): the same rules, laid out as a report ----

  // The day a purchase was bought: the document date, else the day it was
  // checked in. "YYYY-MM-DD".
  function purchaseDay(t) {
    if (t.document_date) return String(t.document_date).slice(0, 10);
    const d = new Date(t.created_at);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Every purchase with its change from the purchase before it of the SAME
  // item. The change is worked out over the item's whole history BEFORE the
  // filters, so the first purchase inside a date range still compares with
  // the one before the range. filters: { from, to ("YYYY-MM-DD", inclusive),
  // supplier (exact), itemId }. Newest first.
  function purchaseReport(txs, filters) {
    const f = filters || {};
    const byItem = new Map();
    for (const t of txs || []) {
      if (!isPurchase(t)) continue;
      if (!byItem.has(t.item_id)) byItem.set(t.item_id, []);
      byItem.get(t.item_id).push(t);
    }
    const out = [];
    for (const [itemId, list] of byItem) {
      if (f.itemId && itemId !== f.itemId) continue;
      const changes = withPriceChanges(list);
      changes.forEach((row, i) => {
        const day = purchaseDay(row.t);
        if (f.from && day < f.from) return;
        if (f.to && day > f.to) return;
        if (f.supplier && row.t.supplier !== f.supplier) return;
        out.push({ t: row.t, change: row.change, day, previous: changes[i + 1] ? changes[i + 1].t : null });
      });
    }
    return out.sort((a, b) => (b.day.localeCompare(a.day)) || (time(b.t) - time(a.t)) ||
      String(a.t.item_code || "").localeCompare(String(b.t.item_code || "")));
  }

  // One line per item from purchaseReport rows: the latest purchase in the
  // rows, the one before it (from the whole history), the change between
  // them, lowest / highest AED in the rows, and how many purchases.
  function latestPerItem(rows) {
    const map = new Map();
    for (const r of rows || []) {
      let g = map.get(r.t.item_id);
      if (!g) { g = { itemId: r.t.item_id, last: r, count: 0, low: Infinity, high: -Infinity }; map.set(r.t.item_id, g); }
      g.count++;
      const v = Number(r.t.unit_cost_used);
      if (v < g.low) g.low = v;
      if (v > g.high) g.high = v;
      if (r.day > g.last.day || (r.day === g.last.day && time(r.t) > time(g.last.t))) g.last = r;
    }
    return [...map.values()].map((g) => ({ itemId: g.itemId, last: g.last.t, day: g.last.day,
      previous: g.last.previous, change: g.last.change, count: g.count, low: g.low, high: g.high }));
  }

  window.ORYX_PRICES = { isPurchase, lastPurchaseByItem, compare, withPriceChanges, pctText, AED_TOLERANCE,
    purchaseDay, purchaseReport, latestPerItem };
})();
