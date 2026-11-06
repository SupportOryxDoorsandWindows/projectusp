// Pure parts of allocations.js (window.ORYX_ALLOC_CORE). Run: node tests/allocations.test.js
const assert = require("assert");
require("../allocations.js");
const C = globalThis.ORYX_ALLOC_CORE;

assert.equal(C.jobKey("26052 F1-5"), "26052F15");

const allocs = [
  { id: 1, job_number: "26294", client: "Etihad", status: "open" },
  { id: 2, job_number: "J2", client: "", status: "open" },
  { id: 3, job_number: "OLD", client: "", status: "closed" },
];
const lines = [
  { id: 11, allocation_id: 1, inventory: "freedom", freedom_item_id: "f-a", qty_allocated: 30, qty_checked_out: 20, qty_released: 0, qty_open: 10, unit: "pcs" },
  { id: 12, allocation_id: 2, inventory: "freedom", freedom_item_id: "f-a", qty_allocated: 5, qty_checked_out: 0, qty_released: 0, qty_open: 5, unit: "pcs" },
  { id: 13, allocation_id: 1, inventory: "renson", renson_item_id: 7, qty_allocated: 4, qty_checked_out: 0, qty_released: 4, qty_open: 0, unit: "pc" },
  { id: 14, allocation_id: 3, inventory: "freedom", freedom_item_id: "f-b", qty_allocated: 9, qty_checked_out: 0, qty_released: 0, qty_open: 9, unit: "pcs" },
  { id: 15, allocation_id: 2, inventory: "renson", renson_item_id: 7, qty_allocated: 2, qty_checked_out: 0, qty_released: 0, qty_open: 2, unit: "pc" },
];
// Per item: open allocations only, nothing-open lines left out, per inventory
const f = C.allocatedByItem(allocs, lines, "freedom");
assert.deepEqual([...f.keys()], ["f-a"], "closed allocation (f-b) not counted");
assert.equal(f.get("f-a").qty, 15);
assert.deepEqual(f.get("f-a").jobs.map((j) => j.job), ["26294", "J2"]);
assert.deepEqual([...C.allocatedByItem(allocs, lines, "renson").entries()].map(([k, v]) => [k, v.qty]), [["7", 2]]);
assert.ok(/Job 26294 \(Etihad\) · 10 pcs/.test(C.allocTitle(f.get("f-a"))) && /Job J2 · 5 pcs/.test(C.allocTitle(f.get("f-a"))));

// One row per job; filters
const jobs = C.groupByJob(allocs, lines);
const j1 = jobs.find((g) => g.id === 1);
assert.deepEqual([j1.allocated, j1.out, j1.released, j1.open, j1.openLines, j1.lines.length], [34, 20, 4, 10, 1, 2]);
assert.equal(C.filterJobs(jobs, { status: "open" }).length, 2);
assert.equal(C.filterJobs(jobs, { status: "all" }).length, 3);
assert.deepEqual(C.filterJobs(jobs, { status: "open", inventory: "renson" }).map((g) => g.id), [1, 2]);
assert.deepEqual(C.filterJobs(jobs, { status: "all", search: "etihad" }).map((g) => g.shown.length), [2], "client match = all its lines");

// Allocate window: same item summed, capped at available, short shown
const cap = C.capLines([
  { inventory: "freedom", item_id: "f-a", code: "A", qty: 8 }, { inventory: "freedom", item_id: "f-a", code: "A", qty: 4 },
  { inventory: "freedom", item_id: "f-b", code: "B", qty: 3 }, { inventory: "renson", item_id: 7, code: "R", qty: 2 },
], new Map([["freedom:f-a", 10], ["freedom:f-b", -2], ["renson:7", 5]]));
assert.deepEqual(cap.map((l) => [l.code, l.need, l.available, l.take, l.short, l.on]),
  [["A", 12, 10, 10, 2, true], ["B", 3, 0, 0, 3, false], ["R", 2, 5, 2, 0, true]]);

console.log("allocations tests passed");
