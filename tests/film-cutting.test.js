// Film Cutting (film-cutting.js, window.ORYX_CUT_CORE): reading the job
// list, the cutting rules and the plan check. The rows below are made up in
// the layout of the Etihad Rail smart-film list (SSF2026-225 ER AUH1.xlsx is
// a customer file and is not committed). On that real file the calculator
// gives (blade 1 mm, rolls 1000/1200/1500/1800, no trim): By location
// 591.717 m2 / 187 cuts, By level 566.762 / 154, Whole job 557.180 / 138,
// Level 5 alone 218.933 / 64 -- the same as an independent check in Python
// (pulp/CBC), and with the workbook's 3 mm gap + its heights the workbook's
// own 590.592 / 568.084 / 558.519 m2.
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

// ---- cutting rules ----
assert.equal(C.across([900, 890], 1), 1791, "blade between panels only");
assert.equal(C.across([900], 1), 900);
// Patterns: only "full" ones (nothing else fits beside them on that roll);
// 900 + 899 + 1 mm blade = exactly 1800.
const pats = C.patterns({ 900: 1, 899: 1 }, [1000, 1800], 1, 0, false);
assert.deepEqual(plain(pats.map((p) => [p.pat, p.W])), [[{ 899: 1 }, 1000], [{ 900: 1 }, 1000], [{ 900: 1, 899: 1 }, 1800]]);
assert.deepEqual(plain(C.patterns({ 400: 2 }, [1000], 1, 0, false).map((p) => p.pat)), [{ 400: 2 }], "one 400 alone is not full");
// 900 + 900 + 1 = 1801: never on one 1800 roll.
const pats2 = C.patterns({ 900: 2 }, [1000, 1800], 1, 0, false);
assert.deepEqual(plain(pats2.map((p) => [p.pat, p.W])), [[{ 900: 1 }, 1000]]);
// Edge trim takes from both edges: 1800 - 2 x 1 = 1798 < 1799.
assert.deepEqual(plain(C.patterns({ 900: 1, 899: 1 }, [1000, 1800], 1, 1, false).map((p) => [p.pat, p.W])), [[{ 899: 1 }, 1000], [{ 900: 1 }, 1000]]);
// "any": a pattern may also be cut from a wider roll (needed with stock).
assert.deepEqual(plain(C.patterns({ 900: 1 }, [1000, 1200], 1, 0, true).map((p) => p.W)), [1000, 1200]);
// Production order: the team's order, other widths after.
assert.deepEqual(plain(C.batchOrder({ rolls: [1000, 1200, 1500, 1800, 2000], order: [1000, 1200, 1800, 1500] })), [1000, 1200, 1800, 1500, 2000]);
assert.deepEqual(plain(C.batchOrder({ rolls: [1000, 1500], order: [1000, 1200, 1800, 1500] })), [1000, 1500]);

// LP text for HiGHS.
const m = C.buildModel(C.groupsOf([{ id: "P1", level: "L", w: 900, h: 2000 }, { id: "P2", level: "L", w: 899, h: 2000 }], "level"), Object.assign({}, C.DEFAULTS), null);
const text = C.lpText(m);
assert.equal(text, "Minimize\n film: 2000000001 x0_0 + 2000000001 x0_1 + 3600000001 x0_2\nSubject To\n d0_899: 1 x0_0 + 1 x0_2 >= 1\n d0_900: 1 x0_1 + 1 x0_2 >= 1\nGeneral\n x0_0 x0_1 x0_2\nEnd\n");
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
  { id: "P2", level: "Level 5", ref: "1", w: 890, h: 2680 },
  { id: "P3", level: "Level 6", ref: "1", w: 900, h: 2680 },
  { id: "P4", level: "Level 6", ref: "1", w: 500, h: 2500 },
];
const settings = { rolls: [1000, 1800], blade: 1, trim: 0, scope: "level", level: "" };
const good = { settings, unfit: [], cuts: [
  { id: "L5-001", W: 1800, L: 2680, scope: "Level 5", pieces: [pcs[0], pcs[1]] },
  { id: "L6-001", W: 1000, L: 2680, scope: "Level 6", pieces: [pcs[2]] },
  { id: "L6-002", W: 1000, L: 2500, scope: "Level 6", pieces: [pcs[3]] },
] };
assert.deepEqual(C.verifyPlan(pcs, good), []);
const tamper = (fn) => { const r = plain(good); fn(r); return C.verifyPlan(pcs, r); };
assert.ok(tamper((r) => r.cuts.pop()).some((x) => /P4 is in no cut/.test(x)));
assert.ok(tamper((r) => r.cuts[1].pieces.push(plain(pcs[3]))).some((x) => /P4 is in 2 cuts/.test(x)));
assert.ok(tamper((r) => { r.cuts[0].W = 1000; }).some((x) => /panels take 1791 mm, roll gives 1000 mm/.test(x)));
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

  // Exact fit: 900 + 899 on one 1800 cut (1.8 x 2 = 3.6 m2) beats two 1000 cuts (4 m2).
  let r = await C.plan([P("P1", "Level 5", "1", 900, 2000), P("P2", "Level 5", "1", 899, 2000)], { scope: "level" }, solve);
  assert.equal(r.cuts.length, 1); assert.equal(r.cuts[0].W, 1800); assert.equal(r.cuts[0].spare, 0);
  assert.equal(r.totals.film, 3.6); assert.equal(r.optimal, true);
  // Near fit: 900 + 900 + 1 = 1801 -> two 1000 cuts.
  r = await C.plan([P("P1", "Level 5", "1", 900, 2000), P("P2", "Level 5", "1", 900, 2000)], { scope: "level" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => c.W)), [1000, 1000]);
  // Different heights never share a cut.
  r = await C.plan([P("P1", "Level 5", "1", 500, 2000), P("P2", "Level 5", "1", 400, 2100)], { scope: "level" }, solve);
  assert.equal(r.cuts.length, 2);
  // Scope: By level never mixes levels; Whole job may.
  const two = [P("P1", "Level 5", "1", 900, 2680), P("P2", "Level 6", "1", 890, 2680)];
  r = await C.plan(two, { scope: "level" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.id, c.W])), [["L5-001", 1000], ["L6-001", 1000]]);
  r = await C.plan(two, { scope: "whole" }, solve);
  assert.deepEqual(plain(r.cuts.map((c) => [c.id, c.W, c.pieces.map((p) => p.id)])), [["W-001", 1800, ["P1", "P2"]]]);
  // By location never mixes rooms.
  r = await C.plan([P("P1", "Level 5", "1", 900, 2680), P("P2", "Level 5", "2", 890, 2680)], { scope: "location" }, solve);
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
    const panels = read.pieces.filter((p) => p.w <= 1800).reduce((s, p) => s + p.w * p.h, 0) / 1e6;
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
