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

console.log(`renson: ${n} tests passed`);
