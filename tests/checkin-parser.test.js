const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("fp-pro.js", "utf8").replace(
  /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
  `\nwindow.__ciTest = { parseCheckinDocument, textLayerLooksUsable, detectShippingCharge };\n})();`
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
const { parseCheckinDocument, textLayerLooksUsable, detectShippingCharge } = context.window.__ciTest;

const freedomApproval = `
COMMON PARTS
134002 ZLS1-Brake Rod-01 1.5m length Each Metal 2 USD 2.48 400 USD 9 92.00
End Caps - MILL
630062 ZLX-End Cap-100-A-01 Each MILL 100mm 1 USD 1 1.39 20 20 USD 2 27.80
EXTRAS
30016R Keder (200m roll) Plastic 200m Extras USD 3 31.65 3 USD 9 94.95
`;

const freedomDoc = parseCheckinDocument(freedomApproval);
assert.equal(freedomDoc.formatId, "freedom-approval-order");
assert.equal(freedomDoc.entries.length, 3);
assert.deepEqual(
  freedomDoc.entries.map((e) => [e.code, e.qty, e.unitCost]),
  [
    ["134002", 400, 2.48],
    ["630062", 20, 11.39],
    ["30016R", 3, 331.65],
  ]
);

const freedomCellStream = `
Part code
Description
PRICE AUD
QTY SUM
TOTAL
134002
ZLS1-Brake Rod-01 1.5m length
Each
Metal
2
2.48
USD
400
992.00
USD
630062
ZLX-End Cap-100-A-01
Each
MILL
100mm
1
11.39
USD
20
20
227.80
USD
Total
1,219.80
USD
`;
const freedomCellDoc = parseCheckinDocument(freedomCellStream);
assert.equal(freedomCellDoc.formatId, "freedom-approval-cell-stream");
assert.deepEqual(
  freedomCellDoc.entries.map((e) => [e.code, e.description, e.qty, e.unitCost]),
  [
    ["134002", "ZLS1-Brake Rod-01 1.5m length", 400, 2.48],
    ["630062", "ZLX-End Cap-100-A-01", 20, 11.39],
  ]
);
assert.deepEqual(freedomCellDoc.reconciliation, {
  expectedTotal: 1219.8,
  parsedTotal: 1219.8,
  ok: true,
});

const mismatchedCellDoc = parseCheckinDocument(freedomCellStream.replace("1,219.80", "1,220.80"));
assert.equal(mismatchedCellDoc.reconciliation.ok, false);

const ziplineOrder = `
ZIPLINE COMPONENTS - INTERNATIONAL
Old Part New Part Required
Image Description Unit Material Price AUD Qty Colour Sub Total Comments
Number Number Quantity
3m x
910005R Pet Mesh 3m wide 30m Plastic 902.50 2 1 ,805.00
Roll
Total 1 ,805.00
`;

const ziplineDoc = parseCheckinDocument(ziplineOrder);
assert.equal(ziplineDoc.formatId, "single-item-order-form");
assert.equal(ziplineDoc.entries.length, 1);
assert.equal(ziplineDoc.entries[0].code, "910005R");
assert.equal(ziplineDoc.entries[0].qty, 2);
assert.equal(ziplineDoc.entries[0].unitCost, 902.5);

const packingList = `
PACKING LIST Date DATE25-12-2025
Sl No Bundle/ Roll NO Description Qty(in Nos) Dimension Grosss Weight(in Kg)
1 Roll 1 ZLS1-INFINITY DRAW BAR 2900 MM 10 297X19X19 40
2 Roll 2 ZLS1-INFINITY DRAW BAR 2500 MM 10 256X19X19 34
Total No of Rolls 2 Gross Weight(in Kg) 74
`;
const packingListDoc = parseCheckinDocument(packingList);
assert.equal(packingListDoc.formatId, "packing-list-no-codes");
assert.deepEqual(
  packingListDoc.entries.map((e) => [e.code, e.description, e.qty, e.unitCost]),
  [
    ["", "ZLS1-INFINITY DRAW BAR 2900 MM", 10, null],
    ["", "ZLS1-INFINITY DRAW BAR 2500 MM", 10, null],
  ]
);

const detachedPackingList = `
Sl No
Bundle/ Roll NO
Qty(in Nos)
Dimension (LXWXH) CM
Grosss Weight(in Kg)
1 Roll 1 10 297X19X19 40
2 Roll 2 10 256X19X19 34
Total No of Rolls 2 74
ZLS1-INFINITY DRAW BAR 2900 MM
PACKING LIST
Description
ZLS1-INFINITY DRAW BAR 2500 MM
`;
const detachedPackingDoc = parseCheckinDocument(detachedPackingList);
assert.equal(detachedPackingDoc.formatId, "packing-list-no-codes");
assert.deepEqual(
  detachedPackingDoc.entries.map((e) => [e.description, e.qty]),
  [
    ["ZLS1-INFINITY DRAW BAR 2900 MM", 10],
    ["ZLS1-INFINITY DRAW BAR 2500 MM", 10],
  ]
);

const layoutlessSupplierRows = `
Random supplier export
A100 Nylon Cord White 12 4.50 54.00
B200 Heavy Bracket 8 pcs 3.25 26.00
`;
const layoutlessDoc = parseCheckinDocument(layoutlessSupplierRows);
assert.equal(layoutlessDoc.formatId, "layoutless-standardized");
assert.deepEqual(
  layoutlessDoc.entries.map((e) => [e.code, e.description, e.qty, e.unitCost, e.lowConfidence]),
  [
    ["A100", "Nylon Cord White", 12, 4.5, true],
    ["B200", "Heavy Bracket", 8, 3.25, true],
  ]
);

assert.equal(textLayerLooksUsable(""), false);
assert.equal(textLayerLooksUsable("(cid:0)(cid:2)(cid:3)(cid:4)(cid:5)(cid:6)(cid:7)"), false);

const wrappedOcrPackingCharge = `
SI Description of Rate per Amount
No. Goods and Services Cut length(in mtr) HSN/SAC aty(nNos) ep pa
Additional Packing charges (in
1
crate) 998540 1.00 59.00 No 59.00
Amount Chargeable (in words) E.&O.E
USD: Fifty Nine Only
`;
assert.deepEqual(
  detectShippingCharge(wrappedOcrPackingCharge),
  {
    amount: 59,
    needsReview: false,
    label: "Additional Packing charges (in 1 crate) 998540 1.00 59.00 No 59.00",
    note: 'Detected from "Additional Packing charges (in 1 crate) 998540 1.00 59.00 No 59.00" — review before confirming.',
  }
);

assert.equal(
  detectShippingCharge("Tax Rate Price Freight\nA100 Nylon Cord 10 4.50 45.00\nGrand Total 45.00").amount,
  null
);

console.log("check-in parser tests passed");
