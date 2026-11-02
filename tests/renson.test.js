// Renson pilot (renson.js, window.ORYX_RENSON_CORE): reading the Renson
// stock Excel. The rows below are made up in the layout of "RENSON STOCK
// OCT 27.xlsx" (sheet STOCK: totals row, header row with "Part Code", stock
// in the dated column, "OPENING COST PER PROFILE", "Total opening cost").
// That real file (100 items, 41 with stock, AED 161,171.60 = its own
// INVENTORY VALUE) is not committed; with RENSON_XLSX=<file> and
// XLSX_PATH=<node_modules/xlsx-js-style> it is read too.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("renson.js", "utf8"), context);
const R = context.window.ORYX_RENSON_CORE;
let n = 0;
const t = (name, fn) => { fn(); n++; };

t("item code, second code and description", () => {
  const s = (x) => JSON.parse(JSON.stringify(R.splitPartCode(x)));
  assert.deepStrictEqual(s("2405 (P6028425)-Spline Ø 6 mm"), { code: "2405", alt: "P6028425", description: "Spline Ø 6 mm" });
  assert.deepStrictEqual(s("1465-G6020837-End piece bottom bar left white"), { code: "1465", alt: "G6020837", description: "End piece bottom bar left white" });
  assert.deepStrictEqual(s("D6110097-Sergé SC0140 GREY-BLUE AZURE 3200 mm30 m"), { code: "D6110097", alt: "", description: "Sergé SC0140 GREY-BLUE AZURE 3200 mm30 m" });
  assert.deepStrictEqual(s("910005R-Pet Mesh 3000mm Roll (3mx30m/roll)"), { code: "910005R", alt: "", description: "Pet Mesh 3000mm Roll (3mx30m/roll)" });
  assert.deepStrictEqual(s("1117 (G000179)-Somfy Situo 5 RTS Pure 2"), { code: "1117", alt: "G000179", description: "Somfy Situo 5 RTS Pure 2" });
  assert.deepStrictEqual(s("19493-19493"), { code: "19493", alt: "", description: "19493" });
  // a description that only CONTAINS a code later is not split again
  assert.strictEqual(s("2439-Bottom bar profile Square - 6 m P6043310").description, "Bottom bar profile Square - 6 m P6043310");
  assert.strictEqual(R.splitPartCode("Blue tape no code"), null);
});

const HEAD = ["Product", null, "BLK/WHT", "Picture", "Part Code", "COMPOSITE\nSINGLE", "Length", 46322, "OPENING COST PER PROFILE", "Total opening cost", null, null, "Consumption "];
const sheet = (lines, total = 2502) => [
  [null, null, null, null, "INVENTORY VALUE", null, null, null, total, "OPENING VALUE"],
  HEAD,
  ...lines,
  [null, null, null, null, null, null, null, null, null, 0, null, null, 0],
  [null, null, null, null, null, null, null, null, null, 0, "#REF!"],
];

t("the real layout: stock, cost, value, empty counts, sheet total", () => {
  const p = R.parseRensonSheet(sheet([
    [null, null, null, "#VALUE!", "22874-Bar Ø 18 mm - 6.15 m STEEL (P6027110)", null, "bar", 14, 153, 2142],
    ["150", "PROFILE", "COMMON", null, "2439-Bottom bar profile Square - 6 m P6043310", 1, "bar", null, null, 0],
    ["150/100", null, "COMMON", "#VALUE!", "18343-ROLL SERGE GV-0101 - B 3200 MM", 1, "m", 30, 12, 360],
    [null, null, null, "#VALUE!", "17710 (G6009844)-Blue tape 55 mm", null, null, 20, null, 0],
    ["150/100", null, "COMMON", null, "28296 (S6030355)-CABLE CONNECTOR CG3 - 4 WIRES RIGHT", 1, "pc", null, 111, 0],
  ]));
  assert.strictEqual(p.ok, true, JSON.stringify(p.issues));
  assert.strictEqual(p.stockDate, "2026-10-27");
  assert.strictEqual(p.header.row, 2);
  assert.strictEqual(p.totals.items, 5);
  assert.strictEqual(p.totals.withStock, 3);
  assert.strictEqual(p.totals.noCount, 2);
  assert.strictEqual(p.totals.value, 2502);
  assert.strictEqual(p.sheetTotal, 2502);
  assert.strictEqual(p.totalMatches, true);
  const bar = p.items[1];
  assert.deepStrictEqual(JSON.parse(JSON.stringify([bar.item_code, bar.qty, bar.unit_cost, bar.product_size, bar.part_type, bar.colour, bar.qty_per_set, bar.unit, bar.source_row])),
    ["2439", 0, null, "150", "PROFILE", "COMMON", 1, "bar", 4]);
  assert.strictEqual(p.items[0].product_size, "");          // "#VALUE!" picture column never read as data
  const kinds = JSON.parse(JSON.stringify(p.issues)).map((x) => x.kind + " " + x.code).sort();
  assert.deepStrictEqual(kinds, ["note 28296", "warning 17710"]);
});

