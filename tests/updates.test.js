// What's New & Updates (updates.js): unread count, search + category filter,
// and the publishing form's checks. The screens and the database rules are
// tested separately (browser stand-in; tests/sql/system-updates.test.sql).
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("updates.js", "utf8"), context);
const { unreadOf, filterUpdates, validateForm, CATEGORIES } = context.window.ORYX_UPDATES_CORE;

// Sample updates -- TEST DATA, never published to the live system.
const list = [
  { id: "1", status: "published", category: "new_feature", title: "Kanban Stock View", summary: "Users can now view inventory items as Kanban cards and quickly identify items that are running low on stock." },
  { id: "2", status: "published", category: "improvement", title: "Improved Check-out Process", summary: "The client name is now required before confirming a stock allocation." },
  { id: "3", status: "published", category: "bug_fix", title: "Inventory Quantity Display", summary: "Fixed an issue that caused inventory quantities to display incorrectly after a stock adjustment." },
  { id: "4", status: "published", category: "important", title: "Scheduled System Maintenance", summary: "The inventory system will undergo scheduled maintenance.", details: "Please SAVE your work before the announced maintenance period." },
  { id: "5", status: "draft", category: "important", title: "Draft only", summary: "Not out yet." },
];

// Unread: published and not read by this person; drafts never count.
assert.deepEqual(unreadOf(list, new Set()).map((u) => u.id), ["1", "2", "3", "4"]);
assert.deepEqual(unreadOf(list, new Set(["2", "4"])).map((u) => u.id), ["1", "3"]);
assert.equal(unreadOf(list, new Set(["1", "2", "3", "4"])).length, 0);

// Category filter
assert.deepEqual(filterUpdates(list, { cat: "bug_fix" }).map((u) => u.id), ["3"]);
assert.deepEqual(filterUpdates(list, { cat: "all" }).map((u) => u.id), ["1", "2", "3", "4", "5"]);
for (const k of Object.keys(CATEGORIES)) assert.ok(filterUpdates(list, { cat: k }).every((u) => u.category === k), k);
// Search: title or description (short or full), any case, trimmed
assert.deepEqual(filterUpdates(list, { q: "  kanban " }).map((u) => u.id), ["1"]);
assert.deepEqual(filterUpdates(list, { q: "CLIENT NAME" }).map((u) => u.id), ["2"]);
assert.deepEqual(filterUpdates(list, { q: "save your work" }).map((u) => u.id), ["4"]);
assert.deepEqual(filterUpdates(list, { q: "stock", cat: "improvement" }).map((u) => u.id), ["2"]);
assert.deepEqual(filterUpdates(list, { q: "nothing like this" }), []);

// Form checks
const good = { title: " Kanban Stock View ", category: "new_feature", summary: "Rows turn yellow / red.", details: "", version: " " };
let v = validateForm(good, "draft");
assert.ok(v.ok, v.errors.join());
assert.deepEqual({ ...v.row }, { title: "Kanban Stock View", category: "new_feature", summary: "Rows turn yellow / red.", details: null, version: null });
// Publishing needs the "already live" tick (only announce real, released changes)
v = validateForm(good, "publish");
assert.ok(!v.ok && /already live/.test(v.errors.join()));
assert.ok(validateForm({ ...good, live: true }, "publish").ok);
// Required fields and limits
assert.equal(validateForm({ ...good, title: "  " }, "draft").ok, false);
assert.equal(validateForm({ ...good, category: "" }, "draft").ok, false);
assert.equal(validateForm({ ...good, category: "random" }, "draft").ok, false);
assert.equal(validateForm({ ...good, summary: "" }, "draft").ok, false);
assert.equal(validateForm({ ...good, title: "x".repeat(151) }, "draft").ok, false);
assert.equal(validateForm({ ...good, summary: "x".repeat(501) }, "draft").ok, false);
assert.equal(validateForm({ ...good, version: "x".repeat(41) }, "draft").ok, false);

console.log("updates tests passed");
