// Check-out bars without a usable item code (2026-10-27): they used to be
// dropped without a word (Smartscreen bars, Box Sections) or half-counted
// ("310010/310013" took off only 310013). Now each shows as an unmatched row
// to Edit or Acknowledge; nothing extra is deducted by itself.
const assert = require("assert");
const fs = require("fs");
const { loadFp } = require("./load-fp");

const fakeEl = {
  addEventListener() {},
  classList: { add() {}, remove() {} },
  style: {},
  hidden: false,
  disabled: false,
  value: "",
  innerHTML: "",
  textContent: "",
  querySelectorAll() { return []; },
  appendChild() {},
};

const context = {
  console,
  window: {
    ORYX_CONFIG: { supabaseUrl: "https://example.supabase.co", supabaseKey: "key" },
    supabase: {
      createClient() {
        return {
          from() {
            return { select() { return this; }, order() { return this; }, limit() { return this; } };
          },
        };
      },
    },
  },
  document: { querySelector() { return fakeEl; }, createElement() { return fakeEl; }, head: fakeEl },
  setTimeout,
  clearTimeout,
  crypto: { subtle: {} },
};
const { parsePdf, buildRows, recomputeAfterEdit, state } = loadFp(context);
const plain = (v) => JSON.parse(JSON.stringify(v));

const jobList = [
  "Bars Optimization Report (1 of 1)",
  "Serie: FLYSCREEN Code: SMB_60-IS Bars: 4 x 5100",
  "Description: Freedom SMB Housing - 60 (IS)",
  "Total length: 20.4 m",
  "Serie: FLYSCREEN Code: 20X40 Bars: 1 x 6000",
  "Description: Box Section 20x40",
  "Total length: 6 m",
  "Serie: FLYSCREEN Code: 70 Bars: 2 x 2900",
  "Description: 310010/310013-ZLS1 Housing 70 IS/OS 01 MILL",
  "Total length: 5.8 m",
  "Serie: FLYSCREEN Code: DRAWBAR Bars: 2 x 2900",
  "Description: 310022-ZLS1 Drawbar MILL",
  "Total length: 5.8 m",
].join("\n");
const entries = parsePdf(jobList);
assert.deepEqual(plain(entries.map((e) => [e.code, e.description, e.bars, e.barLenMm, !!e.needsCheck])), [
  ["", "Freedom SMB Housing - 60 (IS)", 4, 5100, true],
  ["", "Box Section 20x40", 1, 6000, true],
  ["310013", "310010/310013-ZLS1 Housing 70 IS/OS 01 MILL", 2, 2900, false],
  ["310010", "310010/310013-ZLS1 Housing 70 IS/OS 01 MILL", 2, 2900, true],
  ["310022", "310022-ZLS1 Drawbar MILL", 2, 2900, false],
]);

const item = (id, code, len, qty) => ({ id, item_code: code, description: code + " item", bar_length_mm: len, unit_cost: 10, current_qty: qty });
const byCode = new Map([
  ["310013", [item("os", "310013", 2900, 20)]],
  ["310010", [item("is", "310010", 2900, 20)]], // exists, but is never matched from the combined line
  ["310022", [item("db", "310022", 2900, 20)]],
  ["210025", [item("smb", "210025", 5100, 20)]],
]);
const rows = buildRows(entries, byCode);
assert.deepEqual(plain(rows.map((r) => [r.code, r.status, r.action, r.itemId, r.requiredQty, r.unit])), [
  ["", "unmatched", "pending", null, 4, "bars"],
  ["", "unmatched", "pending", null, 1, "bars"],
  ["310013", "ok", "deduct", "os", 2, "bars"],
  ["310010", "unmatched", "pending", null, 2, "bars"],
  ["310022", "ok", "deduct", "db", 2, "bars"],
]);
assert.ok(rows[0].checkNote && /No item code/.test(rows[0].checkNote));
assert.ok(/310010 and 310013 together/.test(rows[3].checkNote));
// What Confirm deducts without anyone acting: exactly as before (310013 + 310022).
assert.deepEqual(plain(rows.filter((r) => r.action === "deduct" && r.itemId).map((r) => [r.itemId, r.requiredQty])), [["os", 2], ["db", 2]]);

// Edit picks the item: the row becomes a normal match and its note goes.
state.itemsByCode = byCode;
const edited = rows[0];
recomputeAfterEdit(edited, "210025", "210025 item", 4, "bars", "smb");
assert.equal(edited.itemId, "smb");
assert.equal(edited.status, "ok");
assert.equal(edited.checkNote, null);

// A job list where every bar has a plain code reads exactly as before.
const normal = parsePdf(["Bars Optimization Report (1 of 1)", "Serie: X Code: DRAWBAR Bars: 3 x 2500", "Description: 310022-ZLS1 Drawbar MILL", "Total length: 7.5 m"].join("\n"));
assert.deepEqual(plain(normal), [{ kind: "bar", code: "310022", description: "310022-ZLS1 Drawbar MILL", bars: 3, barLenMm: 2500, totalLenM: 7.5 }]);

console.log("checkout-bars tests passed");
