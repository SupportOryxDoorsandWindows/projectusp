// Delivery notes (delivery-notes.js, window.ORYX_DN_CORE): reading an FP Pro
// job list and building the powder coating + finished goods notes. The
// job-list text below is made up in FP Pro's layout (the real job lists are
// customer documents and are not committed); the counts were checked against
// the user's real job lists 26273F / 26294F / 26371F / 26052 / 082426.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("delivery-notes.js", "utf8"), context);
const C = context.window.ORYX_DN_CORE;
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- bar groups come from FP Pro's own bar code ----
const g = (code, desc) => C.barGroup(code, desc || "");
assert.equal(g("80-IS", "310016-ZLS1 Housing 80 IS 01 MILL"), "HOUSING");
assert.equal(g("70", "310010/310013-ZLS1 Housing 70 IS/OS 01 MILL"), "HOUSING");
assert.equal(g("ZLX_80-OS", "630103-IZLX Housing OS (Mill, 80)"), "HOUSING");
assert.equal(g("SMB_60-IS", "Freedom SMB Housing - 60 (IS)"), "HOUSING");
assert.equal(g("RECIEVER"), "RECEIVER"); // FP Pro's own spelling
assert.equal(g("DRAWBAR"), "DRAWBAR");
assert.equal(g("SMB_DRAWBAR"), "DRAWBAR");
assert.equal(g("TOP_TRACK"), "TRACK");
assert.equal(g("BOTTOM_TRACK"), "TRACK");
assert.equal(g("SMB_TRACK_FIXE"), "TRACK");
assert.equal(g("RECESS_CHANNEL"), "RECESS CHANNEL");
assert.equal(g("TRACK_FILLER", "630148-IZLX Cover Strip Track UL (Mill, IZLX)"), "TRACK FILLER");
assert.equal(g("15X30", "Box Section 15x30"), "BOX SECTION");
assert.equal(g("MAGNET_HOLDER"), null, "not coated");
assert.equal(g("ROLLER_TUBE"), null, "not coated");
assert.equal(g("MOHAIR_HOLDER"), null, "not coated");
assert.equal(g("SMB_ROLLER_TUB"), null, "not coated");
assert.equal(g("WEIRD_PART", "Something new"), "?", "unknown bars are flagged, never guessed");

// ---- bars section ----
const barsText = [
  "Bars Optimization Report (1 of 2)",
  "Serie:  FLYSCREEN  Code:  80-IS  Bars:  2 x 2500",
  "Treatement:",
  "Description:  310016-ZLS1 Housing 80 IS 01 MILL",
  "Total length:  5 m  Total Weight:  0 kg",
  "Serie:  FLYSCREEN  Code:  15X30  Bars:  5 x 6000",
  "Description:  Box Section 15x30",
  "Serie:  FLYSCREEN  Code:  ROLLER_TUBE  Bars:  1 x 5800",
  "Description:  110001-Roller Tube 35 5.1M",
].join("\n");
assert.deepEqual(plain(C.parseBarsSection(barsText)), [
  { fpCode: "80-IS", bars: 2, lenMm: 2500, description: "310016-ZLS1 Housing 80 IS 01 MILL" },
  { fpCode: "15X30", bars: 5, lenMm: 6000, description: "Box Section 15x30" },
  { fpCode: "ROLLER_TUBE", bars: 1, lenMm: 5800, description: "110001-Roller Tube 35 5.1M" },
]);

// ---- fittings: only coating-list accessories, in pieces, count as COMPONENTS ----
const fits = C.parseFittingLines([
  "ORYX  630003-IZLX-HANDLE-MILL-A - MILL  2  630003-IZLX Handle Mill A",
  "ORYX  330099- ZLX-RECESS-END-CAP-10  2  330099- ZLX-RECESS End Cap-100-A-01",
  "ORYX  133011-SAFETY-DOTS  20  Safety Dots",
  "ORYX  30012-MULTI-ZIPPER  8.12 m  Multi Zipper SLF Chain P16 FCS 12",
]);
assert.deepEqual(plain(fits.map((f) => [f.code, f.qty, f.unit])), [["630003", 2, "pcs"], ["330099", 2, "pcs"], ["133011", 20, "pcs"], ["30012", 8.12, "m"]]);

