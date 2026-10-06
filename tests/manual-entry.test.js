const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("fp-pro.js", "utf8").replace(
  /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
  `\nwindow.__manTest = { codePickerOptions, pickedInventoryRow, applyCombinedStock, rankPickerMatches };\n})();`
);

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

vm.runInNewContext(source, context);
const { codePickerOptions, pickedInventoryRow, applyCombinedStock, rankPickerMatches } = context.window.__manTest;


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

console.log("manual-entry tests passed");
