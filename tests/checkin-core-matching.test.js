const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("fp-pro.js", "utf8").replace(
  /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
  `\nwindow.__ciTest = { buildCheckinRows };\n})();`
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
const { buildCheckinRows } = context.window.__ciTest;

function itemsMap(items) {
  const m = new Map();
  for (const it of items) {
    const arr = m.get(it.item_code) || [];
    arr.push(it);
    m.set(it.item_code, arr);
  }
  return m;
}

function matchOne(items, invoiceCode, invoiceDescription) {
  const rows = buildCheckinRows(
    [{ code: invoiceCode, description: invoiceDescription, unit: "pcs", qty: 10, unitCost: 5 }],
    [],
    itemsMap(items)
  );
  return rows[0];
}

// Fixture modeled on real Master Inventory data (post-cleanup, code prefix
// already stripped from descriptions) -- includes the exact risk cases found
// in production: bare size numbers (60/70/80) and colour variants (BLK/WHT)
// that a careless "strip trailing numbers/letters" rule would collapse into
// each other.
const items = [
  { id: "brake-arm", item_code: "330070", description: "ZLS1 Brake Arm AB", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "brake-spring", item_code: "191021", description: "ZLS Brake Spring", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "handle-bush", item_code: "330024", description: "ZLS1 Handle Bush", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "end-cap-60", item_code: "630058", description: "IZLX End Cap (Mill, A, 60)", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "end-cap-80", item_code: "630060", description: "IZLX End Cap (Mill, A, 80)", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "drawbar-blk", item_code: "230023", description: "SMB1 Drawbar Cap A BLK", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "drawbar-wht", item_code: "230024", description: "SMB1 Drawbar Cap A WHT", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "dup-a", item_code: "DUP001", description: "Duplicate Bracket Set", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "dup-b", item_code: "DUP002", description: "Duplicate Bracket Set", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
];

// TEST: core words match despite a different trailing suffix ("01" vs "AB").
let r = matchOne(items, "", "ZLS1 Brake Arm 01");
assert.equal(r.status, "ok");
assert.equal(r.itemId, "brake-arm");
assert.equal(r.code, "330070");

// TEST: punctuation / hyphen differences, still matches.
r = matchOne(items, "", "ZLS1-BRAKE ARM");
assert.equal(r.itemId, "brake-arm");

// TEST: extra words on top of the core product still match ("GALVANIZED").
r = matchOne(items, "", "ZLS1 Brake Arm 01 GALVANIZED");
assert.equal(r.itemId, "brake-arm");

// TEST: similar-but-different product must NOT match (Brake Arm vs Brake
// Spring) -- "ZLS1" and "Brake" alone are not enough.
r = matchOne(items, "", "ZLS1 Brake Arm");
assert.notEqual(r.itemId, "brake-spring");
r = matchOne(items, "", "ZLS Brake Spring");
assert.equal(r.itemId, "brake-spring");

// TEST: a bare size number is never treated as ignorable noise -- 60 and 80
// End Caps must stay distinct even though they otherwise share every word.
r = matchOne(items, "", "IZLX End Cap Mill A 60");
assert.equal(r.itemId, "end-cap-60");
r = matchOne(items, "", "IZLX End Cap Mill A 80");
assert.equal(r.itemId, "end-cap-80");
// Without the size number at all, neither candidate has all its core words
// present -- correctly stays unmatched rather than guessing which size.
r = matchOne(items, "", "IZLX End Cap Mill A");
assert.equal(r.status, "unmatched");

// TEST: colour variants must stay distinct for the same reason.
r = matchOne(items, "", "SMB1 Drawbar Cap A BLK");
assert.equal(r.itemId, "drawbar-blk");
r = matchOne(items, "", "SMB1 Drawbar Cap A WHT");
assert.equal(r.itemId, "drawbar-wht");

// TEST: OCR-style digit/letter confusion (1/I, 0/O) is tolerated.
r = matchOne(items, "", "ZLSI Brake Arm 0I"); // "1" read as "I", "01" as "0I"
assert.equal(r.itemId, "brake-arm");

// TEST: series number on one side only -- Master's bare family word "ZLS"
// matches a supplier's "ZLS1" (real Freedom invoice line), and vice versa.
r = matchOne(items, "", "ZLS1-Brake Spring 01");
assert.equal(r.status, "ok");
assert.equal(r.itemId, "brake-spring");
assert.equal(r.code, "191021");
r = matchOne(items, "", "ZLS Handle Bush 01");
assert.equal(r.itemId, "handle-bush");

// TEST: two DIFFERENT series numbers are never the same product.
r = matchOne(items, "", "SMB2 Drawbar Cap A BLK");
assert.equal(r.status, "unmatched");
r = matchOne(items, "", "ZLS2 Handle Bush");
assert.equal(r.status, "unmatched");

// TEST: the looser series pass still needs the colour -- "ZLS Handle Mount"
// with BLK and WHT variants in Master stays unmatched, never guessed.
const mountItems = items.concat([
  { id: "mount-blk", item_code: "330021", description: "ZLS1 Handle Mount AB BLK", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "mount-wht", item_code: "330022", description: "ZLS1 Handle Mount AB WHT", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
]);
r = matchOne(mountItems, "", "ZLS Handle Mount 01");
assert.equal(r.status, "unmatched");
r = matchOne(mountItems, "", "ZLS Handle Mount AB BLK");
assert.equal(r.itemId, "mount-blk");

// TEST: a product that isn't in Master at all stays unmatched, even though
// a different family's item shares most of its words.
r = matchOne(items, "", "ZLS1 Drawbar Cap 01 Right/ Black");
assert.equal(r.status, "unmatched");

// TEST: the looser series pass never creates a code/description conflict
// on a row whose code already matched.
r = matchOne(items, "330024", "ZLS Handle Bush");
assert.equal(r.status, "ok");
assert.equal(r.itemId, "handle-bush");

// TEST: duplicate Master Inventory descriptions -- never auto-pick one.
r = matchOne(items, "", "Duplicate Bracket Set");
assert.equal(r.status, "unmatched");
assert.equal(r.itemId, null);

// TEST: no match at all for a genuinely unrelated description.
r = matchOne(items, "", "Completely Unrelated Widget XYZ");
assert.equal(r.status, "unmatched");
assert.equal(r.itemId, null);

// TEST: code/description conflict -- a valid code paired with a description
// that uniquely (and exactly) belongs to a different item is flagged, never
// silently trusted either way.
r = matchOne(items, "330070", "ZLS Brake Spring");
assert.equal(r.status, "unmatched");
assert.deepEqual(r.codeDescConflict, { codeItemCode: "330070", descItemCode: "191021" });

console.log("check-in core-matching tests passed");
