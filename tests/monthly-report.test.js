// Pure part of the monthly report (supabase/functions/monthly-report/report.js).
// Needs xlsx-js-style for the workbook checks: XLSX_PATH=<dir of xlsx-js-style>
// (skipped without it). Run: node tests/monthly-report.test.js
const assert = require("assert");
const path = require("path");

(async () => {
  const R = await import(path.join(__dirname, "../supabase/functions/monthly-report/report.js"));

  // Period: the month before, in Dubai time (UTC+4, no DST).
  let p = R.reportPeriod(new Date("2026-12-01T02:00:00Z")); // 06:00 Dubai, 1 Dec
  assert.equal(p.key, "2026-11"); assert.equal(p.label, "November 2026");
  assert.equal(p.start.toISOString(), "2026-10-31T20:00:00.000Z");
  assert.equal(p.end.toISOString(), "2026-11-30T20:00:00.000Z");
  p = R.reportPeriod(new Date("2027-01-01T02:00:00Z")); assert.equal(p.key, "2026-12");
  // 31 Dec 22:00 UTC is already 1 Jan in Dubai -> report = December
  p = R.reportPeriod(new Date("2026-12-31T22:00:00Z")); assert.equal(p.key, "2026-12");
  p = R.reportPeriod(new Date(), "2026-10"); assert.equal(p.label, "October 2026");
  assert.throws(() => R.reportPeriod(new Date(), "2026-13"));

  // Lines: direction, manual corrections, Renson signs from qty before/after
  const fo = R.freedomLine({ id: 1, type: "check_out", created_at: "2026-10-07T06:42:11Z", job_number: "26391", client: "C", item_code: "X", quantity: 2, value: 4.22, unit_cost_used: 2.11 });
  assert.deepEqual([fo.kind, fo.ref, fo.party, fo.qty, fo.value], ["Check-out", "26391", "C", -2, -4.22]);
  const fa = R.freedomLine({ id: 2, type: "check_in", supplier: "Manual correction", invoice_number: "Stock count", quantity: 13, value: 10 });
  assert.equal(fa.kind, "Adjustment (+)");
  const items = new Map([["7", { description: "Bar", unit: "bar" }]]);
  const ro = R.rensonLine({ id: 9, item_id: 7, type: "check_out", qty_before: 10, qty_after: 8, value: 306, job_number: "24222R" }, items);
  assert.deepEqual([ro.kind, ro.qty, ro.value, ro.description, ro.unit], ["Check-out", -2, -306, "Bar", "bar"]);
  const ra = R.rensonLine({ id: 10, item_id: 7, type: "adjustment", qty_before: 8, qty_after: 5, value: -459, reference: "Stock count", reason: "Nov count" }, items);
  assert.deepEqual([ra.kind, ra.qty, ra.value, ra.ref], ["Adjustment (-)", -3, -459, "Stock count: Nov count"]);

  // Summary: documents = same reference at the same minute
  const s = R.summarise([fo, { ...fo, id: "x" }, fa]);
  assert.deepEqual([s["Check-out"].docs, s["Check-out"].lines, s["Check-out"].value], [1, 2, -8.44]);
  assert.equal(s["Adjustment (+)"].lines, 1);

  const xp = process.env.XLSX_PATH;
  if (!xp) { console.log("monthly-report: workbook checks skipped (set XLSX_PATH)"); return; }
  const XLSX = require(xp);
  const { wb, totals } = R.buildWorkbook(XLSX, { period: R.reportPeriod(new Date(), "2026-11"), preparedAt: "2026-12-01 06:00 (Dubai)",
    inventories: [{ name: "Freedom", lines: [fo, fa], opening: 785523.37, closing: 780000 }, { name: "Renson", lines: [ro, ra], opening: null, closing: 160000 }],
    notes: ["n1"] });
  assert.deepEqual(wb.SheetNames, ["Summary", "Freedom transactions", "Renson transactions"]);
  const sum = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
  assert.equal(sum[0][0], "Oryx stock movements — November 2026");
  assert.ok(sum.some((r) => r[0] === "Total" && r[2] === "not recorded" && r[4] === 940000), "totals: start unknown (Renson), end 940,000");
  const fr = XLSX.utils.sheet_to_json(wb.Sheets["Freedom transactions"], { header: 1 });
  assert.equal(fr.length, 4); // head + 2 lines + total
  assert.equal(fr[1][0], "2026-10-07 10:42"); // Dubai time
  assert.equal(fr[3][9], Math.round((-4.22 + 10) * 100) / 100);
  assert.equal(totals.find((t) => t.name === "Renson").sum["Check-out"].lines, 1);
  const empty = R.buildWorkbook(XLSX, { period: R.reportPeriod(new Date(), "2026-10"), preparedAt: "x",
    inventories: [{ name: "Renson", lines: [], opening: null, closing: null, note: "No Renson movements in this month." }] });
  assert.equal(XLSX.utils.sheet_to_json(empty.wb.Sheets["Renson transactions"], { header: 1 })[1][0], "No Renson movements in this month.");
  const html = R.emailHtml({ period: R.reportPeriod(new Date(), "2026-11"), inventories: [{ name: "Freedom", closing: 1 }], totals: [{ name: "Freedom", sum: s }] });
  assert.ok(/November 2026/.test(html) && /AED 8\.44/.test(html));
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  assert.ok(buf.length > 1000);
  console.log("monthly-report tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
