// Pure parts of transit.js (window.ORYX_TRANSIT_CORE). Run: node tests/transit.test.js
// Optional: TRANSIT_DOCS_JSON=<file> with {po2107, sq388, po2106, s231} = the
// pdf.js text (same joining as extractPdfText) of the owner's real PO /
// quotation PDFs (not committed: public repo) for the real-file checks.
const assert = require("assert");
require("../transit.js");
const C = globalThis.ORYX_TRANSIT_CORE;

// Supplier group + PO key
assert.equal(C.supplierGroup("Freedom Screens Global Co., Ltd"), "Freedom");
assert.equal(C.supplierGroup("RENSON NV"), "Renson");
assert.equal(C.supplierGroup("Fusion Trading"), "Fusion");
assert.equal(C.supplierGroup("Acme"), "Other");
assert.equal(C.poKey("PO26-2106"), C.poKey("po 26/2106"));

// Values: pending x price x rate; only open POs count
const orders = [
  { id: 1, po_number: "PO1", supplier: "Freedom Screens Global", supplier_group: "Freedom", delivery_status: "partially_received", payment_status: "tbc", currency: "USD", rate_to_aed: 3.6725, expected_delivery: "2026-12-15" },
  { id: 2, po_number: "PO2", supplier: "Renson NV", supplier_group: "Renson", delivery_status: "ordered", payment_status: "paid", currency: "EUR", rate_to_aed: 4, expected_delivery: "2027-01-10" },
  { id: 3, po_number: "PO3", supplier: "Freedom Screens Global", supplier_group: "Freedom", delivery_status: "completed", payment_status: "paid", currency: "AED", rate_to_aed: 1 },
];
const lines = [
  { id: 11, order_id: 1, line_no: 1, item_code: "310028", description: "Track", qty_ordered: 10000, qty_received: 4000, qty_cancelled: 0, qty_pending: 6000, unit_price: 31.5 },
  { id: 12, order_id: 1, line_no: 2, item_code: "90001T", description: "Jig", qty_ordered: 4, qty_received: 0, qty_cancelled: 1, qty_pending: 3, unit_price: null },
  { id: 21, order_id: 2, line_no: 1, item_code: "22874", description: "Steel bar", qty_ordered: 20, qty_received: 0, qty_cancelled: 0, qty_pending: 20, unit_price: 40 },
  { id: 31, order_id: 3, line_no: 1, item_code: "X", description: "Done", qty_ordered: 5, qty_received: 5, qty_cancelled: 0, qty_pending: 0, unit_price: 10 },
];
const s = C.summarise(orders, lines);
assert.equal(s.value, Math.round((6000 * 31.5 * 3.6725 + 20 * 40 * 4) * 100) / 100);
assert.deepEqual([s.ordered, s.received, s.pending, s.openPos, s.noPrice], [10024, 4000, 6023, 2, 1]);
assert.equal(s.groups.Freedom.pos, 1); assert.equal(s.groups.Renson.value, 3200); assert.equal(s.groups.Fusion.value, 0);

// Filters + sort
const rows = C.rowsOf(orders, lines);
assert.equal(C.filterRows(rows, {}).length, 3, "completed PO hidden by default");
assert.equal(C.filterRows(rows, { showClosed: true }).length, 4);
assert.equal(C.filterRows(rows, { group: "Renson" }).length, 1);
assert.equal(C.filterRows(rows, { material: "track" })[0].id, 11);
assert.equal(C.filterRows(rows, { payment: "paid" }).length, 1);
assert.equal(C.filterRows(rows, { from: "2027-01-01" }).length, 1);
assert.equal(C.filterRows(rows, { search: "renson" }).length, 1);
assert.deepEqual(C.sortRows(C.filterRows(rows, {}), "qty_pending", "desc").map((r) => r.id), [11, 21, 12]);

