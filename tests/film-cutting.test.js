// Film Cutting (film-cutting.js, window.ORYX_CUT_CORE): reading the job
// list, the cutting rules and the plan check. The rows below are made up in
// the layout of the Etihad Rail smart-film list (SSF2026-225 ER AUH1.xlsx is
// a customer file and is not committed). The rule (2026-10-29): used width
// = panel widths + ONE allowance per cut (default 20 mm), never more than
// the roll (1000 / 1200 / 1500 / 1800). On that real file with 20 mm: By
// level 573.73 m2 / 157 cuts, By location 598.15 / 187. (Before, with a
// 1 mm blade between panels: 566.762 / 154 and 591.717 / 187, the same as
// an independent check in Python, pulp/CBC.)
//
// The calculation itself needs the HiGHS solver (npm package "highs"); those
// tests run when it can be loaded (npm i highs@1.15.3, or HIGHS_PATH=<dir>
// of node_modules/highs) and are skipped with a note otherwise.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.runInNewContext(fs.readFileSync("film-cutting.js", "utf8"), context);
const C = context.window.ORYX_CUT_CORE;
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- reading the sheet ----
const H = ["Ref #", "Location", null, "Width (mm)", "Height (mm)", "SQM", "Qty", "Total Sqm"];
const grid = [
  [null, null, null, null, null, null, null, null, null, "=sum"],
  [],
  H,
  [1, "Room A", "Door", 775, 2500, 1.9, 1, 1.9],     // row 4
  [null, null, "Door", 775, 2500, 1.9, 1, 1.9],
  [null, null, null, 920, 2680, 2.4, 2, 4.9],
  [2, "Room B - completed", "Door", 775, 2505, 1.9, null, 0], // no qty: left out
  [null, null, null, 1080, 2680, 2.9, 1, 2.9],
  [null, null, "Curve", 1040, 2680, 2.8, 2, 5.6],    // row 9
  [12, null, null, null, null, null, "=SUM", "=SUM"], // sub-total row
  [],
  ["LEVEL 6"],                                       // row 12
  [1, "Room C", null, 900, 2680, 2.4, 3, 7.2],
  [null, null, null, 890, 2680, 2.4, 1, 2.4],
  [2, "Room D", null, 1900, 2680, 5, 1, 5],          // wider than any roll
  ["TOTAL # of FILMS", null, null, null, null, null, 99],
];
const read = C.readSheet(grid, "ETIHAD RAIL");
assert.deepEqual(plain(read.levels), ["Level 5", "Level 6"]);
assert.equal(read.pieces.length, 1 + 1 + 2 + 1 + 2 + 3 + 1 + 1, "Qty n gives n pieces");
assert.deepEqual(plain(read.pieces.map((p) => p.id)).slice(0, 3), ["P001", "P002", "P003"]);
const p3 = read.pieces[2];
assert.equal(p3.level, "Level 5", "rows above the first LEVEL row");
assert.equal(p3.ref, "1"); assert.equal(p3.loc, "Room A"); assert.equal(p3.w, 920); assert.equal(p3.h, 2680);
assert.equal(p3.row, 6); assert.equal(p3.of, "1 of 2");
assert.equal(read.pieces[4].ref, "2", "ref carried down"); assert.equal(read.pieces[4].loc, "Room B - completed");
assert.equal(read.pieces[5].type, "Curve", "type column without a header (column C)");
assert.ok(read.pieces.every((p) => p.ref !== "12"), "a sub-total row is not a room");
const L6 = read.pieces.filter((p) => p.level === "Level 6");
assert.equal(L6.length, 5);
const kinds = read.issues.map((i) => i.kind + " " + i.title);
assert.ok(kinds.some((k) => /^LEFT OUT Row 7 · Level 5 · Ref 2 Room B - completed – Door 775 × 2505 mm/.test(k)), kinds.join("\n"));
assert.ok(kinds.some((k) => /^CHECK Rows 4–9 have no LEVEL row above them: called "Level 5"/.test(k)), kinds.join("\n"));
assert.ok(kinds.some((k) => /^CHECK Level 5 · Ref 2 is named "Room B - completed" but still has 3 panels$/.test(k)), kinds.join("\n"));
assert.ok(kinds.some((k) => /^CHECK 2 curved panels \(row 9\)/.test(k)), kinds.join("\n"));
assert.ok(!kinds.some((k) => /^ERROR/.test(k)));

