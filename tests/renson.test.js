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

console.log(`renson: ${n} tests passed`);