// Lines: Freedom Global layout (code in brackets, numbers on their own lines)
const a = C.parseLines(`DESCRIPTION  QUANTITY  UNIT PRICE  GST  AMOUNT
 [134002] Brake Rod (1.5m)
 METAL - HS CODE: 732090
 600.00  Units  USD  2.10  0%  USD  1,260.00
 [30054] M4 x 10 screw
 METAL - HS CODE: 732090
 1,600.00
 Units
 USD  0.05  0%  USD  80.00
 [90001T] Track Drilling Guide Jig  4.00  Units  USD  55.50  0%  USD  222.00
 [BAD1] Wrong sum  2.00  Units  USD  5.00  0%  USD  11.00`);
assert.deepEqual(a.map((l) => [l.code, l.description, l.qty, l.price]), [["134002", "Brake Rod (1.5m)", 600, 2.1], ["30054", "M4 x 10 screw", 1600, 0.05], ["90001T", "Track Drilling Guide Jig", 4, 55.5]]);
// Freedom AU layout as pdf.js gives it (right to left), incl. a line whose code was printed apart
const b = C.parseLines(` Total Tax % Price Qty Units Description Code Image Ln
 60.00 0% 20.00 3.00 Unit International products
 International
 820.00 0% 20.50 40.00 Length SMB1 Zip Track 220002 2
 300.00 0% 300.00 1.00 Roll ZLS1 ZLS2 Magnet AB (200 30005R 8
 Sub Total  1,180.00`);
assert.deepEqual(b.map((l) => [l.code, l.description, l.unit, l.qty, l.amount]), [[null, "International products", "Unit", 3, 60], ["220002", "SMB1 Zip Track", "Length", 40, 820], ["30005R", "ZLS1 ZLS2 Magnet AB (200", "Roll", 1, 300]]);
// Left to right
const c = C.parseLines("2 220002 SMB1 Zip Track Length 40.00 20.50 0% 820.00\nNotes 12 apples");
assert.deepEqual(c.map((l) => [l.code, l.description, l.unit, l.qty]), [["220002", "SMB1 Zip Track", "Length", 40]]);

// Header of a PO / quote
const po = C.parseHeader(`PURCHASE ORDER\n Purchase Order Date\n Purchase Order No\n 30 Sep 2026\n PO26-2106\n Freedom Screens Global\n Total USD  2,000.00\n Quotation # S00231`);
assert.deepEqual([po.kind, po.poNumber, po.date, po.supplier, po.currency, po.total, po.quoteRef], ["po", "PO26-2106", "2026-09-30", "Freedom Screens Global", "USD", 2000, "S00231"]);
const q = C.parseHeader(` Quotation #  S00231\n Quotation Date\n 25/09/2026\n Untaxed Amount  USD 1,562.00\n Freedom Screens Global Co., Ltd`);
assert.deepEqual([q.kind, q.quoteRef, q.date, q.total], ["quote", "S00231", "2026-09-25", 1562]);

// PO + quote together: header from the PO, lines from the quote; totals checked
const comb = C.combineDocuments([{ header: po, lines: [] }, { header: { ...q, total: 1562 }, lines: a }]);
assert.equal(comb.draft.po_number, "PO26-2106"); assert.equal(comb.draft.lines.length, 3);
assert.ok(comb.problems.some((x) => /2,000.00/.test(x)), "lines vs PO total differ -> problem");
const ok = C.combineDocuments([{ header: { ...q, total: 1562 }, lines: a }]);
assert.ok(ok.notes.some((x) => /= the document total/.test(x))); assert.ok(ok.notes.some((x) => /No purchase order/.test(x)));
assert.ok(C.combineDocuments([{ header: po, lines: [] }]).problems.some((x) => /No item lines/.test(x)));
const wrongQuote = C.combineDocuments([{ header: po, lines: [] }, { header: { ...q, quoteRef: "S00999" }, lines: a }]);
assert.ok(wrongQuote.problems.some((x) => /S00999/.test(x)));

