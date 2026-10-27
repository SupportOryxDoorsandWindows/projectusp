// Check-out bars without a usable item code (2026-10-27). They used to be
// dropped without a word (Smartscreen bars, Box Sections) or half-counted
// ("310010/310013" took off only 310013). Stock team's answers: Smartscreen
// bars map to their SMB1 items ("Pair" = bars as printed), Housing 70 IS/OS
// is half IS + half OS, Box Section 15x30 / 20x40 come off stock. Anything
// else without a code is an unmatched row to Edit or Acknowledge.
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
  "Serie: SMB Code: SMB_60-IS Bars: 4 x 5100", "Description: Freedom SMB Housing - 60 (IS)", "Total length: 20.4 m",
  "Serie: SMB Code: SMB_60-OS Bars: 4 x 5100", "Description: Freedom SMB Housing - 60 (OS)", "Total length: 20.4 m",
  "Serie: SMB Code: SMB_DRAWBAR Bars: 3 x 5500", "Description: Freedom SMB Drawbar", "Total length: 16.5 m",
  "Serie: SMB Code: SMB_TRACK_FIXE Bars: 2 x 5100", "Description: Freedom SMB Track Fixed - Pair", "Total length: 10.2 m",
  "Serie: SMB Code: SMB_TRACK_RET Bars: 2 x 5100", "Description: Freedom SMB Retainer - Pair", "Total length: 10.2 m",
  "Serie: SMB Code: SMB_ROLLER_TUB Bars: 3 x 5800", "Description: Freedom SMB Roller Tube", "Total length: 17.4 m",
  "Serie: X Code: 20X40 Bars: 1 x 6000", "Description: Box Section 20x40", "Total length: 6 m",
  "Serie: X Code: 15X30 Bars: 5 x 6000", "Description: Box Section 15x30", "Total length: 30 m",
  "Serie: X Code: 20X20 Bars: 1 x 6000", "Description: Box Section 20x20", "Total length: 6 m",
  "Serie: X Code: 70 Bars: 2 x 2900", "Description: 310010/310013-ZLS1 Housing 70 IS/OS 01 MILL", "Total length: 5.8 m",
  "Serie: X Code: DRAWBAR Bars: 2 x 2900", "Description: 310022-ZLS1 Drawbar MILL", "Total length: 5.8 m",
].join("\n");
const entries = parsePdf(jobList);
assert.deepEqual(plain(entries.map((e) => [e.code, e.bars, e.barLenMm, !!e.needsCheck])), [
  ["210025", 4, 5100, false], ["210022", 4, 5100, false], ["210016", 3, 5500, false],
  ["210010", 2, 5100, false], ["210007", 2, 5100, false],
  ["", 3, 5800, true], // Smartscreen roller tube: no answer for it, so staff decide
  ["10002-20x40", 1, 6000, false], ["10002-15x30", 5, 6000, false],
  ["", 1, 6000, true], // 20x20: not one of the sizes taken off stock
  ["310010", 1, 2900, false], ["310013", 1, 2900, false], // 2 bars = 1 IS + 1 OS
  ["310022", 2, 2900, false],
]);

const item = (id, code, len, qty) => ({ id, item_code: code, description: code + " item", bar_length_mm: len, unit_cost: 10, current_qty: qty });
const byCode = new Map([
  ["210025", [item("smb-is", "210025", 5100, 52)]], ["210022", [item("smb-os", "210022", 5100, 56)]],
  ["210016", [item("smb-db", "210016", 5100, 56)]], ["210010", [item("smb-tf", "210010", 5100, 103)]],
  ["210007", [item("smb-rt", "210007", 5100, 78)]],
  ["10002-20x40", [item("box2040", "10002-20x40", null, 10)]], // 15x30 not in Master yet
  ["310010", [item("is", "310010", 2900, 30)]], ["310013", [item("os", "310013", 2900, 30)]],
  ["310022", [item("db", "310022", 2900, 20)]],
]);
const rows = buildRows(entries, byCode);
assert.deepEqual(plain(rows.map((r) => [r.code, r.status, r.itemId, r.requiredQty])), [
  ["210025", "ok", "smb-is", 4], ["210022", "ok", "smb-os", 4], ["210016", "ok", "smb-db", 3],
  ["210010", "ok", "smb-tf", 2], ["210007", "ok", "smb-rt", 2],
  ["", "unmatched", null, 3],
  ["10002-20x40", "ok", "box2040", 1], ["10002-15x30", "unmatched", null, 5],
  ["", "unmatched", null, 1],
  ["310010", "ok", "is", 1], ["310013", "ok", "os", 1],
  ["310022", "ok", "db", 2],
]);
assert.ok(/From "Freedom SMB Housing - 60 \(IS\)"/.test(rows[0].sourceNote));
assert.ok(/half each/.test(rows[9].sourceNote));
assert.ok(/15x30 Box Section isn't in Master Inventory yet/.test(rows[7].checkNote), "a missing Box Section item says so");
assert.ok(/No item code/.test(rows[5].checkNote));

// An odd count can't be split: both halves become rows to check, nothing taken off.
const odd = buildRows(parsePdf(["Bars Optimization Report (1 of 1)", "Serie: X Code: 70 Bars: 1 x 5100",
  "Description: 310010/310013-ZLS1 Housing 70 IS/OS 01 MILL", "Total length: 5.1 m"].join("\n")), byCode);
assert.deepEqual(plain(odd.map((r) => [r.code, r.status, r.action, r.requiredQty])), [["310010", "unmatched", "pending", 1], ["310013", "unmatched", "pending", 1]]);
assert.ok(/can't be split evenly/.test(odd[0].checkNote));

// Edit picks the item for a row to check: it becomes a normal match and its note goes.
state.itemsByCode = new Map([...byCode, ["110001", [item("tube", "110001", 5100, 81)]]]);
const edited = rows[5];
recomputeAfterEdit(edited, "110001", "110001 item", 3, "bars", "tube");
assert.equal(edited.itemId, "tube");
assert.equal(edited.status, "ok");
assert.equal(edited.checkNote, null);

// A job list where every bar has a plain code reads exactly as before.
const normal = parsePdf(["Bars Optimization Report (1 of 1)", "Serie: X Code: DRAWBAR Bars: 3 x 2500", "Description: 310022-ZLS1 Drawbar MILL", "Total length: 7.5 m"].join("\n"));
assert.deepEqual(plain(normal), [{ kind: "bar", code: "310022", description: "310022-ZLS1 Drawbar MILL", bars: 3, barLenMm: 2500, totalLenM: 7.5 }]);

console.log("checkout-bars tests passed");
