// Master Inventory list order (fp-inventory.js sortForList): L Angle, Box
// Section and Flat Trim items are listed last; everything else keeps the
// item-code order it was loaded in.
const assert = require("assert");
const { loadFp } = require("./load-fp");

const fakeEl = {
  addEventListener() {}, classList: { add() {}, remove() {} }, style: {},
  value: "", innerHTML: "", textContent: "", querySelectorAll() { return []; }, appendChild() {},
};
const context = {
  console,
  window: {
    ORYX_CONFIG: { supabaseUrl: "https://example.supabase.co", supabaseKey: "key" },
    supabase: { createClient() { return { from() { return { select() { return this; }, order() { return this; }, limit() { return this; } }; } }; } },
  },
  document: { querySelector() { return fakeEl; }, createElement() { return fakeEl; }, head: fakeEl },
  setTimeout, clearTimeout, crypto: { subtle: {} },
};
const { sortForList } = loadFp(context);

const items = [
  { item_code: "10001-30x30", description: "30x30mm L Angle" },
  { item_code: "10002-40x40", description: "40x40 Box Section" },
  { item_code: "10003-25", description: "25mm Flat Trim" },
  { item_code: "15X30", description: "15X30 BOX" },
  { item_code: "310028", description: "ZLS1 Housing 60 IS 01 MILL" },
  { item_code: "490001", description: "ZLS2 Gearbox ASSEM" }, // "Gearbox" is not a box section
  { item_code: "B1", description: null },
];
assert.deepEqual(sortForList(items).map((it) => it.item_code),
  ["310028", "490001", "B1", "10001-30x30", "10002-40x40", "10003-25", "15X30"]);
assert.equal(items[0].item_code, "10001-30x30"); // the input list is not changed

console.log("inventory-order tests passed");
