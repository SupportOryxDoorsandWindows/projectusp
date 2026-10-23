// Dashboard figures (dashboard.js summarise): stock counts and Adjust
// ("Manual correction") are never usage or deliveries; "Running out soon"
// spreads usage over min(60 days, time since the first movement).
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("kanban.js", "utf8"), context);
vm.runInNewContext(fs.readFileSync("dashboard.js", "utf8"), context);
const { summarise, productLine, itemLabel } = context.window.ORYX_DASH_CORE;
const { kanbanState } = context.window.ORYX_KANBAN;

const now = "2026-10-23T08:00:00Z";
const ago = (d) => new Date(new Date(now).getTime() - d * 86400000).toISOString();
const items = [
  { id: "a", item_code: "30001R", description: "Bug Fur 12mm", current_qty: 10, unit_cost: 5, current_value: 50, unit_of_measure: "m", buffer_level: 20, critical_level: 5 },
  { id: "b", item_code: "310028", description: "ZLS1 Track 01 MILL", bar_length_mm: 2900, current_qty: 0, unit_cost: 10, current_value: 0, unit_of_measure: "pcs" },
  { id: "c", item_code: "230031", description: "SMB1 Slide Bolt BLK", current_qty: 100, unit_cost: 0, current_value: 0, unit_of_measure: "pcs", buffer_level: 10 },
  { id: "d", item_code: "10003-25", description: "25mm Flat Trim", current_qty: 0, unit_cost: 3, current_value: 0, unit_of_measure: "pcs" },
  { id: "e", item_code: "490001", description: "ZLS2 Gearbox ASSEM", current_qty: 4, unit_cost: 100, current_value: 400, unit_of_measure: "pcs", buffer_level: 6, critical_level: 2 },
];
const txs = [
  // real usage
  { type: "check_out", item_id: "a", quantity: 6, value: 30, job_number: "J1", client: "X", created_at: ago(10) },
  { type: "check_out", item_id: "a", quantity: 4, value: 20, job_number: "J2", client: "Y", created_at: ago(40) },
  { type: "check_out", item_id: "b", quantity: 8, value: 80, job_number: "J1", client: "X", created_at: ago(10) },
  { type: "check_out", item_id: "e", quantity: 1, value: 100, job_number: "J1", client: "X", created_at: ago(10) },
  // stock count / Adjust: ignored
  { type: "check_out", item_id: "c", quantity: 50, value: 0, client: "Manual correction", created_at: ago(2) },
  { type: "check_in", item_id: "a", quantity: 3, value: 15, supplier: "Manual correction", created_at: ago(2) },
  // a real delivery
  { type: "check_in", item_id: "e", quantity: 2, value: 200, supplier: "Freedom", invoice_number: "INV1", created_at: ago(5) },
];
const s = summarise({ items, txs, firstTxAt: ago(35), photos: new Set(["30001R", "310028", "230031"]), now, kanbanState });

assert.equal(s.stockValue, 450);
assert.equal(s.itemCount, 5);
assert.equal(s.outCount, 2);
assert.equal(s.outUsed, 1); // only the ZLS1 Track was used
assert.equal(s.useDays, 35); // tracking started 35 days ago (< 60)
// Last 30 days: J1 (3 lines); the 40-day-old line and Manual correction left out.
assert.deepEqual({ ...s.checkedOut }, { value: 210, jobs: 1, lines: 3 });
assert.deepEqual({ ...s.checkedIn }, { value: 200, deliveries: 1, lines: 1 });

const titles = s.attention.map((a) => a.title);
// a (10 <= trigger 20, above critical 5) and e (4 <= 6, above 2) are low.
assert.deepEqual(titles, ["Reorder: ZLS1 Track 01 MILL · 2.9 m", "2 items are low on stock",
  "1 other item is out of stock", "1 item in stock has no cost", "2 item codes have no photo"]);
assert.equal(s.attention[0].text, "0 left · 8 pcs used in the last 35 days");
assert.ok(!titles.includes("Low-stock warnings are off")); // trigger levels exist

// Product lines by the description's first word.
assert.equal(productLine({ description: "ZLS1 Housing" }), "Flyscreen (ZLS1)");
assert.equal(productLine({ description: "ZLS2 Gearbox" }), "Flyscreen (ZLS2)");
assert.equal(productLine({ description: "SMB Slide" }), "Smartscreen (SMB1)");
assert.equal(productLine({ description: "IZLX-Track" }), "ZLX / IZLX");
assert.equal(productLine({ description: "Bug Fur 12mm" }), "Other & shared parts");
assert.equal(s.families[0].name, "Flyscreen (ZLS2)");
assert.equal(Math.round(s.families[0].share * 100), 89);
assert.equal(itemLabel({ description: "X", bar_length_mm: 5100 }), "X · 5.1 m");

// Most used: by number of jobs, then quantity.
assert.deepEqual(s.mostUsed.map((u) => [u.item.id, u.qty, u.jobs]), [["b", 8, 1], ["a", 6, 1], ["e", 1, 1]]);

// Running out soon: the 40-day-old line is before tracking started (35 days),
// so a used 6 m in 35 days -> 1.2 m a week; 10 left -> 58 days.
// e used 1 in 35 days; 4 left -> 140 days. b is at 0 (under Needs attention).
assert.deepEqual(s.runningOut.map((r) => [r.item.id, r.daysLeft]), [["a", 58], ["e", 140]]);
assert.equal(Math.round(s.runningOut[0].perWeek * 100) / 100, 1.2);

// No trigger levels at all -> "Low-stock warnings are off".
const bare = summarise({ items: items.map((it) => ({ ...it, buffer_level: null, critical_level: null })), txs: [], now, kanbanState });
assert.ok(bare.attention.some((a) => a.title === "Low-stock warnings are off"));
assert.equal(bare.useDays, 60);
assert.equal(bare.runningOut.length, 0);

console.log("dashboard tests passed");