// ---- one finished item block ----
const item = C.parseItemBlock([
  "Item: 1  FREEDOM ZLX 80 -", "RIGHT, Standard Track,", "NEW", "View:  Internal", "Type:  D01A",
  "Qty: 1, Dimension (WxH): 4210x2350", "Location:  D01A - Fusion Series 2", "Sliding Door - Living area Totals Area: 17.35 mq",
]);
assert.deepEqual(plain(item), { n: 1, type: "D01A", product: "FREEDOM ZLX 80 - RIGHT, Standard Track, NEW",
  location: "D01A - Fusion Series 2 Sliding Door - Living area", qty: 1, size: "4210 × 2350" });

// ---- the two notes for a job like 26371F (Monique Hageman, DN-5470) ----
const job = {
  job: "26371F", client: "Monique Hageman", colours: [],
  finished: [
    { n: 1, product: "FREEDOM ZLX 80 - RIGHT, Standard Track, NEW", location: "D01A - Fusion Series 2 Sliding Door - Living area", qty: 1, size: "4210 × 2350" },
    { n: 2, product: "FREEDOM ZLX 80 - LEFT, Standard Track, NEW", location: "D01B - Fusion Series 2 Sliding Door - Bedroom", qty: 1, size: "3169 × 2354" },
  ],
  bars: [
    { fpCode: "15X30", bars: 5, lenMm: 6000, description: "Box Section 15x30" },
    { fpCode: "20X40", bars: 1, lenMm: 6000, description: "Box Section 20x40" },
    { fpCode: "80-IS", bars: 2, lenMm: 2500, description: "310016-ZLS1 Housing 80 IS 01 MILL" },
    { fpCode: "DRAWBAR", bars: 2, lenMm: 2500, description: "310022-ZLS1 Drawbar MILL" },
    { fpCode: "MOHAIR_HOLDER", bars: 1, lenMm: 5100, description: "620001 - Mohair Holder" },
    { fpCode: "RECIEVER", bars: 1, lenMm: 5100, description: "310025-ZLS1 Receiver 01 MILL" },
    { fpCode: "ROLLER_TUBE", bars: 1, lenMm: 5800, description: "110001-Roller Tube 35 5.1M" },
    { fpCode: "TOP_TRACK", bars: 4, lenMm: 5800, description: "310028-ZLS1 Track 01 MILL" },
    { fpCode: "TRACK_FILLER", bars: 4, lenMm: 6000, description: "630148-IZLX Cover Strip Track UL (Mill, IZLX)" },
    { fpCode: "ZLX_80-OS", bars: 1, lenMm: 5100, description: "630103-IZLX Housing OS (Mill, 80)" },
  ],
  fittings: [
    { code: "630003", qty: 2, unit: "pcs" }, { code: "630007", qty: 2, unit: "pcs" }, { code: "630012", qty: 2, unit: "pcs" },
    { code: "630016", qty: 2, unit: "pcs" }, { code: "630060", qty: 2, unit: "pcs" }, { code: "630061", qty: 2, unit: "pcs" },
    { code: "630001", qty: 2, unit: "pcs" }, // handle bush: not on the coating list
    { code: "910010", qty: 8.12, unit: "m" },
  ],
};
const notes = C.buildNotes(job);
assert.deepEqual(plain(notes.pcLines.map((l) => [l.description, l.qty])), [
  ["HOUSING", 3], ["RECEIVER", 1], ["DRAWBAR", 2], ["TRACK", 4], ["TRACK FILLER", 4], ["BOX SECTION", 6], ["COMPONENTS", 12],
], "same part types and counts as the coating notes");
assert.equal(notes.left.length, 2, "Mohair Holder + Roller Tube left off");
assert.deepEqual(plain(notes.fgLines), [
  { description: "D01A - Fusion Series 2 Sliding Door - Living area\nFREEDOM ZLX 80 - RIGHT, Standard Track, NEW · 4210 × 2350", qty: 1, comments: "15X30, 20X40 Box section" },
  { description: "D01B - Fusion Series 2 Sliding Door - Bedroom\nFREEDOM ZLX 80 - LEFT, Standard Track, NEW · 3169 × 2354", qty: 1, comments: "15X30, 20X40 Box section" },
], "like DN-5470: one line per screen, box sections in the comments");
assert.deepEqual(plain(notes.flags), ["No RAL code on the job list — type it in."]);
assert.equal(notes.colour, "");