// Excel rows -> one draft per PO
const sheet = C.parseSheetRows([
  ["Incoming materials"],
  ["PO Number", "Supplier", "Material Code", "Description", "Qty", "Unit", "Unit Price", "Currency", "Expected delivery"],
  ["PO-1", "Fusion", "A1", "Part A", 10, "pcs", 2.5, "usd", "15/12/2026"],
  ["PO-1", "Fusion", "A2", "Part B", "5", "pcs", "", "USD", ""],
  ["", "", "", "orphan", 1],
  ["PO-2", "Renson NV", "22874", "Steel bar", 20, "pc", 40, "EUR", 46371],
]);
assert.equal(sheet.drafts.length, 2);
assert.deepEqual([sheet.drafts[0].currency, sheet.drafts[0].expected_delivery, sheet.drafts[0].lines[1].unit_price, sheet.drafts[1].expected_delivery], ["USD", "2026-12-15", null, "2026-12-15"]);
assert.ok(sheet.problems.some((x) => /no PO number/.test(x)));
assert.ok(C.parseSheetRows([["a", "b"], [1, 2]]).problems.length);

// Draft problems
const keys = new Set([C.poKey("PO-9")]);
const good = { po_number: "PO-1", supplier: "Fusion", currency: "USD", rate_to_aed: "3.6725", lines: [{ item_code: "A1", description: "Part A", qty_ordered: "10", unit_price: "2.5" }] };
assert.deepEqual(C.draftProblems(good, keys), []);
assert.ok(C.draftProblems({ ...good, po_number: "po 9" }, keys)[0].includes("already"));
assert.ok(C.draftProblems({ ...good, rate_to_aed: "" }, keys).some((x) => /rate/.test(x)));
assert.ok(C.draftProblems({ ...good, lines: [...good.lines, { item_code: "a1", description: "part a ", qty_ordered: 1 }] }, keys).some((x) => /twice/.test(x)));
assert.ok(C.draftProblems({ ...good, lines: [{ description: "x", qty_ordered: 0 }] }, keys).some((x) => /more than 0/.test(x)));
assert.ok(C.draftProblems({ ...good, lines: [{ description: "x", qty_ordered: 1, needsPick: true }] }, keys).some((x) => /bar length/.test(x)));

// Receive: never more than pending; at least one line
const pend = [{ id: 11, item_code: "310028", qty_pending: 6000 }, { id: 12, item_code: "90001T", qty_pending: 3 }];
assert.deepEqual(C.receiveCheck(pend, { 11: "4,000" }), { problems: [], send: [{ line_id: 11, qty: 4000 }] });
assert.ok(C.receiveCheck(pend, { 11: "6001" }).problems[0].includes("more than the 6000"));
assert.ok(C.receiveCheck(pend, { 12: "-1" }).problems.length);
assert.ok(C.receiveCheck(pend, {}).problems[0].includes("at least one"));

// The Check-in's own lines typed by hand = the newest batch only
assert.deepEqual(C.latestBatch([{ id: "a", created_at: "t2" }, { id: "b", created_at: "t2" }, { id: "c", created_at: "t1" }]), ["a", "b"]);
assert.deepEqual(C.latestBatch([]), []);

// Real files (optional)
if (process.env.TRANSIT_DOCS_JSON) {
  const d = require(require("path").resolve(process.env.TRANSIT_DOCS_JSON));
  const read = (k) => ({ header: C.parseHeader(d[k]), lines: C.parseLines(d[k]) });
  const au = C.combineDocuments([read("po2107"), read("sq388")]);
  assert.deepEqual([au.draft.po_number, au.draft.quote_ref, au.draft.currency, au.draft.lines.length, au.problems.length], ["PO26-2107", "SQ-00000388", "AUD", 12, 0]);
  const th = C.combineDocuments([read("po2106"), read("s231")]);
  assert.deepEqual([th.draft.po_number, th.draft.quote_ref, th.draft.currency, th.draft.lines.length, th.problems.length], ["PO26-2106", "S00231", "USD", 66, 0]);
  console.log("transit: real PO / quote files read (12 + 66 lines, totals agree)");
}
console.log("transit tests passed");
