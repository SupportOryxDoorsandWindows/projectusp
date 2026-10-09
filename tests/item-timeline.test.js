// Master Inventory item panel (item-timeline.js): how each transaction line
// reads, and "stock after" worked back from today's stock across pages.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {}, console };
vm.runInNewContext(fs.readFileSync("item-timeline.js", "utf8"), context);
const { describeTx, withStockAfter } = context.window.ORYX_ITEM;

// Real 190012 history (newest first), as stored in inventory_transactions.
const rows = [
  { type: "check_out", quantity: 1, job_number: "26334", client: "ADAM PEACOCK", source_document_name: "26334F-Adam OPT LIST Rev. 01.pdf", created_at: "2026-10-07T07:57:36Z" },
  { type: "check_out", quantity: 1, job_number: "26271", client: "HANNAG+H RAVEN", created_at: "2026-10-07T07:55:00Z" },
  { type: "check_out", quantity: 2, job_number: "26347", client: "ALESSANDRA", created_at: "2026-10-07T07:52:00Z" },
  { type: "check_out", quantity: 2, job_number: "26169", client: "EULA CASTRO", created_at: "2026-10-07T07:44:00Z" },
  { type: "check_out", quantity: 1, job_number: "26243", client: "MARIA", created_at: "2026-10-07T07:38:00Z" },
  { type: "check_out", quantity: 159, job_number: "Stock count: correcting quantity", client: "Manual correction", created_at: "2026-10-07T07:30:00Z", performed_by_name: "Lharyl" },
  { type: "check_in", quantity: 58, invoice_number: "correcting qty", supplier: "Manual correction", created_at: "2026-10-07T07:13:00Z", performed_by_name: "Lharyl" },
  { type: "check_in", quantity: 10, invoice_number: "00047457", supplier: "FREEDOM SCREENS OF AUSTRALIA PTY LTD", created_at: "2026-10-01T07:13:00Z", performed_by_name: "Paulo Averil" },
];

const out = describeTx(rows[0]);
assert.equal(out.kind, "out");
assert.equal(out.title, "Check-out");
assert.equal(out.delta, -1);
assert.equal(out.detail, "Order Number 26334 · Client ADAM PEACOCK · 26334F-Adam OPT LIST Rev. 01.pdf");
assert.equal(out.who, null); // before names were recorded

const count = describeTx(rows[5]);
assert.equal(count.kind, "count");
assert.equal(count.title, "Stock count");
assert.equal(count.delta, -159);
assert.equal(count.detail, "Reason: correcting quantity");
assert.equal(count.who, "Lharyl");

const byHand = describeTx(rows[6]);
assert.equal(byHand.kind, "in");
assert.equal(byHand.title, "Added by hand");
assert.equal(byHand.delta, 58);
assert.equal(byHand.detail, "Manual correction · Reason: correcting qty");

const takenOut = describeTx({ type: "check_out", quantity: 3, job_number: "damaged", client: "Manual correction" });
assert.equal(takenOut.title, "Taken out by hand");
assert.equal(takenOut.delta, -3);

const checkin = describeTx(rows[7]);
assert.equal(checkin.title, "Check-in");
assert.equal(checkin.detail, "Order Number 00047457 · FREEDOM SCREENS OF AUSTRALIA PTY LTD");

// One page of everything vs two pages of 6 + 2: same stock after on every row.
const all = withStockAfter(rows, 51).list.map((r) => r.stockAfter);
assert.deepEqual(all, [51, 52, 53, 55, 57, 58, 217, 159]);
const p1 = withStockAfter(rows.slice(0, 6), 51);
const p2 = withStockAfter(rows.slice(6), p1.next);
assert.deepEqual([...p1.list, ...p2.list].map((r) => r.stockAfter), all);
// The stock count row reads "set to a counted 58 (was 217)".
assert.equal(p1.list[5].stockAfter, 58);
assert.equal(p1.list[5].stockBefore, 217);
assert.equal(p2.next, 149); // stock before the oldest movement shown

// Fractional metres don't drift.
const m = withStockAfter([{ type: "check_out", quantity: 0.1 }, { type: "check_out", quantity: 0.2 }], 3147.23).list;
assert.deepEqual(m.map((r) => r.stockAfter), [3147.23, 3147.33]);

console.log("item timeline tests passed");