// Unknown bars and colours are flagged, never guessed.
const odd = C.buildNotes({ ...job, colours: ["RAL9010", "RAL7016"], bars: [{ fpCode: "NEW_PART", bars: 1, lenMm: 6000, description: "Something new" }], fittings: [], finished: [] });
assert.equal(odd.pcLines.length, 0);
assert.equal(odd.unknown.length, 1);
assert.ok(odd.flags.some((f) => /More than one colour/.test(f)));
assert.ok(odd.flags.some((f) => /not recognised/.test(f)));
assert.ok(odd.flags.some((f) => /No finished items/.test(f)));
assert.equal(odd.colour, "", "two colours: none is picked");
assert.equal(C.buildNotes({ ...job, colours: ["RAL9010"] }).colour, "RAL9010");

// ---- the checks before Confirm (same as confirm_delivery_note on the server) ----
const draft = { kind: "powder_coating", delivery_address: "ALUMETAL", delivered_by: "", delivery_date: "", ral_code: "", lines: [{ description: "HOUSING", qty: 3 }, { description: "", qty: 0 }] };
assert.deepEqual(C.problems(draft), ["Type the RAL code.", "Fill in who delivers it (Delivered by).", "Fill in the delivery date.",
  "Line 2: add a description.", "Line 2: the quantity must be more than 0."]);
assert.deepEqual(C.problems({ ...draft, kind: "finished_goods", delivered_by: "Ashok", delivery_date: "2026-10-27", lines: [{ description: "x", qty: 1 }] }), [], "finished goods need no RAL code");
assert.deepEqual(plain(C.fieldsOf({ ...draft, lines: [{ description: "HOUSING", qty: "3", comments: undefined }], extra: "dropped" })), {
  delivery_address: "ALUMETAL", contact_no: "", secondary_contact_no: "", delivered_by: "", customer_ref: "", ral_code: "", delivery_date: "",
  lines: [{ description: "HOUSING", qty: 3, comments: "" }],
});

// ---- printed note ----
assert.equal(C.fmtDate("2026-10-27"), "27-Oct-2026");
assert.equal(C.fmtDate(""), "");
const sheet = C.sheetHtml({ kind: "powder_coating", job_number: "26371F", customer_ref: "<b>x</b>", ral_code: "REL7006M SD3000700634", delivery_date: "2026-10-27", dn_number: "DN-SF-0001", lines: [{ description: "HOUSING", qty: 3 }] });
assert.ok(sheet.includes("POWDER COATING") && sheet.includes("DN-SF-0001") && sheet.includes("27-Oct-2026"));
assert.ok(sheet.includes("REL7006M SD3000700634"), "RAL code in the Comments column");
assert.ok(sheet.includes("&lt;b&gt;x&lt;/b&gt;") && !sheet.includes("<b>x</b>"), "text is escaped");
assert.ok(!sheet.includes("DRAFT"), "a confirmed note has no draft stamp");
assert.ok(C.sheetHtml({ kind: "finished_goods", lines: [] }).includes("DRAFT"), "an unconfirmed note is marked DRAFT");

console.log("delivery-notes tests passed");