t("a mismatch with the file's own total is shown", () => {
  const p = R.parseRensonSheet(sheet([[null, null, null, null, "22874-Bar", null, "bar", 14, 153, 2142]], 9999));
  assert.strictEqual(p.totalMatches, false);
  assert.strictEqual(p.ok, true);
});

t("errors block the import", () => {
  const bad = R.parseRensonSheet(sheet([
    [null, null, null, null, "22874-Bar", null, "bar", 14, 153, 2142],
    [null, null, null, null, "22874-Bar again", null, "bar", 1, 1, 1],
    [null, null, null, null, "1001-Neg", null, "pc", -2, 1, -2],
    [null, null, null, null, "1002-Ref", null, "pc", "#REF!", 1, 0],
    [null, null, null, null, "1003-Text cost", null, "pc", 1, "abc", 0],
    [null, null, null, null, "no code here", null, "pc", 1, 1, 1],
  ]));
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bad.issues)).filter((x) => x.kind === "error").map((x) => x.row), [4, 5, 6, 7, 8]);
  assert.strictEqual(bad.items.length, 1);
  const wrongRow = R.parseRensonSheet(sheet([[null, null, null, null, "1005-X", null, "pc", 2, 3, 7]]));
  assert.ok(wrongRow.issues.some((x) => x.kind === "warning" && /not stock × unit cost/.test(x.text)));
  assert.match(R.parseRensonSheet([["a", "b"], [1, 2]]).error, /Part Code/);
  assert.match(R.parseRensonSheet([["Part Code", "x"]]).error, /OPENING COST/);
});

if (process.env.RENSON_XLSX && process.env.XLSX_PATH) {
  t("the real file", () => {
    const XLSX = require(process.env.XLSX_PATH);
    const book = XLSX.read(fs.readFileSync(process.env.RENSON_XLSX), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets.STOCK, { header: 1, raw: true, defval: null, blankrows: true });
    const p = R.parseRensonSheet(rows);
    assert.strictEqual(p.ok, true, JSON.stringify(p.issues.filter((x) => x.kind === "error")));
    assert.strictEqual(p.totals.items, 100);
    assert.strictEqual(p.totals.withStock, 41);
    assert.strictEqual(p.totals.value, 161171.6);
    assert.strictEqual(p.sheetTotal, 161171.6);
    assert.strictEqual(p.totalMatches, true);
    console.log("  real file:", p.totals, "issues:", p.issues.map((x) => `${x.kind} r${x.row} ${x.code}: ${x.text}`).join(" | "));
  });
} else console.log("  (real file not given: RENSON_XLSX + XLSX_PATH to include it)");

