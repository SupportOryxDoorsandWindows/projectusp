// Purchase price history (price-history.js): which lines count as purchases,
// the last price per item, and the change from one price to the next.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("price-history.js", "utf8"), context);
const { isPurchase, lastPurchaseByItem, compare, withPriceChanges, pctText } = context.window.ORYX_PRICES;

const tx = (o) => ({ type: "check_in", item_id: "A", supplier: "Freedom", unit: "pcs", original_currency: "AUD",
  original_unit_cost: 1, unit_cost_used: 2.41, created_at: "2026-10-01T08:00:00Z", ...o });

// 1. Only Check-in lines with a document price are purchases.
assert.equal(isPurchase(tx({})), true);
assert.equal(isPurchase(tx({ type: "check_out" })), false);
assert.equal(isPurchase(tx({ supplier: "Manual correction" })), false); // Adjust / stock count
assert.equal(isPurchase(tx({ original_unit_cost: null })), false); // fell back to the Master cost
assert.equal(isPurchase(tx({ original_unit_cost: 0 })), false);

// 2. Newest purchase per item, whatever the order; non-purchases ignored.
const last = lastPurchaseByItem([
  tx({ original_unit_cost: 1, created_at: "2026-09-01T00:00:00Z" }),
  tx({ original_unit_cost: 3, created_at: "2026-10-05T00:00:00Z", supplier: "Manual correction" }),
  tx({ original_unit_cost: 2, created_at: "2026-10-02T00:00:00Z" }),
  tx({ item_id: "B", original_unit_cost: 9 }),
]);
assert.equal(last.get("A").original_unit_cost, 2);
assert.equal(last.get("B").original_unit_cost, 9);
assert.equal(last.size, 2);

// 3. Same currency: the supplier's own price decides (AED 1 -> AED 2 = +100%).
let c = compare({ currency: "AED", unitCost: 2, aed: 2, unit: "pcs" }, tx({ original_currency: "AED", original_unit_cost: 1, unit_cost_used: 1 }));
assert.equal(c.basis, "supplier"); assert.equal(c.change, "up"); assert.equal(pctText(c), "+100%");
// A rate change alone is not a price change when the supplier price is the same.
c = compare({ currency: "AUD", unitCost: 1, aed: 2.5, unit: "pcs" }, tx({}));
assert.equal(c.change, "same"); assert.equal(pctText(c), "same");
c = compare({ currency: "AUD", unitCost: 0.8, aed: 1.9, unit: "pcs" }, tx({}));
assert.equal(c.change, "down"); assert.equal(pctText(c), "−20%");
// 4. Different currency: compared in AED, tiny moves count as the same.
c = compare({ currency: "USD", unitCost: 0.66, aed: 2.42, unit: "pcs" }, tx({}));
assert.equal(c.basis, "aed"); assert.equal(c.change, "same");
c = compare({ currency: "USD", unitCost: 0.9, aed: 3.3, unit: "pcs" }, tx({}));
assert.equal(c.basis, "aed"); assert.equal(c.change, "up"); assert.equal(pctText(c), "+37%");
// 5. Different units are never compared; a missing unit on either side is fine.
assert.equal(compare({ currency: "AUD", unitCost: 2, aed: 4, unit: "m" }, tx({ unit: "roll" })), null);
assert.equal(compare({ currency: "AUD", unitCost: 2, aed: 4, unit: "PCS" }, tx({})).change, "up");
assert.equal(compare({ currency: "AUD", unitCost: 2, aed: 4, unit: "" }, tx({})).change, "up");
// No price on the new line: nothing to compare.
assert.equal(compare({ currency: "AUD", unitCost: null, aed: null, unit: "pcs" }, tx({})), null);
// Small changes keep one decimal.
assert.equal(pctText({ change: "up", pct: 0.042 }), "+4.2%");

// 6. Item panel: newest first, each with its change from the one before.
const hist = withPriceChanges([
  tx({ id: 1, original_unit_cost: 1, created_at: "2026-08-01T00:00:00Z" }),
  tx({ id: 3, original_unit_cost: 2, created_at: "2026-10-01T00:00:00Z" }),
  tx({ id: 2, original_unit_cost: 1, created_at: "2026-09-01T00:00:00Z" }),
  tx({ id: 4, supplier: "Manual correction", created_at: "2026-10-10T00:00:00Z" }),
]);
assert.deepEqual(hist.map((h) => h.t.id), [3, 2, 1]);
assert.equal(pctText(hist[0].change), "+100%");
assert.equal(hist[1].change.change, "same");
assert.equal(hist[2].change, null);

console.log("price-history tests passed");
