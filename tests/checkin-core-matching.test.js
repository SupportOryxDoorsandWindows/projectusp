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

// TEST: series number on one side only (Master "ZLS" vs supplier "ZLS1",
// real Freedom invoice line, and vice versa) is never auto-matched -- it's
// a stock decision -- but the item is offered as a one-click suggestion.
r = matchOne(items, "", "ZLS1-Brake Spring 01");
assert.equal(r.status, "unmatched");
assert.equal(r.itemId, null);
assert.equal(r.suggestedItem.code, "191021");
assert.equal(r.suggestedItem.id, "brake-spring");
r = matchOne(items, "", "ZLS Handle Bush 01");
assert.equal(r.status, "unmatched");
assert.equal(r.suggestedItem.code, "330024");

// TEST: exact matches still auto-match with no suggestion attached.
r = matchOne(items, "", "ZLS1 Brake Arm 01");
assert.equal(r.status, "ok");
assert.equal(r.suggestedItem, undefined);

// TEST: two DIFFERENT series numbers are never suggested.
r = matchOne(items, "", "SMB2 Drawbar Cap A BLK");
assert.equal(r.status, "unmatched");
assert.equal(r.suggestedItem, null);
r = matchOne(items, "", "ZLS2 Handle Bush");
assert.equal(r.suggestedItem, null);

// TEST: the suggestion still needs the colour -- "ZLS Handle Mount" with
// BLK and WHT variants in Master gets no suggestion, never a guess.
const mountItems = items.concat([
  { id: "mount-blk", item_code: "330021", description: "ZLS1 Handle Mount AB BLK", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
  { id: "mount-wht", item_code: "330022", description: "ZLS1 Handle Mount AB WHT", current_qty: 10, unit_of_measure: "pcs", unit_cost: 5 },
]);
r = matchOne(mountItems, "", "ZLS Handle Mount 01");
assert.equal(r.suggestedItem, null);
r = matchOne(mountItems, "", "ZLS Handle Mount AB BLK");
assert.equal(r.suggestedItem.code, "330021");

// TEST: a Flyscreen (ZLS1) part with no ZLS1 record is never suggested as
// the Smartscreen (SMB1) or ZLX item with a similar name -- it's a new item.
r = matchOne(items, "", "ZLS1 Drawbar Cap 01 Right/ Black");
assert.equal(r.status, "unmatched");
assert.equal(r.suggestedItem, null);

// TEST: the series-tolerant pass never creates a code/description conflict
// on a row whose code already matched.
r = matchOne(items, "330024", "ZLS Handle Bush");
assert.equal(r.status, "ok");
assert.equal(r.itemId, "handle-bush");

// TEST: close-match suggestion -- Freedom's "Infinity" name for Master's
// "Housing" profile, with the bar length in the name. Suggests the EXACT
// length row, never auto-matches, and never crosses family, size or side.
const profileItems = [
  { id: "h60is-2500", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", bar_length_mm: 2500, current_qty: 41, unit_of_measure: "pcs", unit_cost: 29 },
  { id: "h60is-2900", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", bar_length_mm: 2900, current_qty: 26, unit_of_measure: "pcs", unit_cost: 25 },
  { id: "h60is-5100", item_code: "310004", description: "ZLS1 Housing 60 IS 01 MILL", bar_length_mm: 5100, current_qty: 0, unit_of_measure: "pcs", unit_cost: 0 },
  { id: "h60os-2900", item_code: "310007", description: "ZLS1 Housing 60 OS 01 MILL", bar_length_mm: 2900, current_qty: 26, unit_of_measure: "pcs", unit_cost: 24 },
  { id: "h80is-2900", item_code: "310016", description: "ZLS1 Housing 80 IS 01 MILL", bar_length_mm: 2900, current_qty: 27, unit_of_measure: "pcs", unit_cost: 30 },
  { id: "recv-2900", item_code: "310025", description: "ZLS1 Receiver 01 MILL", bar_length_mm: 2900, current_qty: 0, unit_of_measure: "pcs", unit_cost: 0 },
  { id: "izlx-60is", item_code: "630100", description: "IZLX Housing IS (Mill, 60)", bar_length_mm: 2900, current_qty: 34, unit_of_measure: "pcs", unit_cost: 40 },
  { id: "smb-60is", item_code: "210025", description: "SMB1 Housing 60 IS MILL", bar_length_mm: 2900, current_qty: 54, unit_of_measure: "pcs", unit_cost: 20 },
];
r = matchOne(profileItems, "", "ZLS1-Infinity 60mm-IS( 2.9m)Mill");
assert.equal(r.status, "unmatched");
assert.equal(r.suggestedItem.id, "h60is-2900");
r = matchOne(profileItems, "", "ZLS1-Infinity 60mm-IS( 2.5m)Mill");
assert.equal(r.suggestedItem.id, "h60is-2500");
r = matchOne(profileItems, "", "ZLS1-Infinity 60mm-OS( 2.9m)Mill");
assert.equal(r.suggestedItem.id, "h60os-2900");
// No length stated -> can't tell which length row is meant -> no suggestion.
assert.equal(matchOne(profileItems, "", "ZLS1-Infinity 60mm-IS Mill").suggestedItem, null);
// Size, side and family must agree -- never 60 vs 80, IS vs OS, ZLS1 vs SMB1/IZLX/ZLS2.
assert.equal(matchOne(profileItems, "", "ZLS1-Infinity 70mm-IS( 2.9m)Mill").suggestedItem, null);
assert.equal(matchOne(profileItems, "", "SMB2-Infinity 60mm-IS( 2.9m)Mill").suggestedItem, null);
assert.equal(matchOne(profileItems, "", "ZLS2-Infinity 60mm-IS( 2.9m)Mill").suggestedItem, null);
// No stated length row exists -> nothing suggested.
assert.equal(matchOne(profileItems, "", "ZLS1-Infinity 60mm-IS( 3.3m)Mill").suggestedItem, null);

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