// ---------------------------------------------------------------- Check-out
// Made-up excerpt in the layout of a Renson FP Pro job list (pdf.js text as
// fp-core.js extractPdfText gives it; the real "24222-Paolo OPT LIST Rev.
// 02.pdf" is a customer file and is not committed: RENSON_JOB_TXT=<text dump>
// + the stock file include it).
const JOB = `Job/Group:  99999R  Delivery date:  User:  Test User
 Description:  Test job
 Fittings List (1 of 2)
 Printout date/time: 05/10/2026 10:02 AM  Pagina 9 di 19
 Class:  PIECE BASED FITTINGS
 Preview  Brand  Code - Colour  Quantity  Description:
 ORYX  1118-(G6000180)-SOMFY-SITUO-1  6  1118 (G6000180)-Somfy Situo 1 RTS Pure
 2
 ORYX  16870-BASE PLATE-0°-LEFT-SIDE  6  16870-Base plate 0° left side guiding
 channel (G6020309)
 ORYX  1379-CLICKER-(G6020304)  24  1379-Clicker (G6020304)
 Printout date/time: 05/10/2026 10:02 AM  Pagina 10 di 19
 ORYX  1379-CLICKER-(G6020304)  4  1379-Clicker (G6020304)
 Class:  GASKETS
 Preview  Brand  Code - Colour  Quantity  Description:
 ORYX  2450-INNER-GUIDINGRAIL-PVC-6  42.9 m  2450-INNER GUIDINGRAIL PVC 6,00M
 DARK GRAY (P6046710)
 ORYX  910005R-PET-MESH-3000MM-ROLL  10.73 m  910005R-Pet Mesh 3000mm Roll
 (3mx30m/roll)
 ORYX  910010-PATIO-MESH-3.2M  12.78 m  910010-Patio-Mesh-3.2m

Job/Group:  99999R
 Bars Optimization Report (1 of 3)
 Serie:  BOX_SECTION  Code:  40X60  Bars:  11 x 6000
 Treatement:
 Description:  Box Section 40x60
 Total length:  66 m  Total Weight:  0 kg
 Serie:  FLYSCREEN  Code:  RENS_SIDE_FIXED
 _1
 Bars:  6 x 6000
 Treatement:
 Description:  Side guiding channel fixed profile - Pair
 Total length:  36 m  Total Weight:  0 kg
 Serie:  FLYSCREEN  Code:  RENSON_100-IS  Bars:  3 x 4000
 Description:  Fixed profile head box Square - 100 (IS)
 Total length:  12 m  Total Weight:  0 kg
 Serie:  FLYSCREEN  Code:  RENSON_100-IS  Bars:  2 x 4500
 Description:  Fixed profile head box Square - 100 (IS)
 Total length:  9 m  Total Weight:  0 kg
 Serie:  FLYSCREEN  Code:  RENSON_150-IS  Bars:  1 x 6000
 Description:  Fixed profile head box Square - 150 (IS)
 Total length:  6 m  Total Weight:  0 kg
 OPTIMIZED CUTTING LIST - Cutting cicles 76 (1 of 6)
 Bars:  9 x 6000 Description: Fabric tube Ø 68 mm Total length: 54 m`;

t("job list: fittings, metres, bars, pairs, left-out lines", () => {
  const items = new Map([["1118", 0, null], ["16870", 110, 2], ["1379", 58, 2], ["2450", 24, 132], ["910005R", 30, 77], ["11583", 8, 165], ["25089", 20, 230.93]]
    .map(([c, q, k]) => [c, { item_code: c, description: "item " + c, current_qty: q, unit_cost: k }]));
  const r = JSON.parse(JSON.stringify(R.buildRensonCheckout(JOB, items)));
  assert.strictEqual(r.job, "99999R");
  const got = Object.fromEntries(r.lines.map((l) => [l.item_code, [l.qty, l.unit, l.before, l.after, l.value]]));
  assert.deepStrictEqual(got, {
    "1118": [6, "pc", 0, -6, 0],                 // no stock: below zero, allowed; no cost = 0
    "1379": [28, "pc", 58, 30, 56],              // same code on two pages adds up
    "2450": [8, "bar", 24, 16, 1056],            // 42.9 m / 6 m = 7.15 -> 8 bars
    "11583": [12, "bar", 8, -4, 1980],           // 6 "Pair" bars = 12 stock bars
    "16870": [6, "pc", 110, 104, 12],            // code with a space after it ("BASE PLATE")
    "25089": [5, "bar", 20, 15, 1154.65],        // 3 x 4000 + 2 x 4500 = 5 bars
    "910005R": [10.73, "m", 30, 19.27, 826.21],
  });
  assert.match(r.lines.find((l) => l.item_code === "2450").source, /42\.9 m ÷ 6 m = 8 bars/);
  const left = r.left.map((l) => (l.code || l.description) + ": " + l.why.split(":")[0]);
  assert.deepStrictEqual(left, ["910010: Not a Renson item (e.g. a Freedom item)", "Box Section 40x60: Box Section",
    "Fixed profile head box Square - 150 (IS): No Renson item is set for this bar"]);
  // nothing from the cutting list after the bars report is counted
  assert.ok(!r.lines.some((l) => /tube/i.test(l.description)));
});

