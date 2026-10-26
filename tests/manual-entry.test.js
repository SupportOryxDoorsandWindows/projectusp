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

const { codePickerOptions, pickedInventoryRow, applyCombinedStock, rankPickerMatches, buildRows, recomputeAfterEdit, state } = loadFp(context);


const plain = (v) => JSON.parse(JSON.stringify(v));

function itemsMap(items) {
  const m = new Map();
  for (const it of items) {
    const arr = m.get(it.item_code) || [];
    arr.push(it);
    m.set(it.item_code, arr);
  }
  return m;
}

// A profile with one Master row per bar length (2500 / 2900 / 5100 mm under
// one code) -- the person must pick the exact length, never a guess.
const items = itemsMap([
  { id: "a2500", item_code: "310022", description: "ZLS1 Housing", bar_length_mm: 2500, unit_cost: 42, current_qty: 35 },
  { id: "a5100", item_code: "310022", description: "ZLS1 Housing", bar_length_mm: 5100, unit_cost: 180, current_qty: 96 },
  { id: "a2900", item_code: "310022", description: "ZLS1 Housing", bar_length_mm: 2900, unit_cost: 48, current_qty: 25 },
  { id: "m1", item_code: "ZM01", description: "Magnet", bar_length_mm: null, unit_cost: 2, current_qty: 10 },
]);

const opts = codePickerOptions(items);
const profile = opts.filter((o) => o.code === "310022");
assert.deepStrictEqual(plain(profile.map((o) => o.id)), ["a2500", "a2900", "a5100"], "one option per bar length, shortest first");
assert.deepStrictEqual(plain(profile.map((o) => o.label)), ["2500 mm", "2900 mm", "5100 mm"]);
const magnet = opts.filter((o) => o.code === "ZM01");
assert.strictEqual(magnet.length, 1);
assert.strictEqual(magnet[0].id, "m1");

assert.strictEqual(pickedInventoryRow(items, "310022", "a5100", { kind: "checkin" }).id, "a5100", "the picked length is used");
assert.strictEqual(pickedInventoryRow(items, "ZM01", "", { kind: "fitting" }).id, "m1", "no id falls back to the code");
assert.strictEqual(pickedInventoryRow(items, "NOPE", "", { kind: "fitting" }), null);

// Same item on two lines: 6 + 6 against 10 in stock is a shortage on both.
const row = (qty, action = "deduct") => ({
  itemId: "m1", available: 10, requiredQty: qty, remaining: 10 - qty,
  status: "ok", baseStatus: "ok", action, decided: true,
});
let rows = [row(6), row(6)];
applyCombinedStock(rows);
assert.deepStrictEqual(plain(rows.map((r) => [r.status, r.remaining])), [["shortage", -2], ["shortage", -2]]);

// Skipping one line takes it out of the total again.
rows[1].action = "skip";
applyCombinedStock(rows);
assert.deepStrictEqual(plain(rows.map((r) => [r.status, r.remaining])), [["ok", 4], ["ok", 4]]);

// Unmatched rows are left alone.
const unmatched = { itemId: null, available: null, requiredQty: 3, status: "unmatched", baseStatus: "unmatched", action: "pending" };
applyCombinedStock([unmatched]);
assert.strictEqual(unmatched.status, "unmatched");

// Picker ranking: codes starting with the query first, then codes
// containing it, then description matches.
const pickerOpts = [
  { code: "230001", searchText: "SMB1 End Cap 60 A MILL" },
  { code: "30001R", searchText: "Bug Fur 12mm (125m)" },
  { code: "30003R", searchText: "Bug Fur 16mm (300m Roll)" },
  { code: "910010", searchText: "Patio Mesh 3000 wide" },
  { code: "133001", searchText: "Cap Spindle" },
];
assert.deepStrictEqual(plain(rankPickerMatches(pickerOpts, "3000").map((o) => o.code)), ["30001R", "30003R", "230001", "910010"]);
assert.strictEqual(rankPickerMatches(pickerOpts, "").length, 5, "empty query lists everything");
assert.deepStrictEqual(plain(rankPickerMatches(pickerOpts, "spindle").map((o) => o.code)), ["133001"]);


// Check-out: 620001 (Mohair Holder, 5100 mm bars counted in pieces) comes
// from the job list in metres; it is taken off as whole bars, rounded up.
// So are 220002 / 220003 (SMB1 Zip Track / Track Inner).
{
  const stock = itemsMap([
    { id: "mh", item_code: "620001", description: "IZLX Drawbar Mohair Holder (STR)", unit_of_measure: "pcs", bar_length_mm: 5100, unit_cost: 54.96, current_qty: 262 },
    { id: "zt", item_code: "220002", description: "SMB1 Zip Track", unit_of_measure: "pcs", bar_length_mm: 5100, unit_cost: 10, current_qty: 30 },
  ]);
  const fit = (code, qty) => ({ kind: "fitting", code, qty, unit: "m", description: code });
  const [a, b, c, d] = buildRows([fit("620001", 2.63), fit("620001", 10.2), fit("620001", 10.21), fit("220002", 2.57)], stock);
  assert.strictEqual(a.requiredQty, 1, "2.63 m = 1 bar of 5.1 m");
  assert.strictEqual(a.unit, "bars");
  assert.strictEqual(a.pdfDetail, "2.63 m → 1 × 5100 mm");
  assert.strictEqual(a.remaining, 261);
  assert.strictEqual(b.requiredQty, 2, "exactly 2 bars' length is 2, not 3");
  assert.strictEqual(c.requiredQty, 3);
  assert.strictEqual(d.requiredQty, 1, "220002 Zip Track: 2.57 m = 1 bar");
  assert.strictEqual(d.unit, "bars");
}

// Check-out Edit: a "2 × 2900 mm" job line changed to the 5100 mm row shows
// what is taken now and that the person chose that row.
{
  const [row] = buildRows([{ kind: "bar", code: "310022", description: "Drawbar", bars: 2, barLenMm: 2900, totalLenM: 5.8 }], items);
  assert.strictEqual(row.itemId, "a2900");
  assert.strictEqual(row.pdfDetail, "2 × 2900 mm");
  state.itemsByCode = items;
  recomputeAfterEdit(row, "310022", "", 1, "bars", "a5100");
  assert.strictEqual(row.itemId, "a5100");
  assert.strictEqual(row.available, 96);
  assert.strictEqual(row.pdfDetail, "Job list: 2 × 2900 mm · Now: 1 × 5100 mm");
  assert.strictEqual(row.personPicked, true);
}

console.log("manual-entry tests passed");
