const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("fp-pro.js", "utf8").replace(
  /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
  `\nwindow.__ciTest = { parseCheckinDocument, textLayerLooksUsable, detectShippingCharge, buildCheckinRows, storedInventoryUnitCostAed, detectDocumentCurrencyInfo, parseCheckinHeader };\n})();`
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
const { parseCheckinDocument, textLayerLooksUsable, detectShippingCharge, buildCheckinRows, storedInventoryUnitCostAed, detectDocumentCurrencyInfo, parseCheckinHeader } = context.window.__ciTest;

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

const packagedInventory = new Map([
  ["30016R", [{
    id: "keder", item_code: "30016R", description: "Keder (200m roll)",
    unit_of_measure: "m", current_qty: 100, unit_cost: 1.5,
  }]],
  ["30003R", [{
    id: "bug-fur", item_code: "30003R", description: "Bug Fur 16mm (300m Roll)",
    unit_of_measure: "m", current_qty: 20, unit_cost: 1.7,
  }]],
  ["30001R", [{
    id: "bug-fur-12", item_code: "30001R", description: "Bug Fur 12mm (125m)",
    unit_of_measure: "m", current_qty: 20, unit_cost: 1.7,
  }]],
]);

const packagedRows = buildCheckinRows([
  { code: "30016R", description: "Keder (200m roll)", unit: "200m", qty: 4, unitCost: 331.65 },
  { code: "30003R", description: "Bug Fur 16mm (300m Roll)", unit: "Units", qty: 1, unitCost: 499.94 },
], [], packagedInventory);

assert.deepEqual(
  packagedRows.map((r) => [r.code, r.qty, r.invoiceUnitCost, r.newQty, r.packageInfo.rollCount]),
  [
    ["30016R", 800, 331.65 / 200, 900, 4],
    ["30003R", 300, 499.94 / 300, 320, 1],
  ]
);
assert.equal(packagedRows[0].packageInfo.qtyPerPackage, 200);
assert.equal(packagedRows[1].packageInfo.qtyPerPackage, 300);
assert.equal(packagedRows[0].packageInfo.type, "Roll");
assert.equal(packagedRows[1].packageInfo.type, "Roll");
assert.equal(storedInventoryUnitCostAed(packagedRows[1], 499.94 / 300, 1), 1.66);
assert.equal(storedInventoryUnitCostAed(packagedRows[0], 331.65 / 200, 1), 1.65);
assert.equal(storedInventoryUnitCostAed({ packageInfo: null }, 1.6665, 1), 1.6665);

const truncatedBugFur = buildCheckinRows([
  { code: "3000", description: "Bug Fur 16mm (300m Roll)", unit: "", qty: 1, unitCost: 499.94 },
], [], packagedInventory)[0];
assert.equal(truncatedBugFur.code, "30003R");
assert.equal(truncatedBugFur.itemId, "bug-fur");
assert.equal(truncatedBugFur.qty, 300);
assert.equal(truncatedBugFur.invoiceUnitCost, 499.94 / 300);
assert.equal(truncatedBugFur.matchedByDescription.sourceCode, "3000");
assert.equal(storedInventoryUnitCostAed(truncatedBugFur, truncatedBugFur.invoiceUnitCost, 1), 1.66);

const ambiguousInventory = new Map([
  ["30003R", packagedInventory.get("30003R")],
  ["39999R", [{
    id: "other-bug-fur", item_code: "39999R", description: "39999R-Bug Fur 16mm (300m Roll)",
    unit_of_measure: "m", current_qty: 0, unit_cost: 0,
  }]],
]);
const ambiguousBugFur = buildCheckinRows([
  { code: "3000", description: "Bug Fur 16mm (300m Roll)", unit: "", qty: 1, unitCost: 499.94 },
], [], ambiguousInventory)[0];
assert.equal(ambiguousBugFur.status, "unmatched");
assert.equal(ambiguousBugFur.itemId, null);

const mismatchedRoll = buildCheckinRows([
  { code: "30003R", description: "Bug Fur", unit: "200m", qty: 1, unitCost: 499.94 },
], [], packagedInventory)[0];
assert.equal(mismatchedRoll.status, "exact-diff");
assert.equal(mismatchedRoll.decided, false);

const descriptionMismatch = buildCheckinRows([
  { code: "30001R", description: "Bug Fur 12mm (100m Roll)", unit: "Plastic", qty: 3, unitCost: 285.67 },
], [], packagedInventory)[0];
assert.equal(descriptionMismatch.status, "exact-diff");
assert.equal(descriptionMismatch.exactMatchItem.invoicePackSize, "100m");
assert.equal(descriptionMismatch.exactMatchItem.packSize, "125m");

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

// Freedom "Zipline Component Order Form": pdf.js emits one table cell per
// line. Ref No. (ZIP49) is Freedom's own reference, never the item code;
// quantity and price are the only pair that multiply out to the Sub Total
// (never "Amt Per Screen" or the "CUT INTO 2.8 AND 2.3M" note).
const ziplineForm = [
  " Ref No.", " ", "Image", " ", "Name", " ", "Amt Per", "Screen", " ", "Mill Price", " ", "QTY",
  "Powder", "Coat price", "QTY", " ", "Colour", " ", "Sub Total",
  " ZIP49", " ", "ZLS1-Brake Adjuster-01 0.005 kgs", " ", "2", " ", "3.69", " ", "200", " ", "n/a", " ", "$738.00",
  "ZIP57", " ", "Magnet Holder-STR (5.1m) 0.304 kgs", "Plastic Extrusion 5.1m Length", "20.03", " ", "50",
  "CUT INTO", "2.8 AND", "2.3M", "$1,001.50",
  "ZIP59", " ", "ZLS1-Magnet-01 (200m roll) 25 kgs", " ", "367.82", " ", "2", " ", "n/a", " ", "$735.64",
  " Order Approved Name Signed Dated", " Zipline Component Order Form", " Page 1 of 1",
].join("\n");
const ziplineFormDoc = parseCheckinDocument(ziplineForm);
assert.equal(ziplineFormDoc.formatId, "zipline-order-form");
assert.deepEqual(
  ziplineFormDoc.entries.map(({ code, description, qty, unitCost }) => ({ code, description, qty, unitCost })),
  [
    { code: "", description: "ZLS1-Brake Adjuster-01", qty: 200, unitCost: 3.69 },
    { code: "", description: "Magnet Holder-STR (5.1m)", qty: 50, unitCost: 20.03 },
    { code: "", description: "ZLS1-Magnet-01 (200m roll)", qty: 2, unitCost: 367.82 },
  ]
);
// A row whose numbers don't multiply out to its Sub Total is never guessed.
assert.equal(parseCheckinDocument(ziplineForm.replace("$738.00", "$739.00")).entries.length, 2);

// Freedom Screens of Australia invoice/quote/proforma layout (real files:
// PI 46810, Quote 47457). One line per item; colour splits either inline
// ("75 White 75 Black") or stored out of order in the PDF and re-attached by
// position ("50 white /25 black" beside its line).
const freedomQuote = [
  " QTY  DESCRIPTION  UNIT PRICE", "(ex GST)", "DISC %  TOTAL", "(ex GST)",
  " Smartscreen Components",
  " 75  SMB1 End Cap-60A-01  $6.13  $459.75",
  " 75  SMB1 Cord Grip-01  $1.85  $138.75",
  " 150  ZLS1 Handle Mount - 01  -  75 White 75 Black  $4.91  $736.50",
  " 2  ZLS1 Magnet - 01  $367.82  $735.64",
  "50 white /25 black",
  " Subtotal:", " $2,070.64",
].join("\n");
const freedomQuoteItems = [[
  { str: "SMB1 End Cap-60A-01", x: 101, y: 455 },
  { str: "SMB1 Cord Grip-01", x: 101, y: 367 },
  { str: "50 white /25 black", x: 183, y: 367 },
]];
const fq = parseCheckinDocument(freedomQuote, freedomQuoteItems);
assert.equal(fq.formatId, "qty-description-price-total");
assert.equal(fq.reconciliation.ok, true);
assert.deepEqual(
  fq.entries.map(({ description, qty, unitCost }) => [description, qty, unitCost]),
  [
    ["SMB1 End Cap-60A-01", 75, 6.13],
    ["SMB1 Cord Grip-01 - White", 50, 1.85],
    ["SMB1 Cord Grip-01 - Black", 25, 1.85],
    ["ZLS1 Handle Mount - 01 - White", 75, 4.91],
    ["ZLS1 Handle Mount - 01 - Black", 75, 4.91],
    ["ZLS1 Magnet - 01", 2, 367.82],
  ]
);
// Without positions (e.g. an OCR'd page) the detached note is never guessed
// onto a line -- Cord Grip stays one 75-piece row for a person to split.
assert.equal(parseCheckinDocument(freedomQuote, null).entries.filter((e) => /Cord Grip/.test(e.description)).length, 1);
// A line whose QTY x PRICE doesn't equal its TOTAL is never read.
assert.equal(parseCheckinDocument(freedomQuote.replace("$459.75", "$460.75"), null).entries.some((e) => /End Cap/.test(e.description)), false);

// Freedom "ZL2 Components" order form: no "Order Form" title, "Mill Price"
// split over two lines, refs like "ZL32 -" / "ZL32 PC".
const zl2Form = [
  "Ref No.", "Image", "Name", "No. Per Screen", "Mill", "Price", "QTY", "Powder", "Coat Price", "QTY", "Colour", "Sub Total",
  " ZL30", "ZL2 Gearbox ASSEM (100mm and 80mm) 0.065kgs", "1", "17.34", "10", "0.00", "0", "n/a", "$173.40",
  "ZL32 -", "ZL32 PC", "ZL2 Handle ASSEM (NOTE: Black, White and Grey are standard cols) (100mm and 80mm) 0.54kgs",
  "1", "121.34", "10", "179.12", "White", "$1,213.40", " ZL2 Components",
].join("\n");
assert.deepEqual(
  parseCheckinDocument(zl2Form).entries.map(({ description, qty, unitCost }) => [description, qty, unitCost]),
  [["ZL2 Gearbox ASSEM (100mm and 80mm)", 10, 17.34], ["ZL2 Handle ASSEM (100mm and 80mm)", 10, 121.34]]
);

// Freedom Screens India proforma (real file "SUP 22 Pool Patio Mesh R2"):
// Sl No · Particulars · Rolls · Rate $USD · Per · Amount -- rates without
// decimals, a bare "Packing 120" charge, USD stated in the headings.
const freedomIndia = [
  " Sl No  Particulars  Rolls  Rate $USD  Per  Amount ($USD)",
  " 1  Phifer Fiberglass Pool and Patio Screen 9' x 100'  10  458  roll  4580.000",
  " 2  Phifer Fiberglass Pool and Patio Screen 11' x 100'  5  560  roll  2800.000",
  " 3  ZLS1- Magnet-01 ( 25mtrs roll)  8  11  roll  88.000",
  " 4  Rubber Spline Drawbar ( 50 mtrs roll)  2  7.5  roll  15.000",
  " 7483.00",
  " Validity Of Pi is 30 days  Packing  120",
  " Total  7603.000",
].join("\n");
const fi = parseCheckinDocument(freedomIndia);
assert.equal(fi.formatId, "slno-particulars");
assert.equal(fi.reconciliation.ok, true);
assert.deepEqual(fi.missingLnNumbers, []);
assert.deepEqual(
  fi.entries.map(({ description, qty, unitCost, unit }) => [description, qty, unitCost, unit]),
  [
    ["Phifer Fiberglass Pool and Patio Screen 9' x 100'", 10, 458, "roll"],
    ["Phifer Fiberglass Pool and Patio Screen 11' x 100'", 5, 560, "roll"],
    ["ZLS1- Magnet-01 ( 25mtrs roll)", 8, 11, "roll"],
    ["Rubber Spline Drawbar ( 50 mtrs roll)", 2, 7.5, "roll"],
  ]
);
assert.equal(detectShippingCharge(freedomIndia).amount, 120);
assert.equal(detectDocumentCurrencyInfo(freedomIndia).currency, "USD");
// A line whose qty x rate doesn't equal its amount is never read -- and its
// missing Sl No is reported, not silently skipped.
const fiBad = parseCheckinDocument(freedomIndia.replace("4580.000", "4581.000"));
assert.equal(fiBad.entries.length, 3);
assert.deepEqual(fiBad.missingLnNumbers, [1]);

// Currency detection: written codes/symbols first; a bare "$" uses the
// document's own country details; with none, it's left for the person to
// choose (never silently AED).
const cur = (t) => detectDocumentCurrencyInfo(t);
assert.equal(cur("Price USD 3.51 Total USD 351.00").currency, "USD");
assert.equal(cur("Price AUD 902.50").currency, "AUD");
assert.equal(cur("Unit US$ 4.90 Sub Total US$490.00").currency, "USD");
assert.equal(cur("Unit A$ 4.90 Total AU$490.00").currency, "AUD");
assert.equal(cur("Freedom Screens Pty Ltd ABN 12 345 678 901\nZIP49 Brake Adjuster $738.00").currency, "AUD");
assert.equal(cur("Shipped from Denver, USA\nZIP49 Brake Adjuster $738.00").currency, "USD");
const bareDollar = cur(ziplineForm);
assert.equal(bareDollar.currency, "AUD");
assert.equal(bareDollar.basis, "dollar-default-aud");
assert.equal(bareDollar.needsChoice, false);
assert.equal(cur("GSTIN 27AAB Freedom Screens India\nZIP49 Brake Adjuster $738.00 GST 18%").currency, "AUD");
assert.equal(cur("Nylon Cord 10 4.50 45.00").currency, "AED");
assert.equal(cur("Price AED 12.00").currency, "AED");

// Header: Freedom's quote/invoice keeps each label ("Invoice No:", "PO No:")
// apart from its value in the text, so the value is read beside the label by
// page position (Quote 47457: was "19" from the date and the label "PO No").
const freedomQuoteHeaderText = " Invoice No:\n Terms:\n Oryx Door Systems LLC\n Date:\n Quote\n 19/03/2024\n PO No:\n 00047457\n March 2024\n FREEDOM SCREENS OF AUSTRALIA PTY LTD";
const at = (str, x, y) => ({ str, x, y, upright: true });
const headerQuoteItems = [[
  at("FREEDOM SCREENS OF AUSTRALIA PTY LTD", 199, 785), at("Invoice No:", 384, 753), at("00047457", 489, 755),
  at("Date:", 384, 739), at("19/03/2024", 483, 739), at("PO No:", 384, 722), at("March 2024", 481, 722),
  at("Terms:", 384, 688), at("Quote", 44, 687),
]];
const fqh = parseCheckinHeader(freedomQuoteHeaderText, headerQuoteItems);
assert.equal(fqh.invoiceNumber, "00047457");
assert.equal(fqh.poNumber, "March 2024");
assert.equal(fqh.isoDate, "2024-03-19");
// "Invoice" / "#:" split over two lines, "Your Ref:" as the reference (PI 46810).
const fpi = parseCheckinHeader("PROFORMA INVOICE\n13 Blue Rock Drive,", [[
  at("Invoice", 382, 755), at("00046810", 489, 755), at("#:", 382, 743), at("Your Ref:", 381, 722), at("Sanoop Email", 473, 722),
]]);
assert.equal(fpi.invoiceNumber, "00046810");
assert.equal(fpi.poNumber, "Sanoop Email");
// A value is never another label, and rotated text is never paired.
assert.equal(parseCheckinHeader("x", [[at("PO No:", 384, 722), at("Terms:", 450, 722)]]).poNumber, "");
assert.equal(parseCheckinHeader("x", [[{ str: "Purchase Order No:", x: 132, y: 372, upright: false }, { str: "No. Per", x: 328, y: 372, upright: false }]]).poNumber, "");
// Without positions (OCR): no date fragment, street number or bare label.
const ocr = parseCheckinHeader(freedomQuoteHeaderText);
assert.equal(ocr.invoiceNumber, "");
assert.equal(ocr.poNumber, "");
assert.equal(parseCheckinHeader("PROFORMA INVOICE\n13 Blue Rock Drive,").invoiceNumber, "");
assert.equal(parseCheckinHeader("Quote # SQ-1042\nPO 26-1139").invoiceNumber, "SQ-1042");
assert.equal(parseCheckinHeader("Quote # SQ-1042\nPO 26-1139").poNumber, "PO 26-1139");

console.log("check-in parser tests passed");