if (process.env.RENSON_JOB_TXT && process.env.RENSON_XLSX && process.env.XLSX_PATH) {
  t("the real job list 24222R", () => {
    const XLSX = require(process.env.XLSX_PATH);
    const book = XLSX.read(fs.readFileSync(process.env.RENSON_XLSX), { type: "buffer" });
    const p = R.parseRensonSheet(XLSX.utils.sheet_to_json(book.Sheets.STOCK, { header: 1, raw: true, defval: null, blankrows: true }));
    const items = new Map(p.items.map((i) => [i.item_code, { ...i, current_qty: i.qty }]));
    const r = R.buildRensonCheckout(fs.readFileSync(process.env.RENSON_JOB_TXT, "utf8"), items);
    assert.strictEqual(r.job, "24222R");
    assert.strictEqual(r.lines.length, 35);                       // 22 fittings + 7 gaskets + 6 bar items
    assert.strictEqual(r.left.length, 8);                         // 910010 + 7 Box Section sizes
    assert.strictEqual(Math.round(r.lines.reduce((s, l) => s + l.value, 0) * 100) / 100, 10664.86);
    console.log("  real job list: 35 lines, 8 left out, AED 10,664.86");
  });
}

// ---------------------------------------------------------------- Check-in
// The preview must give the same numbers as renson_checkin() (the database
// test tests/sql/renson-workflow.test.sql uses the same example).
t("check-in preview: shipping split, price paid, Freedom's average rule", () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.splitShipping(10, 3))), [3.33, 3.33, 3.34]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.splitShipping(0, 2))), [null, null]);
  const items = new Map([["22874", { item_code: "22874", current_qty: 10, unit_cost: 153 }], ["17710", { item_code: "17710", current_qty: 17.5, unit_cost: null }],
    ["D6110097", { item_code: "D6110097", current_qty: -3, unit_cost: null }]]);
  const rows = JSON.parse(JSON.stringify(R.checkinPreview([
    { item_code: "22874", qty: 10, price: 40 }, { item_code: "17710", qty: 5, price: "" },
    { item_code: "d6110097", qty: 5, price: 2.5 }, { item_code: "NEW-1", qty: 3, price: 10 }], { rate: 4, shipping: 80 }, items)));
  // shipping 80 / 4 lines = 20 each
  assert.deepStrictEqual(rows.map((r) => [r.item_code, r.shipAlloc, r.paid, r.avgAfter, r.after, r.value, r.isNew]), [
    ["22874", 20, 168, 160.5, 20, 1680, false],          // (40 + 20/10) x 4 = 168; (10x153 + 10x168)/20
    ["17710", 20, null, null, 22.5, 0, false],           // no price: keeps its (missing) cost
    ["D6110097", 20, 26, 26, 2, 130, false],             // stock below zero: price paid
    ["NEW-1", 20, 66.666667, 66.666667, 3, 200, true],   // new item
  ]);
});

t("status: out of stock, Kanban (Freedom's rule), no cost", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync("kanban.js", "utf8"), ctx);
  const K = (i) => ctx.window.ORYX_KANBAN.kanbanState(i);
  const s = (i) => JSON.parse(JSON.stringify(R.rensonStatus(i, K)));
  assert.deepStrictEqual(s({ current_qty: 0, unit_cost: 2 }), { out: true, kanban: "unset", noCost: false });
  assert.deepStrictEqual(s({ current_qty: 5, unit_cost: null, buffer_level: 10, critical_level: 4 }), { out: false, kanban: "low", noCost: true });
  assert.deepStrictEqual(s({ current_qty: 3, unit_cost: 1, buffer_level: 10, critical_level: 4 }), { out: false, kanban: "critical", noCost: false });
  assert.deepStrictEqual(s({ current_qty: 30, unit_cost: 1, buffer_level: 10 }), { out: false, kanban: "normal", noCost: false });
});

