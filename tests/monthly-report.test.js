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

  // Microsoft Graph sendMail body
  const gm = R.graphMessage({ to: ["a@x.com", "b@y.com"], subject: "S", html: "<p>h</p>", fileName: "f.xlsx", contentBase64: "QUJD" });
  assert.deepEqual(gm.message.toRecipients, [{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@y.com" } }]);
  assert.equal(gm.message.body.contentType, "HTML");
  assert.equal(gm.message.attachments[0]["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(gm.message.attachments[0].contentBytes, "QUJD");
  assert.equal(gm.saveToSentItems, true);

  // Materials in transit: open POs only, outstanding x price x rate; Pending QC apart
  const tOrders = [
    { id: 1, po_number: "PO26-2106", quote_ref: "S00231", supplier: "Freedom Screens Global", supplier_group: "Freedom", delivery_status: "partially_received", payment_status: "tbc", currency: "USD", rate_to_aed: 3.6725 },
    { id: 2, po_number: "R-1", supplier: "Renson NV", supplier_group: "Renson", delivery_status: "pending_qc", payment_status: "paid", currency: "EUR", rate_to_aed: 4 },
    { id: 3, po_number: "OLD", supplier: "X", supplier_group: "Other", delivery_status: "completed", currency: "AED", rate_to_aed: 1 },
  ];
  const tLines = [
    { order_id: 1, item_code: "310028", description: "Track", qty_ordered: 10, qty_received: 4, qty_cancelled: 0, qty_pending: 6, unit_price: 31.5 },
    { order_id: 1, item_code: "J", description: "Jig", qty_ordered: 4, qty_received: 0, qty_cancelled: 0, qty_pending: 4, unit_price: null },
    { order_id: 2, item_code: "22874", description: "Bar", qty_ordered: 20, qty_received: 15, qty_cancelled: 0, qty_pending: 5, unit_price: 40 },
    { order_id: 3, item_code: "Z", description: "Done", qty_ordered: 1, qty_received: 1, qty_cancelled: 0, qty_pending: 0, unit_price: 9 },
  ];
  const tr = R.transitSummary(tOrders, tLines);
  assert.deepEqual(tr.pos.map((p) => p.po), ["PO26-2106", "R-1"], "completed PO left out");
  assert.equal(tr.totalAed, Math.round((6 * 31.5 * 3.6725 + 5 * 40 * 4) * 100) / 100);
  assert.deepEqual([tr.byGroup.Freedom.pos, tr.byGroup.Renson.value, tr.pendingQc.pos, tr.pendingQc.receivedAed], [1, 800, 1, 2400]);
  assert.ok(tr.pos[0].noPrice);

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
  // with materials in transit: Summary section + its own sheet, PO / quote highlighted
  const wt = R.buildWorkbook(XLSX, { period: R.reportPeriod(new Date(), "2026-11"), preparedAt: "2026-12-01 06:00 (Dubai)",
    inventories: [{ name: "Freedom", lines: [fo], opening: 1, closing: 783163.88 }], transit: tr });
  assert.deepEqual(wt.wb.SheetNames, ["Summary", "Freedom transactions", "Materials in transit"]);
  const ts = XLSX.utils.sheet_to_json(wt.wb.Sheets.Summary, { header: 1 });
  assert.ok(ts.some((r) => r[1] === "PO26-2106 / S00231" && r[3] === 2 && r[4] === Math.round(6 * 31.5 * 3.6725 * 100) / 100));
  assert.ok(ts.some((r) => r[0] === "Total in transit" && r[4] === tr.totalAed));
  assert.ok(ts.some((r) => r[0] === "Closing stock value (excluding materials in transit)" && r[4] === 783163.88));
  assert.ok(ts.some((r) => /^Pending QC: 1 PO\(s\), AED 2,400\.00/.test(r[0] || "")));
  const poCell = Object.keys(wt.wb.Sheets.Summary).find((k) => wt.wb.Sheets.Summary[k].v === "PO26-2106 / S00231");
  assert.equal(wt.wb.Sheets.Summary[poCell].s.fill.fgColor.rgb, "FFF2A8");
  const tsh = XLSX.utils.sheet_to_json(wt.wb.Sheets["Materials in transit"], { header: 1 });
  assert.equal(tsh.length, 1 + 3 + 1); assert.equal(tsh[tsh.length - 1][16], tr.totalAed);
  assert.ok(new RegExp("Materials in transit .*AED " + tr.totalAed.toLocaleString("en-US", { minimumFractionDigits: 2 }).replace(/[.]/g, "\\.")).test(R.emailHtml({ period: R.reportPeriod(new Date(), "2026-11"), inventories: [{ name: "Freedom", closing: 1 }], totals: [{ name: "Freedom", sum: s }], transit: tr }).replace(/<[^>]+>/g, "")));
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  assert.ok(buf.length > 1000);
  console.log("monthly-report tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