// Bad rows are errors (never planned, never guessed).
const bad = C.readSheet([H,
  [1, "R", null, "9OO", 2680, 0, 1, 0],
  [null, null, null, 900, -5, 0, 1, 0],
  [null, null, null, 900, 2680, 0, 1.5, 0],
  [null, null, null, 900, 2680, 0, -1, 0],
  [null, null, null, 900.5, 2680, 0, 1, 0],
  [null, null, null, 900, 2680, 0, "two", 0],
  [null, null, null, 900, 2680, 0, 1, 0],
]);
assert.equal(bad.pieces.length, 1);
assert.equal(bad.issues.filter((i) => i.kind === "ERROR").length, 6, plain(bad.issues).map((i) => i.title).join("\n"));
assert.equal(bad.pieces[0].level, "No level");
assert.equal(C.readSheet([], "x").issues[0].kind, "ERROR");
assert.equal(C.readSheet([["a", "b"], [1, 2]]).issues[0].title, 'No header row with "Width" and "Height" found');
assert.ok(C.readSheet([["Width", "Height"], [900, 2680]]).issues.some((i) => /No "Qty" column/.test(i.title)));

// A piece list (one row per piece: the cutting workbook's "Piece references"
// or this page's own export): IDs and file rows kept as they are.
const PL = ["Piece", "Level", "Ref", "Location", "Type", "Width (mm)", "Height (mm)", "File row"];
const plist = C.readSheet([[], PL,
  ["P001", "Level 6", 13, "Project Meeting Room C", null, 950, 2680, 5],
  ["P002", "Level 6", 13, "Project Meeting Room C", "Door", 775, 2515, 10],
  ["P003", "Level 6", null, null, null, 830, 2680, 8],
  ["P004", "Level 6", 14, "Room B", null, "", 2680, 12],          // no width: error
  ["P001", "Level 6", 14, "Room B", null, 245, 2680, 13],         // duplicate ID: error
  [null, "Level 6", 14, "Room B", null, 245, 2680, 14],           // no ID: error
  ["P007", null, 14, "Room B", null, 245, 2680, 15],              // no level
]);
assert.deepEqual(plain(plist.pieces.map((p) => [p.id, p.level, p.ref, p.loc, p.type, p.w, p.h, p.srcRow, p.row])), [
  ["P001", "Level 6", "13", "Project Meeting Room C", "", 950, 2680, 5, 3],
  ["P002", "Level 6", "13", "Project Meeting Room C", "Door", 775, 2515, 10, 4],
  ["P003", "Level 6", "", "", "", 830, 2680, 8, 5],
  ["P007", "No level", "14", "Room B", "", 245, 2680, 15, 9],
]);
const plk = plist.issues.map((i) => i.kind + " " + i.title);
assert.ok(plk.some((k) => /^ERROR Row 6 · P004: width or height is missing/.test(k)), plk.join("\n"));
assert.ok(plk.some((k) => /^ERROR Row 7 · P001: piece ID P001 is used twice \(also row 3\)/.test(k)), plk.join("\n"));
assert.ok(plk.some((k) => /^ERROR Row 8: no piece ID/.test(k)), plk.join("\n"));
assert.ok(plk.some((k) => /^CHECK 1 panel has no level \(P007\)/.test(k)), plk.join("\n"));
assert.ok(plk.some((k) => /^CHECK 1 panel has no Ref # \(P003\)/.test(k)), plk.join("\n"));
assert.ok(plk.some((k) => /^CHECK 1 panel has no location \(P003\)/.test(k)), plk.join("\n"));
// The workbook's sheet lists the same panels once per rule: read once.
const RH = ["Rule", "Cut ID", "Piece ID", "Level", "Ref #", "Location", "Width (mm)", "Height (mm)", "Source sheet", "Source row"];
const ruled = C.readSheet([RH, ["By level", "L001", "P001", "Level 5", 1, "A", 900, 2680, "LEVEL 5", 4], ["By level", "L002", "P002", "Level 5", 1, "A", 800, 2680, "LEVEL 5", 5],
  ["Whole job", "J001", "P002", "Level 5", 1, "A", 800, 2680, "LEVEL 5", 5], ["Whole job", "J001", "P001", "Level 5", 1, "A", 900, 2680, "LEVEL 5", 4]]);
assert.deepEqual(plain(ruled.pieces.map((p) => [p.id, p.srcRow])), [["P001", 4], ["P002", 5]]);
assert.ok(ruled.issues.some((i) => i.kind === "INFO" && /once per rule/.test(i.title)));
const ruledBad = C.readSheet([RH, ["By level", "L001", "P001", "Level 5", 1, "A", 900, 2680, "", 4], ["Whole job", "J001", "P001", "Level 5", 1, "A", 901, 2680, "", 4]]);
assert.equal(ruledBad.pieces.length, 0); assert.equal(ruledBad.issues[0].kind, "ERROR");

// ---- cutting rules ----
// The prompt's example: 950 + 830 + 20 = 1800 fits the 1800 roll (0 spare);
// with 30 mm it is 1810 and does not.
assert.equal(C.across([950, 830], 20), 1800);
assert.equal(C.across([950, 830], 30), 1810);
assert.equal(C.across([950], 20), 970, "a single panel gets the allowance too");
const fitsOn = (ws, a) => C.patterns(ws, [1000, 1200, 1500, 1800], a, false).filter((p) => Object.keys(p.pat).length === Object.keys(ws).length && Object.keys(ws).every((w) => p.pat[w] === ws[w])).map((p) => p.W);
assert.deepEqual(fitsOn({ 950: 1, 830: 1 }, 20), [1800], "1800 needed, 1800 roll");
assert.deepEqual(fitsOn({ 950: 1, 830: 1 }, 30), [], "1810 needed: no standard roll");
assert.deepEqual(fitsOn({ 950: 1 }, 20), [1000], "smallest roll that fits: 970 -> 1000");
assert.deepEqual(fitsOn({ 1000: 1 }, 20), [1200], "1000 + 20 = 1020 -> 1200, never squeezed onto 1000");
assert.deepEqual(fitsOn({ 1000: 1 }, 0), [1000]);
// Only "full" patterns (nothing else fits beside them on that roll).
assert.deepEqual(plain(C.patterns({ 400: 2 }, [1000], 20, false).map((p) => p.pat)), [{ 400: 2 }], "one 400 alone is not full");
// "any": a pattern may also be cut from a wider roll (needed with stock).
assert.deepEqual(plain(C.patterns({ 900: 1 }, [1000, 1200], 20, true).map((p) => p.W)), [1000, 1200]);
// The allowance as typed.
assert.deepEqual(plain(C.checkAllowance("20")), { ok: true, value: 20 });
assert.deepEqual(plain(C.checkAllowance(" 25 ")), { ok: true, value: 25 });
assert.deepEqual(plain(C.checkAllowance("0")), { ok: true, value: 0 });
assert.deepEqual(plain(C.checkAllowance("22.5")), { ok: true, value: 22.5 });
for (const bad of ["-5", "", "abc", "20mm", "1e2", "2.25", "600", null]) assert.equal(C.checkAllowance(bad).ok, false, "rejected: " + bad);
assert.deepEqual(plain(C.ROLLS), [1000, 1200, 1500, 1800]);
// Production order: the team's order, other widths after.
assert.deepEqual(plain(C.batchOrder({ rolls: [1000, 1200, 1500, 1800, 2000], order: [1000, 1200, 1800, 1500] })), [1000, 1200, 1800, 1500, 2000]);
assert.deepEqual(plain(C.batchOrder({ rolls: [1000, 1500], order: [1000, 1200, 1800, 1500] })), [1000, 1500]);

// LP text for HiGHS.
const m = C.buildModel(C.groupsOf([{ id: "P1", level: "L", w: 950, h: 2000 }, { id: "P2", level: "L", w: 830, h: 2000 }], "level"), Object.assign({}, C.DEFAULTS), null);
const text = C.lpText(m);
assert.equal(text, "Minimize\n film: 2000000001 x0_0 + 2000000001 x0_1 + 3600000001 x0_2\nSubject To\n d0_830: 1 x0_0 + 1 x0_2 >= 1\n d0_950: 1 x0_1 + 1 x0_2 >= 1\nGeneral\n x0_0 x0_1 x0_2\nEnd\n");
assert.ok(!/General/.test(C.lpText(m, true)));
assert.deepEqual(plain(C.fromHighs({ Status: "Optimal", ObjectiveValue: 5, Columns: { a: { Primal: 2 } } })), { status: "optimal", values: { a: 2 }, objective: 5, raw: "Optimal" });
assert.equal(C.fromHighs({ Status: "Time limit reached", ObjectiveValue: 5, Columns: { a: { Primal: 2 } } }).status, "feasible");
assert.equal(C.fromHighs({ Status: "Time limit reached", ObjectiveValue: Infinity, Columns: {} }).status, "none");
assert.equal(C.fromHighs({ Status: "Infeasible", Columns: {} }).status, "infeasible");

// ---- placing cuts on real rolls: a cut never runs across two rolls ----
const cuts3 = () => [{ id: "a", W: 1000, L: 2680 }, { id: "b", W: 1000, L: 2680 }, { id: "c", W: 1000, L: 2680 }];
const pl = C.placeOnRolls(cuts3(), { 1000: [5, 5.3] });
assert.equal(pl.ok, false, "10.3 m in all, but each roll only takes one 2.68 m cut");
assert.deepEqual(plain(pl.rolls[1000].map((r) => r.cuts.length)), [1, 1]);
assert.equal(pl.short[1000], 2.68);
const pl2 = C.placeOnRolls(cuts3(), { 1000: [5, 5.4] });
assert.equal(pl2.ok, true, "5.4 m takes two");
assert.deepEqual(plain(pl2.rolls[1000].map((r) => r.cuts.length)), [1, 2]);

// ---- verifyPlan catches a wrong plan ----
const pcs = [
  { id: "P1", level: "Level 5", ref: "1", w: 900, h: 2680 },
  { id: "P2", level: "Level 5", ref: "1", w: 870, h: 2680 },
  { id: "P3", level: "Level 6", ref: "1", w: 900, h: 2680 },
  { id: "P4", level: "Level 6", ref: "1", w: 500, h: 2500 },
];
const settings = { rolls: [1000, 1800], allowance: 20, scope: "level", level: "" };
const good = { settings, unfit: [], cuts: [
  { id: "R001", W: 1800, L: 2680, allowance: 20, used: 1790, scope: "Level 5", pieces: [pcs[0], pcs[1]] },
  { id: "R002", W: 1000, L: 2680, allowance: 20, used: 920, scope: "Level 6", pieces: [pcs[2]] },
  { id: "R003", W: 1000, L: 2500, allowance: 20, used: 520, scope: "Level 6", pieces: [pcs[3]] },
] };
assert.deepEqual(C.verifyPlan(pcs, good), []);
const tamper = (fn) => { const r = plain(good); fn(r); return C.verifyPlan(pcs, r); };
assert.ok(tamper((r) => r.cuts.pop()).some((x) => /P4 is in no cut/.test(x)));
assert.ok(tamper((r) => r.cuts[1].pieces.push(plain(pcs[3]))).some((x) => /P4 is in 2 cuts/.test(x)));
assert.ok(tamper((r) => { r.cuts[0].W = 1000; }).some((x) => /panels \+ allowance take 1790 mm, roll gives 1000 mm/.test(x)));
assert.ok(tamper((r) => { r.cuts[0].W = 1000; }).some((x) => /panel area is more than the film/.test(x)), "a yield over 100% is flagged");
assert.ok(tamper((r) => { r.cuts[1].allowance = 0; }).some((x) => /allowance 0 mm ≠ the setting 20 mm/.test(x)));
assert.ok(tamper((r) => { r.cuts[1].used = 900; }).some((x) => /used width 900 ≠ 920/.test(x)));
assert.ok(tamper((r) => { r.cuts[2].L = 2680; }).some((x) => /height 2500 ≠ cut length 2680/.test(x)));
assert.ok(tamper((r) => { r.cuts[1].pieces.push(r.cuts[0].pieces.pop()); }).some((x) => /P2 is from another level/.test(x)));
assert.ok(tamper((r) => { r.cuts[0].pieces[0].w = 899; }).some((x) => /P1 size changed/.test(x)));
assert.ok(tamper((r) => { r.cuts[0].W = 1500; }).some((x) => /roll 1500 mm is not in the settings/.test(x)));
// Filtered to one level: only that level's panels must be there.
assert.deepEqual(C.verifyPlan(pcs, { settings: Object.assign({}, settings, { level: "Level 5" }), unfit: [], cuts: [good.cuts[0]] }), []);

// ---- the calculation (needs HiGHS) ----
let loadHighs = null;
for (const where of [process.env.HIGHS_PATH, "highs"].filter(Boolean)) {
  try { loadHighs = require(where); break; } catch (e) { /* try the next */ }
}

(async () => {
  if (!loadHighs) {
    console.log("film-cutting: reading + rule tests passed; calculation tests SKIPPED (npm i highs@1.15.3 or set HIGHS_PATH)");
    return;
  }
  const highs = await loadHighs();
  const solve = async (t, o) => C.fromHighs(highs.solve(t, { output_flag: false, time_limit: o.timeLimit, mip_rel_gap: 0 }));
  const P = (id, level, ref, w, h) => ({ id, level, ref, loc: "", w, h });

  // The prompt's example: 950 + 830 + 20 = 1800 -> one 1800 cut, 0 spare.
  const ex = [P("P1", "Level 6", "13", 950, 2680), P("P2", "Level 6", "13", 830, 2680)];
  let r = await C.plan(ex, { scope: "level", allowance: 20 }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.id, c.W, c.used, c.spare, c.allowance])), [["R001", 1800, 1800, 0, 20]]);
  assert.equal(r.optimal, true);
  const row = C.exportRows(r, {}).cuts.rows[0];
  assert.deepEqual(plain(row.slice(0, 12)), ["R001", "Level 6", "13", "", 1800, 2680, 2, "950 + 830 + 20 allowance", 1800, 0, 4.824, 4.770]);
  assert.ok(Math.abs(row[12] - 4.7704 / 4.824) < 1e-12); assert.equal(row[13], "P1, P2");
  // 30 mm: 1810 never goes on the 1800 roll -> two cuts of 1000.
  r = await C.plan(ex, { scope: "level", allowance: 30 }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.W, c.used])), [[1000, 980], [1000, 860]]);
  assert.equal(r.settings.allowance, 30);
  await assert.rejects(C.plan(ex, { scope: "level", allowance: -5 }, solve), /Allowance/);
  // Too wide for any roll with the allowance: 1790 + 20 > 1800 -> reported.
  r = await C.plan([P("P1", "Level 5", "1", 1790, 2680), P("P2", "Level 5", "1", 1780, 2680)], { scope: "level" }, solve);
  assert.deepEqual(plain(r.unfit.map((p) => p.id)), ["P1"]); assert.deepEqual(plain(r.cuts.map((c) => [c.W, c.spare])), [[1800, 0]]);
  // Different heights never share a cut.
  r = await C.plan([P("P1", "Level 5", "1", 500, 2000), P("P2", "Level 5", "1", 400, 2100)], { scope: "level" }, solve);
  assert.equal(r.cuts.length, 2);
  // Scope: By level never mixes levels; Whole job may.
  const two = [P("P1", "Level 5", "1", 900, 2680), P("P2", "Level 6", "1", 870, 2680)];
  r = await C.plan(two, { scope: "level" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.id, c.W])), [["R001", 1000], ["R002", 1000]]);
  r = await C.plan(two, { scope: "whole" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.id, c.W, c.pieces.map((p) => p.id)])), [["R001", 1800, ["P1", "P2"]]]);
  // By location never mixes rooms.
  r = await C.plan([P("P1", "Level 5", "1", 900, 2680), P("P2", "Level 5", "2", 870, 2680)], { scope: "location" }, solve);
  assert.equal(r.cuts.length, 2);
  // One level only.
  r = await C.plan(two, { scope: "level", level: "Level 6" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => c.pieces.map((p) => p.id))), [["P2"]]);
  assert.equal(r.pieceCount, 1);
  // Wider than any roll: reported, never cut, never dropped silently.
  r = await C.plan([P("P1", "Level 5", "1", 1900, 2680), P("P2", "Level 5", "1", 500, 2680)], { scope: "level" }, solve);
  assert.deepEqual(plain(r.unfit.map((p) => p.id)), ["P1"]);
  assert.deepEqual(C.verifyPlan([P("P1", "Level 5", "1", 1900, 2680), P("P2", "Level 5", "1", 500, 2680)], r), []);

  // The made-up sheet above: every panel exactly once, totals add up,
  // batches in the team's order, same answer twice (reproducible).
  for (const scope of ["level", "whole", "location"]) {
    const a = await C.plan(read.pieces, { scope }, solve);
    const b = await C.plan(read.pieces, { scope }, solve);
    assert.deepEqual(C.verifyPlan(read.pieces, a), []);
    assert.equal(a.totals.pieces + a.unfit.length, read.pieces.length, "every panel accounted for");
    assert.equal(a.unfit.length, 1);
    const film = a.cuts.reduce((s, c) => s + c.W * c.L, 0) / 1e6;
    const panels = read.pieces.filter((p) => p.w + 20 <= 1800).reduce((s, p) => s + p.w * p.h, 0) / 1e6;
    assert.ok(Math.abs(a.totals.film - film) < 1e-9 && Math.abs(a.totals.panels - panels) < 1e-9);
    assert.ok(Math.abs(a.totals.offcut - (film - panels)) < 1e-9);
    assert.deepEqual(plain(a.cuts.map((c) => [c.id, c.W, c.L, c.pieces.map((p) => p.id)])), plain(b.cuts.map((c) => [c.id, c.W, c.L, c.pieces.map((p) => p.id)])));
    const batches = a.cuts.map((c) => c.batch);
    assert.deepEqual(batches, batches.slice().sort((x, y) => x - y), "cuts listed batch by batch");
  }
  const lv = await C.plan(read.pieces, { scope: "level" }, solve);
  const wh = await C.plan(read.pieces, { scope: "whole" }, solve);
  const lc = await C.plan(read.pieces, { scope: "location" }, solve);
  assert.ok(wh.totals.film <= lv.totals.film && lv.totals.film <= lc.totals.film, "a wider scope never needs more film");

  // Rolls on hand. Three 950 x 2680 panels: unlimited = three 1000 cuts.
  const three = [1, 2, 3].map((i) => P("P" + i, "Level 5", "1", 950, 2680));
  r = await C.plan(three, { scope: "level", rolls: [1000, 1200], stock: { 1000: [10], 1200: [] } }, solve);
  assert.equal(r.stock.ok, true); assert.deepEqual(plain(r.cuts.map((c) => c.roll)), [1, 1, 1]);
  assert.ok(Math.abs(r.stock.rolls[1000][0].left - (10 - 3 * 2.68)) < 1e-9);
  // Roll ends: two 5 m rolls of 1000 hold one 2.68 m cut each (5.36 > 5),
  // so the third cut goes on the 1200 roll.
  r = await C.plan(three, { scope: "level", rolls: [1000, 1200], stock: { 1000: [5, 5], 1200: [3] } }, solve);
  assert.equal(r.stock.ok, true, JSON.stringify(r.stock));
  assert.deepEqual(plain(r.cuts.map((c) => c.W).sort()), [1000, 1000, 1200]);
  assert.deepEqual(C.verifyPlan(three, r), []);
  assert.equal(r.optimal, true);
  // Not enough film: said so, with what the plan would need.
  r = await C.plan(three, { scope: "level", rolls: [1000, 1200], stock: { 1000: [5], 1200: [3] } }, solve);
  assert.equal(r.stock.infeasible, true); assert.equal(r.stock.proven, true);
  assert.ok(Math.abs(r.stock.need[1000] - 8.04) < 1e-9);
  assert.equal(r.stock.have[1000], 5);
  console.log("film-cutting: all tests passed (with HiGHS)");
})().catch((e) => { console.error(e); process.exit(1); });