// ---------------------------------------------------------------- Renson documents (one Check-in)
// Made-up excerpt in the layout of Renson NV's order confirmations /
// quotations (pdf.js text: values BEFORE their labels; Overview + Detail).
// The real samples (SUP_1 / SUP_03 / SUP_3 / SUP_04 / SUP_05) are supplier
// documents and are not committed: RENSON_DOCS_TXT=<dir with d1..d5.txt>.
const RDOC = `Order confirmation
 Renson NV •  IZ 2 Vijverdam • Maalbeekstraat 10 • B-8790 Waregem
 13.06.2025 Confirmation date
 167012 Order number
 EUR Currency
 June 2025 - Renson Stock Order reference
 Overview
 Material  Quantity  Total net  VAT
 001000  25089  BACK COVER SQUARE 4M ALU FE100  60,00  PC  3.000,00
 002000  22034  DIN912TX-M4X25-A2  3,00  CAR  148,50
 003000  2405  SPLINE Ø 6 MM - 250 M  2,00  ROL  156,00
 004000  19489  ROLL SERGÉ GV-0707 - B 3200 MM (30 M)
 1,00  M  1.112,64
 005000  15130  DOUBLE SIDED TAPE 9MM ROLL  4,00  ROL  104,46
 903000  1000017  PICKUP FEE  1,00  PC  100,00
 4.621,60 Total before VAT
 Detail
 002000  22034  3,00  CAR  330,00  148,50
 DIN912TX-M4X25-A2
 G0004395 Old material nr
 Product price  0,11  EUR  /  1  PC  330,00
 003000  2405  2,00  ROL  312,00  156,00
 SPLINE Ø 6 MM - 250 M
 Product price  156,00  EUR  /  1  ROL  312,00
 005000  15130  4,00  ROL  208,92  104,46
 DOUBLE SIDED TAPE 9MM ROLL
 Product price  52,23  EUR  /  1  ROL  208,92
 903000  1000017  1,00  PC  100,00  100,00
 Pickup Fee
 Price service  100,00  EUR  /  1  PC  100,00  100,00`;

t("Renson documents: detected, read, totals, cartons / rolls / fabric / fees", () => {
  assert.strictEqual(R.isRensonDocument(RDOC), true);
  assert.strictEqual(R.isRensonDocument(" R e n s on  N V  •  I Z  2"), true);          // spaced-out footer (macOS print)
  assert.strictEqual(R.isRensonDocument("Freedom Screens of Australia Pty Ltd ABN 12"), false);
  const d = JSON.parse(JSON.stringify(R.readRensonDocument(RDOC)));
  assert.deepStrictEqual([d.head.docType, d.head.number, d.head.isoDate, d.head.currency, d.head.orderRef, d.head.totalBeforeVat, d.head.charges],
    ["Order confirmation", "167012", "2025-06-13", "EUR", "June 2025 - Renson Stock", 4621.6, 100]);
  assert.strictEqual(d.totalMatches, true);
  assert.deepStrictEqual(d.items.map((i) => [i.code, i.qty, i.unit, i.net, i.charge]), [
    ["25089", 60, "PC", 3000, false], ["22034", 3, "CAR", 148.5, false], ["2405", 2, "ROL", 156, false],
    ["19489", 1, "M", 1112.64, false],                                       // line split in two by the PDF, joined
    ["15130", 4, "ROL", 104.46, false], ["1000017", 1, "PC", 100, true]]);   // Pickup Fee = a charge
  const q = (code) => { const r = R.rensonStockQty(d.items.find((i) => i.code === code)); return r.ask ? "ask " + r.ask : r.qty + " " + r.unit; };
  assert.strictEqual(q("25089"), "60 pc");
  assert.strictEqual(q("22034"), "3000 pc");     // 330 gross / 0.11 per PC
  assert.strictEqual(q("2405"), "500 m");        // 2 rolls x 250 m (from the name)
  assert.strictEqual(q("19489"), "ask metres");  // fabric "M" line: asked (user's answer)
  assert.strictEqual(q("15130"), "ask metres");  // roll with no length stated: asked, never guessed
});

if (process.env.RENSON_DOCS_TXT) {
  t("the real Renson documents", () => {
    const want = { 1: [1, 1736.91], 2: [1, 1112.64], 3: [2, 2193.35], 4: [48, 56306.19], 5: [58, 45792.52] };
    for (const k of Object.keys(want)) {
      const d = R.readRensonDocument(fs.readFileSync(`${process.env.RENSON_DOCS_TXT}/d${k}.txt`, "utf8"));
      assert.deepStrictEqual([d.items.length, d.head.totalBeforeVat, d.totalMatches], [want[k][0], want[k][1], true], "doc " + k);
    }
    console.log("  real Renson documents: all 5 read, every total matches");
  });
}

console.log(`renson: ${n} tests passed`);
