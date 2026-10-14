// Kanban replenishment rule (kanban.js): row colour, badge, chips, Extract
// and the item panel all read kanbanState(), so these cases are the spec.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("kanban.js", "utf8"), context);
const { kanbanState, parseLevel, parseLevels } = context.window.ORYX_KANBAN;
const st = (qty, trigger, critical) => kanbanState({ current_qty: qty, buffer_level: trigger, critical_level: critical }).state;

// 1. Above the trigger = normal (default row).
assert.equal(st(26, 25, null), "normal");
assert.equal(st(26, 25, 5), "normal");
// 2. Equal to the trigger = low (yellow).
assert.equal(st(25, 25, null), "low");
// 3. Below the trigger = low unless at/below the critical level.
assert.equal(st(20, 25, null), "low");
assert.equal(st(6, 25, 5), "low");
// 4. At or below the critical level = critical (red).
assert.equal(st(5, 25, 5), "critical");
assert.equal(st(2, 25, 5), "critical");
assert.equal(st(0, 25, 5), "critical");
assert.equal(st(-3, 25, 5), "critical"); // negative stock is allowed
// 8. No critical level set: never critical, even at 0 or below zero.
assert.equal(st(0, 25, null), "low");
assert.equal(st(-3, 25, null), "low");
assert.equal(st(1, 25, ""), "low");
// No trigger: no Kanban state (a stray critical is ignored).
assert.equal(st(0, null, null), "unset");
assert.equal(st(0, null, 5), "unset");
assert.equal(st(0, "", null), "unset");
// 5./6. Recomputed from the stored numbers every time: stock or levels change -> state changes.
assert.equal(st(30, 25, 5), "normal");
assert.equal(st(30, 40, 5), "low");
assert.equal(st(30, 40, 30), "critical");
// Numbers stored as text (PostgREST numeric) work the same.
assert.deepEqual({ ...kanbanState({ current_qty: "4", buffer_level: "25", critical_level: "5" }) }, { trigger: 25, critical: 5, state: "critical" });
// Decimal stock (metres).
assert.equal(st(30.5, 30.5, null), "low");
assert.equal(st(30.51, 30.5, null), "normal");

// Typed levels: empty or 0 = none; numbers above 0 only.
assert.deepEqual({ ...parseLevel("") }, { ok: true, level: null });
assert.deepEqual({ ...parseLevel("0") }, { ok: true, level: null });
assert.equal(parseLevel("1,200").level, 1200);
for (const bad of ["-5", "abc", "10 pcs", "1e12"]) assert.equal(parseLevel(bad).ok, false, bad);
// Both together: critical needs a trigger and must be below it.
assert.deepEqual({ ...parseLevels("25", "5") }, { ok: true, trigger: 25, critical: 5 });
assert.deepEqual({ ...parseLevels("25", "") }, { ok: true, trigger: 25, critical: null });
assert.deepEqual({ ...parseLevels("", "") }, { ok: true, trigger: null, critical: null });
assert.equal(parseLevels("", "5").ok, false);
assert.equal(parseLevels("25", "25").ok, false);
assert.equal(parseLevels("25", "30").ok, false);
assert.match(parseLevels("abc", "").error, /trigger level/);
assert.match(parseLevels("25", "x").error, /critical level/);

console.log("kanban tests passed");
