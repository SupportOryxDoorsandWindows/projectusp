/* Film Cutting (all active staff since 2026-10-29; was Admins only): plans how smart-film panels are cut from the
 * rolls with the least film. Read the job list (Excel) -> check -> settings
 * -> calculate -> review -> approve (saved, with who/when) -> Excel export.
 * Never touches stock or Master Inventory; the uploaded file is never changed.
 *
 * Model (confirmed by the team, 2026-10-28; allowance rule 2026-10-29 from
 * "Feature_Development_Prompt.docx" + the user's answers):
 *  - a CUT is one length of film off one roll; its length = the panels'
 *    height as in the file (only panels of the SAME height share a cut), the
 *    panels sit side by side across the roll;
 *  - Used width = sum of the panel widths + ONE allowance per cut (default
 *    30 mm since 2026-10-29, was 20; editable; it covers the blade/gaps, nothing else is added; also
 *    for a cut with one panel): 950 + 830 + 20 = 1800 fits the 1800 roll,
 *    + 30 = 1810 does not. Offcut width = roll width - used width. The
 *    allowance is kept on every cut (c.allowance) so it could differ per
 *    cut later;
 *  - roll widths are fixed: 1000 / 1200 / 1500 / 1800 mm;
 *  - panels are never turned (no panel here is short enough to be turned);
 *  - film used = roll width x cut length; least film first, then fewest cuts;
 *  - scope: By level / Whole job / By location (panels of different groups
 *    never share a cut);
 *  - production batches go one roll width at a time, in the team's order
 *    1000 -> 1200 -> 1800 -> 1500 (other widths after);
 *  - with rolls on hand entered, the plan stays within them and every cut is
 *    placed on a real roll (a cut never runs across two rolls).
 * The arithmetic is exact integer programming (HiGHS, highs-js, MIT, run in a
 * Web Worker); every plan is re-checked by verifyPlan before it is shown.
 *
 * Pure parts: window.ORYX_CUT_CORE (tests/film-cutting.test.js).
 */
(function () {
  "use strict";

  const CALC_VERSION = "film-cut-1";
  const DEFAULTS = {
    rolls: [1000, 1200, 1500, 1800],
    allowance: 30,       // mm per cut, on top of the panel widths (30 since 2026-10-29)
    scope: "level",      // "level" | "whole" | "location"
    level: "",           // "" = all levels
    order: [1000, 1200, 1800, 1500],
    timeLimit: 60,       // seconds per calculation before the best found is used
  };

  // ---------------------------------------------------------------- reading
  const txt = (v) => (v == null ? "" : String(v).trim());
  const num = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    const s = txt(v);
    if (!s) return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  };

  // Find the header row: a row with "Width" and "Height" (and "Qty").
  function findHeader(grid) {
    for (let r = 0; r < Math.min(grid.length, 40); r++) {
      const row = grid[r] || [];
      const cols = {};
      row.forEach((v, c) => {
        const s = txt(v).toLowerCase();
        if (!s) return;
        if (cols.width == null && /^width\b/.test(s)) cols.width = c;
        else if (cols.height == null && /^height\b/.test(s)) cols.height = c;
        else if (cols.qty == null && /^(qty|quantity)\b/.test(s)) cols.qty = c;
        else if (cols.ref == null && /^ref\b/.test(s)) cols.ref = c;
        else if (cols.location == null && /^(location|room)\b/.test(s)) cols.location = c;
        else if (cols.type == null && /^type\b/.test(s)) cols.type = c;
        else if (cols.piece == null && /^piece( id)?$/.test(s)) cols.piece = c;
        else if (cols.level == null && /^level$/.test(s)) cols.level = c;
        else if (cols.srcRow == null && /^(file|source) row$/.test(s)) cols.srcRow = c;
        else if (cols.rule == null && /^rule$/.test(s)) cols.rule = c;
      });
      if (cols.width != null && cols.height != null) {
        // The type column has no header in the Etihad file (column C,
        // "Door" / "Curve"): an unlabeled column between Location and Width.
        if (cols.type == null && cols.location != null && cols.width - cols.location === 2 && !txt(row[cols.location + 1])) cols.type = cols.location + 1;
        return { row: r, cols };
      }
    }
    return null;
  }

  const LEVEL_RE = /^level\s*([0-9a-z]+)\b/i;

  // grid = rows of cell values (formula cells: their saved value), as from
  // SheetJS sheet_to_json(header: 1). Formulas are never worked out here.
  // Returns {pieces, issues, header, levels} -- pieces are numbered P001...
  // in file order; a row with Qty n gives n pieces.
  // A list of pieces, one row per piece (e.g. the "Piece references" sheet
  // of a cutting workbook, or this page's own export): Piece, Level, Ref,
  // Location, Type, Width (mm), Height (mm), File row. The piece IDs and
  // file rows are kept as they are. A "Rule" column (the workbook lists the
  // same panels once per rule) -> the rows of the first rule only, after
  // checking every rule lists the same panels.
  function readPieceList(grid, header, sheetName, issues, add) {
    const C = header.cols;
    let rows = [];
    for (let r = header.row + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      if (row.every((v) => !txt(v))) continue;
      rows.push({ r, row });
    }
    if (C.rule != null && rows.length) {
      const rules = [...new Set(rows.map((x) => txt(x.row[C.rule])))];
      if (rules.length > 1) {
        const sig = (rule) => rows.filter((x) => txt(x.row[C.rule]) === rule).map((x) => [txt(x.row[C.piece]), txt(x.row[C.width]), txt(x.row[C.height])].join("|")).sort().join(";");
        const first = sig(rules[0]);
        if (rules.some((r) => sig(r) !== first)) {
          add("ERROR", "The sheet lists different panels for each rule (" + rules.join(", ") + ")", "Upload a sheet with one row per panel.");
          return [];
        }
        add("INFO", "The sheet lists the same " + rows.filter((x) => txt(x.row[C.rule]) === rules[0]).length + " panels once per rule (" + rules.join(", ") + ")", "Read once, from the \"" + rules[0] + "\" rows.");
        rows = rows.filter((x) => txt(x.row[C.rule]) === rules[0]);
      }
    }
    const pieces = [], seen = new Map();
    for (const { r, row } of rows) {
      const id = txt(row[C.piece]);
      const w = num(row[C.width]), h = num(row[C.height]);
      const where = "Row " + (r + 1) + (id ? " · " + id : "");
      if (!id) { add("ERROR", where + ": no piece ID", "Every row needs its piece ID.", r); continue; }
      if (w == null || h == null || Number.isNaN(w) || Number.isNaN(h)) { add("ERROR", where + ": width or height is missing or not a number", "Width \"" + txt(row[C.width]) + "\", height \"" + txt(row[C.height]) + "\". Fix the file and upload it again.", r); continue; }
      if (w <= 0 || h <= 0) { add("ERROR", where + ": width or height is zero or below", w + " × " + h + " mm.", r); continue; }
      if (w !== Math.round(w) || h !== Math.round(h)) { add("ERROR", where + ": size is not whole millimetres", w + " × " + h + " mm.", r); continue; }
      if (seen.has(id)) { add("ERROR", where + ": piece ID " + id + " is used twice (also row " + seen.get(id) + ")", "Each piece needs its own ID.", r); continue; }
      seen.set(id, r + 1);
      const sr = C.srcRow != null ? num(row[C.srcRow]) : null;
      pieces.push({
        id, level: C.level != null ? txt(row[C.level]) : "", ref: C.ref != null ? txt(row[C.ref]) : "", loc: C.location != null ? txt(row[C.location]) : "",
        type: C.type != null ? txt(row[C.type]) : "", w, h, row: r + 1, srcRow: Number.isFinite(sr) ? sr : null, of: "",
      });
    }
    return pieces;
  }

  function readSheet(grid, sheetName) {
    const issues = [];
    const add = (kind, title, text, row) => issues.push({ kind, title, text: text || "", row: row == null ? null : row + 1 });
    if (!Array.isArray(grid) || !grid.length) {
      add("ERROR", "The sheet is empty", "Choose the sheet with the panel list.");
      return { pieces: [], issues, header: null, levels: [] };
    }
    const header = findHeader(grid);
    if (!header) {
      add("ERROR", "No header row with \"Width\" and \"Height\" found", "The panel list needs columns named Width (mm), Height (mm) and Qty.");
      return { pieces: [], issues, header: null, levels: [] };
    }
    const C = header.cols;
    if (C.piece != null) {
      const pieces = readPieceList(grid, header, sheetName, issues, add);
      return finishRead(pieces, issues, add, header, sheetName);
    }
    if (C.qty == null) add("ERROR", "No \"Qty\" column found", "Every panel row needs a quantity.");
    const pieces = [];
    let level = null, levelRow = null, firstLevelSeen = null;
    let ref = "", loc = "";
    const rowsBeforeLevel = [];
    const levels = [];
    for (let r = header.row + 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const first = txt(row[0]);
      const m = LEVEL_RE.exec(first);
      if (m && num(row[C.width]) == null) {
        level = "Level " + m[1].toUpperCase();
        levelRow = r;
        if (firstLevelSeen == null) firstLevelSeen = { name: level, num: Number(m[1]) };
        if (!levels.includes(level)) levels.push(level);
        continue;
      }
      if (/^total\b/i.test(first)) continue;
      const wRaw = row[C.width], hRaw = row[C.height];
      const w = num(wRaw), h = num(hRaw);
      if (w == null && h == null) continue; // blank, title or sub-total row
      if (txt(row[C.ref])) ref = txt(row[C.ref]);
      if (C.location != null && txt(row[C.location])) loc = txt(row[C.location]);
      const type = C.type != null ? txt(row[C.type]) : "";
      const where = (level || "\u0001") + (ref ? " · Ref " + ref : "") + (loc ? " " + loc : "");
      if (Number.isNaN(w) || Number.isNaN(h) || w == null || h == null) {
        add("ERROR", "Row " + (r + 1) + " · " + where + ": width or height is not a number", "Width \"" + txt(wRaw) + "\", height \"" + txt(hRaw) + "\". Fix the file and upload it again.", r);
        continue;
      }
      if (w <= 0 || h <= 0) {
        add("ERROR", "Row " + (r + 1) + " · " + where + ": width or height is zero or below", w + " × " + h + " mm. Fix the file and upload it again.", r);
        continue;
      }
      if (w !== Math.round(w) || h !== Math.round(h)) {
        add("ERROR", "Row " + (r + 1) + " · " + where + ": size is not whole millimetres", w + " × " + h + " mm. Fix the file and upload it again.", r);
        continue;
      }
      const qRaw = C.qty != null ? row[C.qty] : null;
      const q = num(qRaw);
      if (q == null || q === 0) {
        add("LEFT OUT", "Row " + (r + 1) + " · " + where + (type ? " – " + type : "") + " " + w + " × " + h + " mm", "No quantity in the file, so it is not planned. Add a quantity and upload again if it is needed.", r);
        continue;
      }
      if (Number.isNaN(q) || q < 0 || q !== Math.round(q)) {
        add("ERROR", "Row " + (r + 1) + " · " + where + ": quantity \"" + txt(qRaw) + "\" is not a whole number above 0", "Fix the file and upload it again.", r);
        continue;
      }
      if (level == null) rowsBeforeLevel.push(r);
      for (let i = 0; i < q; i++) {
        pieces.push({
          id: "P" + String(pieces.length + 1).padStart(3, "0"),
          level, ref, loc, type, w, h, row: r + 1,
          of: q > 1 ? (i + 1) + " of " + q : "",
        });
      }
    }
    // Rows above the first LEVEL row: named after the level before it
    // (e.g. "LEVEL 6" first -> "Level 5"), and the Admin is told.
    if (rowsBeforeLevel.length) {
      let name = "No level";
      if (firstLevelSeen && Number.isFinite(firstLevelSeen.num) && firstLevelSeen.num > 1) name = "Level " + (firstLevelSeen.num - 1);
      for (const p of pieces) if (p.level == null) p.level = name;
      for (const i of issues) i.title = i.title.replace("\u0001", name);
      levels.unshift(name);
      const a = rowsBeforeLevel[0] + 1, b = rowsBeforeLevel[rowsBeforeLevel.length - 1] + 1;
      add("CHECK", "Rows " + a + "–" + b + " have no LEVEL row above them: called \"" + name + "\"", firstLevelSeen ? "The first LEVEL row in the file is \"" + firstLevelSeen.name.toUpperCase() + "\"." : "The file has no LEVEL rows.");
    }
    for (const i of issues) i.title = i.title.replace("\u0001", "No level");
    return finishRead(pieces, issues, add, header, sheetName);
  }

  // Checks for both layouts (planned as they are, never changed).
  function finishRead(pieces, issues, add, header, sheetName) {
    // Things worth a second look (planned as they are).
    const seenLoc = new Set();
    for (const p of pieces) {
      const key = p.level + "|" + p.ref;
      if (/complete/i.test(p.loc) && !seenLoc.has(key)) {
        seenLoc.add(key);
        const n = pieces.filter((x) => x.level === p.level && x.ref === p.ref).length;
        add("CHECK", p.level + " · Ref " + p.ref + " is named \"" + p.loc + "\" but still has " + n + " panel" + (n === 1 ? "" : "s"), "They are planned. Remove them from the file if the room is really finished.");
      }
    }
    const curved = pieces.filter((p) => /curve/i.test(p.type));
    if (curved.length) {
      const rows = [...new Set(curved.map((p) => p.row))];
      add("CHECK", curved.length + " curved panel" + (curved.length === 1 ? "" : "s") + " (row" + (rows.length === 1 ? " " : "s ") + rows.join(", ") + ")", "Planned as straight panels. Confirm the template before cutting.");
    }
    // Missing optional details: shown, never filled in.
    const noLevel = pieces.filter((p) => !p.level), noRef = pieces.filter((p) => !p.ref), noLoc = pieces.filter((p) => !p.loc);
    const ids = (ps) => ps.slice(0, 8).map((p) => p.id).join(", ") + (ps.length > 8 ? " …" : "");
    if (noLevel.length) add("CHECK", noLevel.length + " panel" + (noLevel.length === 1 ? " has" : "s have") + " no level (" + ids(noLevel) + ")", "Planned together as \"No level\".");
    if (noRef.length) add("CHECK", noRef.length + " panel" + (noRef.length === 1 ? " has" : "s have") + " no Ref # (" + ids(noRef) + ")", "Left blank.");
    if (noLoc.length) add("CHECK", noLoc.length + " panel" + (noLoc.length === 1 ? " has" : "s have") + " no location (" + ids(noLoc) + ")", "Left blank.");
    for (const p of pieces) if (!p.level) p.level = "No level";
    const levels = [];
    for (const p of pieces) if (!levels.includes(p.level)) levels.push(p.level);
    return { pieces, issues, header: { row: header.row + 1, cols: header.cols, sheet: sheetName || "" }, levels };
  }

  // ---------------------------------------------------------------- planning
  const scopeKey = (scope, p) => scope === "whole" ? "Whole job" : scope === "location" ? p.level + " · Ref " + p.ref : p.level;
  const SCOPE_NAMES = { level: "By level", whole: "Whole job", location: "By location" };

  const ROLLS = [1000, 1200, 1500, 1800];
  // Used width of a cut: the panel widths + the cut's allowance.
  const sumW = (widths) => widths.reduce((a, b) => a + b, 0);
  const across = (widths, allowance) => sumW(widths) + allowance;
  // The allowance as typed: a number, 0 or more (whole mm or one decimal).
  function checkAllowance(v) {
    const t = String(v == null ? "" : v).trim();
    if (!/^\d+(\.\d)?$/.test(t)) return { ok: false, error: "Allowance: a number of millimetres, 0 or more (e.g. 20, 25, 30)." };
    const n = Number(t);
    if (n > 500) return { ok: false, error: "Allowance: at most 500 mm." };
    return { ok: true, value: n };
  }

  // Every way of putting panels side by side (counts = {width: how many}),
  // kept only when nothing else fits beside them on the narrowest roll that
  // takes them (a "full" pattern). Covering the panels with full patterns
  // loses nothing: taking a panel out of a cut never makes it invalid.
  // A pattern fits roll R when its panel widths + allowance <= R. any: a
  // pattern may also be cut from a wider roll (needed with stock).
  function patterns(counts, rolls, allowance, any) {
    const ws = Object.keys(counts).map(Number).sort((a, b) => b - a);
    const rs = rolls.slice().sort((a, b) => a - b);
    const maxU = rs[rs.length - 1] - allowance;
    const out = [];
    const pat = {};
    const rec = (i, fit, n) => {
      if (i === ws.length) {
        if (!n) return;
        for (const R of rs) {
          const U = R - allowance;
          if (fit > U) continue;
          // full: no remaining panel would still fit on R
          let full = true;
          for (const w of ws) {
            if ((pat[w] || 0) < counts[w] && fit + w <= U) { full = false; break; }
          }
          if (full) out.push({ pat: Object.assign({}, pat), W: R, fit });
          if (!any) break;
        }
        return;
      }
      const w = ws[i];
      for (let k = 0; k <= counts[w]; k++) {
        const u = fit + k * w;
        if (u > maxU && k > 0) break;
        if (k) pat[w] = k; else delete pat[w];
        rec(i + 1, u, n + k);
      }
      delete pat[w];
    };
    rec(0, 0, 0);
    return out;
  }

  // Groups: panels of the same scope group AND the same height.
  function groupsOf(pieces, scope) {
    const map = new Map();
    for (const p of pieces) {
      const k = scopeKey(scope, p) + "\u0000" + p.h;
      if (!map.has(k)) map.set(k, { scope: scopeKey(scope, p), h: p.h, pieces: [] });
      map.get(k).pieces.push(p);
    }
    return [...map.values()];
  }

  const countsOf = (ps) => ps.reduce((m, p) => (m[p.w] = (m[p.w] || 0) + 1, m), {});

  // The model as CPLEX LP text (what HiGHS reads). relax = without whole
  // numbers (gives a floor for "how far from the best possible").
  function lpText(model, relax) {
    const term = (vs) => vs.length ? vs.map((v, i) => (v.coef < 0 ? " - " : i ? " + " : " ") + Math.abs(v.coef) + " " + v.name).join("") : " 0 x0_0";
    const lines = ["Minimize", " film:" + term(model.objective), "Subject To"];
    for (const c of model.cons) lines.push(" " + c.name + ":" + term(c.vars) + " " + c.op + " " + c.rhs);
    if (!relax && model.generals.length) {
      lines.push("General");
      for (let i = 0; i < model.generals.length; i += 20) lines.push(" " + model.generals.slice(i, i + 20).join(" "));
    }
    lines.push("End");
    return lines.join("\n") + "\n";
  }

  // Build one integer programme for the given groups. Objective: film area
  // (mm x mm) x 1000 + 1 per cut (so fewer cuts only ever breaks a tie).
  // stock = {W: [metres of each roll]}: every cut must then sit on one real
  // roll (y = how many cuts of one height go on one roll), so roll ends are
  // counted exactly. A width with no rolls entered can't be used.
  function buildModel(groups, S, stock) {
    const vars = [], cons = [], objective = [], gens = [];
    const link = {}; // "h|W" -> pattern variables
    groups.forEach((g, gi) => {
      g.counts = countsOf(g.pieces);
      g.pats = patterns(g.counts, S.rolls, S.allowance, !!stock);
      const cover = {};
      g.pats.forEach((p, i) => {
        if (stock && !(stock[p.W] && stock[p.W].length)) return;
        const name = "x" + gi + "_" + i;
        vars.push({ name, g: gi, i });
        gens.push(name);
        // With rolls on hand: film only (the tie-break on cuts makes that
        // search far slower); otherwise film, then fewest cuts.
        objective.push({ name, coef: stock ? p.W * g.h / 100 : p.W * g.h * 1000 + 1 });
        for (const w in p.pat) (cover[w] = cover[w] || []).push({ name, coef: p.pat[w] });
        const k = g.h + "|" + p.W;
        (link[k] = link[k] || []).push({ name, coef: 1 });
      });
      for (const w in g.counts) {
        cons.push({ name: "d" + gi + "_" + w, vars: cover[w] || [], op: ">=", rhs: g.counts[w] });
      }
    });
    const rollVars = [];
    if (stock) {
      for (const W of Object.keys(stock).map(Number)) {
        const lens = stock[W] || [];
        const hs = Object.keys(link).filter((k) => Number(k.split("|")[1]) === W).map((k) => Number(k.split("|")[0]));
        if (!hs.length) continue;
        const ys = {};
        lens.forEach((len, r) => {
          const cap = [];
          for (const h of hs) {
            const name = "y" + h + "_" + W + "_" + r;
            rollVars.push({ name, h, W, r });
            gens.push(name);
            cap.push({ name, coef: h });
            (ys[h] = ys[h] || []).push({ name, coef: -1 });
          }
          cons.push({ name: "r" + W + "_" + r, vars: cap, op: "<=", rhs: Math.round(len * 1000) });
          // Identical rolls: fill the earlier one first (same plans, less searching).
          if (r > 0 && lens[r - 1] === len) {
            const prev = hs.map((h) => ({ name: "y" + h + "_" + W + "_" + (r - 1), coef: h }));
            cons.push({ name: "o" + W + "_" + r, vars: prev.concat(hs.map((h) => ({ name: "y" + h + "_" + W + "_" + r, coef: -h }))), op: ">=", rhs: 0 });
          }
        });
        for (const h of hs) {
          cons.push({ name: "l" + h + "_" + W, vars: link[h + "|" + W].concat(ys[h]), op: "=", rhs: 0 });
        }
      }
    }
    return { vars, rollVars, objective, cons, generals: gens };
  }

  // Turn a solution (how many of each pattern) into cuts with real panels.
  // Surplus places (covering may give a panel width one place too many) are
  // dropped; a cut left empty is dropped.
  function cutsFrom(groups, model, values, S) {
    const cuts = [];
    groups.forEach((g, gi) => {
      const pool = {};
      for (const p of g.pieces.slice().sort((a, b) => a.id < b.id ? -1 : 1)) (pool[p.w] = pool[p.w] || []).push(p);
      const chosen = [];
      model.vars.forEach((v) => {
        if (v.g !== gi) return;
        const n = Math.round(values[v.name] || 0);
        for (let k = 0; k < n; k++) chosen.push(g.pats[v.i]);
      });
      // Deterministic order: wider roll first, then fuller cut.
      chosen.sort((a, b) => b.W - a.W || b.fit - a.fit || JSON.stringify(a.pat).localeCompare(JSON.stringify(b.pat)));
      for (const pt of chosen) {
        const ps = [];
        for (const w of Object.keys(pt.pat).map(Number).sort((a, b) => b - a)) {
          for (let k = 0; k < pt.pat[w] && pool[w] && pool[w].length; k++) ps.push(pool[w].shift());
        }
        if (!ps.length) continue;
        cuts.push({ scope: g.scope, W: pt.W, L: g.h, allowance: S.allowance, pieces: ps });
      }
    });
    return cuts;
  }

  // The order batches are cut in: the team's order, other widths after.
  function batchOrder(S) {
    const order = (S.order || []).filter((w) => S.rolls.includes(w));
    for (const w of S.rolls.slice().sort((a, b) => a - b)) if (!order.includes(w)) order.push(w);
    return order;
  }

  // Number the cuts and work out totals. Cuts are listed by batch (roll
  // width in production order), then scope group, then length.
  function finish(cuts, pieces, S, unfit) {
    const order = batchOrder(S);
    const scopeOrder = [];
    for (const p of pieces) { const k = scopeKey(S.scope, p); if (!scopeOrder.includes(k)) scopeOrder.push(k); }
    cuts.sort((a, b) => order.indexOf(a.W) - order.indexOf(b.W) || scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope) || b.L - a.L || sumW(b.pieces.map((p) => p.w)) - sumW(a.pieces.map((p) => p.w)) || (a.pieces[0].id < b.pieces[0].id ? -1 : 1));
    cuts.forEach((c, i) => {
      c.id = "R" + String(i + 1).padStart(3, "0");
      c.batch = order.indexOf(c.W) + 1;
      if (c.allowance == null) c.allowance = S.allowance;
      c.used = across(c.pieces.map((p) => p.w), c.allowance);
      c.spare = c.W - c.used;
      c.film = c.W * c.L / 1e6;
      c.panels = c.pieces.reduce((a, p) => a + p.w * p.h, 0) / 1e6;
    });
    const film = cuts.reduce((a, c) => a + c.film, 0);
    const panels = cuts.reduce((a, c) => a + c.panels, 0);
    const byWidth = {};
    for (const W of order) {
      const cs = cuts.filter((c) => c.W === W);
      if (!cs.length) continue;
      byWidth[W] = { batch: order.indexOf(W) + 1, cuts: cs.length, metres: cs.reduce((a, c) => a + c.L, 0) / 1000, film: cs.reduce((a, c) => a + c.film, 0) };
    }
    return {
      cuts, unfit,
      totals: { film, panels, offcut: film - panels, yield: film ? panels / film : 0, cuts: cuts.length, pieces: cuts.reduce((a, c) => a + c.pieces.length, 0) },
      byWidth,
    };
  }

  // Which roll each cut comes from: {rollOf: {cutId: n}, byWidth: {W:
  // {used, of}}}. With rolls on hand: the rolls the plan placed them on (of =
  // rolls entered). Without: full rolls of rollLength metres, cuts placed
  // longest first, never across two rolls (of = null).
  function rollUse(result, rollLength) {
    const rollOf = {}, byWidth = {};
    if (result.stock && result.stock.rolls && !result.stock.infeasible) {
      for (const W of Object.keys(result.stock.rolls).map(Number).sort((a, b) => a - b)) {
        const list = result.stock.rolls[W];
        if (!list.length) continue;
        for (const r of list) for (const id of r.cuts) rollOf[id] = r.n;
        byWidth[W] = { used: list.filter((r) => r.cuts.length).length, of: list.length };
      }
      return { rollOf, byWidth };
    }
    for (const W of [...new Set(result.cuts.map((c) => c.W))].sort((a, b) => a - b)) {
      const cs = result.cuts.filter((c) => c.W === W);
      const n = Math.ceil(cs.reduce((a, c) => a + c.L, 0) / 1000 / rollLength) + cs.length; // enough rolls to place them
      const place = placeOnRolls(cs.map((c) => ({ id: c.id, W, L: c.L })), { [W]: new Array(n).fill(rollLength) });
      for (const r of place.rolls[W]) for (const id of r.cuts) rollOf[id] = r.n;
      byWidth[W] = { used: place.rolls[W].filter((r) => r.cuts.length).length, of: null };
    }
    return { rollOf, byWidth };
  }
  // How many rolls the plan takes: {used, of, byWidth} (of = null: no rolls
  // on hand entered, full rollLength rolls needed).
  function rollCount(result, rollLength) {
    const { byWidth } = rollUse(result, rollLength);
    let used = 0, of = 0;
    for (const W in byWidth) { used += byWidth[W].used; of = byWidth[W].of == null ? null : of == null ? null : of + byWidth[W].of; }
    return { used, of: Object.keys(byWidth).length ? of : null, byWidth };
  }

  // Place the cuts on the real rolls (rolls = {W: [metres, metres, ...]}):
  // longest cut first, on the first roll it still fits; a cut never runs
  // across two rolls. Returns {ok, rolls: {W: [{start, left, cuts}]}, short}.
  function placeOnRolls(cuts, rolls) {
    const out = {}, short = {};
    let ok = true;
    for (const W of Object.keys(rolls)) {
      out[W] = rolls[W].map((m, i) => ({ n: i + 1, start: m, left: Math.round(m * 1000), cuts: [] }));
    }
    const todo = cuts.slice().sort((a, b) => b.L - a.L || (a.id < b.id ? -1 : 1));
    for (const c of todo) {
      const list = out[c.W] || [];
      const r = list.find((x) => x.left >= c.L);
      if (r) { r.left -= c.L; r.cuts.push(c.id); c.roll = r.n; }
      else { ok = false; short[c.W] = (short[c.W] || 0) + c.L / 1000; c.roll = null; }
    }
    for (const W in out) for (const r of out[W]) r.left = r.left / 1000;
    return { ok, rolls: out, short };
  }

  // HiGHS answer -> {status: optimal | feasible | infeasible | none, values}.
  // A time limit with a whole-number plan found = "feasible" (not proven
  // the least film).
  function fromHighs(res) {
    const values = {};
    const cols = res.Columns || {};
    for (const k in cols) values[k] = typeof cols[k] === "number" ? cols[k] : cols[k].Primal;
    const st = String(res.Status || "");
    let status = "none";
    if (st === "Optimal") status = "optimal";
    else if (/infeasible/i.test(st)) status = "infeasible";
    else if (Number.isFinite(res.ObjectiveValue) && Object.keys(values).length && /limit/i.test(st)) status = "feasible";
    return { status, values, objective: res.ObjectiveValue, raw: st };
  }

  // Put the cuts on the rolls the way the calculation decided (y values).
  function placeFromModel(cuts, model, values, stock) {
    const out = {};
    for (const W of Object.keys(stock)) out[W] = stock[W].map((m, i) => ({ n: i + 1, start: m, left: Math.round(m * 1000), cuts: [] }));
    const pool = {};
    for (const c of cuts) (pool[c.W + "|" + c.L] = pool[c.W + "|" + c.L] || []).push(c);
    for (const v of model.rollVars) {
      const n = Math.round(values[v.name] || 0);
      const list = pool[v.W + "|" + v.h] || [];
      const roll = out[v.W][v.r];
      for (let k = 0; k < n && list.length; k++) {
        const c = list.shift();
        c.roll = roll.n; roll.cuts.push(c.id); roll.left -= c.L;
      }
    }
    const short = {};
    let ok = true;
    for (const k in pool) for (const c of pool[k]) { ok = false; c.roll = null; short[c.W] = (short[c.W] || 0) + c.L / 1000; }
    for (const W in out) for (const r of out[W]) { r.left = r.left / 1000; r.cuts.sort(); }
    return { ok, rolls: out, short };
  }

  // settings: {allowance, scope, level, order, timeLimit, stock} (roll widths
  // are fixed: ROLLS; settings.rolls is only for tests)
  // stock: null (no limit) or {W: [metres of each roll, ...]}.
  // solve(lpText, {timeLimit, mip}) -> Promise<{status, values}> (fromHighs).
  async function plan(allPieces, settings, solve, onStep) {
    const S = Object.assign({}, DEFAULTS, settings || {});
    S.rolls = (S.rolls || ROLLS).map(Number).filter((w) => w > 0).sort((a, b) => a - b);
    if (!S.rolls.length) throw new Error("No roll widths.");
    const step = onStep || (() => {});
    const pieces = S.level ? allPieces.filter((p) => p.level === S.level) : allPieces.slice();
    const chk = checkAllowance(S.allowance);
    if (!chk.ok) throw new Error(chk.error);
    S.allowance = chk.value;
    const maxU = S.rolls[S.rolls.length - 1] - S.allowance;
    const unfit = pieces.filter((p) => p.w > maxU);
    const fitting = pieces.filter((p) => p.w <= maxU);
    const groups = groupsOf(fitting, S.scope);

    let cuts = [], optimal = true, how = "Least film for each group";
    // 1. Least film with no stock limit: each group on its own (fast).
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      step("Group " + (gi + 1) + " of " + groups.length + ": " + g.scope + ", " + g.h + " mm");
      const model = buildModel([g], S, null);
      const res = await solve(lpText(model), { timeLimit: S.timeLimit });
      if (res.status !== "optimal" && res.status !== "feasible") throw new Error("The calculation found no plan for " + g.scope + " (" + g.h + " mm): " + (res.raw || res.status) + ".");
      if (res.status !== "optimal") optimal = false;
      cuts.push(...cutsFrom([g], model, res.values, S));
    }
    let result = finish(cuts, pieces, S, unfit);
    result.optimal = optimal;
    result.stock = null;
    // 2. Rolls on hand: keep that plan if its cuts already go on the rolls,
    //    else plan again within the rolls (cuts may move to another width).
    if (S.stock) {
      const have = {};
      for (const W of S.rolls) have[W] = (S.stock[W] || []).reduce((a, m) => a + m, 0);
      let place = placeOnRolls(result.cuts, S.stock);
      if (!place.ok) {
        const need = {};
        for (const W in result.byWidth) need[W] = result.byWidth[W].metres;
        how = "Least film within the rolls on hand";
        step("Fitting the plan to the rolls on hand (up to " + S.timeLimit + " s)");
        const model = buildModel(groups, S, S.stock);
        const res = await solve(lpText(model), { timeLimit: S.timeLimit });
        if (res.status === "optimal" || res.status === "feasible") {
          result = finish(cutsFrom(groups, model, res.values, S), pieces, S, unfit);
          result.optimal = res.status === "optimal";
          place = placeFromModel(result.cuts, model, res.values, S.stock);
          if (!result.optimal) {
            // How far from the best possible at most: the same model
            // without whole numbers gives a floor.
            step("Checking how close this is to the best possible");
            const r2 = await solve(lpText(model, true), { timeLimit: S.timeLimit });
            if (r2.status === "optimal") result.floor = r2.objective * 100 / 1e6;
          }
        } else {
          // Not enough film (or nothing found in time): show the no-limit
          // plan and what it would need.
          result.stock = { ok: false, infeasible: true, proven: res.status === "infeasible", have, need, rolls: place.rolls, short: {} };
          return Object.assign(result, meta(S, pieces, groups, how));
        }
      }
      result.stock = { ok: place.ok, infeasible: false, have, rolls: place.rolls, short: place.short };
    }
    return Object.assign(result, meta(S, pieces, groups, how));
  }

  function meta(S, pieces, groups, how) {
    return {
      settings: { rolls: S.rolls, allowance: S.allowance, scope: S.scope, level: S.level, order: batchOrder(S), stock: S.stock || null },
      scopeName: SCOPE_NAMES[S.scope] || S.scope,
      pieceCount: pieces.length, groups: groups.length, how, version: CALC_VERSION,
    };
  }

  // Independent re-check of a plan (never trust the solver blindly):
  // every planned panel exactly once, nothing changed, each cut fits its
  // roll, one height per cut, one scope group per cut, roll widths allowed.
  function verifyPlan(allPieces, result) {
    const S = result.settings;
    const problems = [];
    const pieces = S.level ? allPieces.filter((p) => p.level === S.level) : allPieces;
    const byId = new Map(pieces.map((p) => [p.id, p]));
    const seen = new Map();
    for (const c of result.cuts) {
      if (!S.rolls.includes(c.W)) problems.push(c.id + ": roll " + c.W + " mm is not in the settings");
      const ws = [];
      for (const p of c.pieces) {
        const o = byId.get(p.id);
        if (!o) { problems.push(c.id + ": " + p.id + " is not a panel of this plan"); continue; }
        if (o.w !== p.w || o.h !== p.h) problems.push(c.id + ": " + p.id + " size changed");
        if (o.h !== c.L) problems.push(c.id + ": " + p.id + " height " + o.h + " ≠ cut length " + c.L);
        if (scopeKey(S.scope, o) !== c.scope) problems.push(c.id + ": " + p.id + " is from another " + (S.scope === "location" ? "location" : "level"));
        seen.set(p.id, (seen.get(p.id) || 0) + 1);
        ws.push(o.w);
      }
      if (c.allowance !== S.allowance) problems.push(c.id + ": allowance " + c.allowance + " mm ≠ the setting " + S.allowance + " mm");
      if (across(ws, c.allowance) > c.W) problems.push(c.id + ": panels + allowance take " + across(ws, c.allowance) + " mm, roll gives " + c.W + " mm");
      if (c.used != null && c.used !== across(ws, c.allowance)) problems.push(c.id + ": used width " + c.used + " ≠ " + across(ws, c.allowance));
      const film = c.W * c.L, panels = c.pieces.reduce((a, p) => a + p.w * p.h, 0);
      if (!(film > 0) || panels > film) problems.push(c.id + ": panel area is more than the film (" + panels / 1e6 + " > " + film / 1e6 + " m²)");
    }
    const unfit = new Set((result.unfit || []).map((p) => p.id));
    for (const p of pieces) {
      const n = seen.get(p.id) || 0;
      if (unfit.has(p.id)) { if (n) problems.push(p.id + " is both cut and listed as not fitting"); continue; }
      if (n === 0) problems.push(p.id + " is in no cut");
      if (n > 1) problems.push(p.id + " is in " + n + " cuts");
    }
    return problems;
  }

  // "Pattern (mm)": 950 + 830 + 20 allowance.
  const allowanceOf = (c) => (c.allowance == null ? 0 : c.allowance);
  const pattern = (c) => c.pieces.map((p) => p.w).join(" + ") + (allowanceOf(c) ? " + " + allowanceOf(c) + " allowance" : "");
  const usedOf = (c) => (c.used != null ? c.used : c.across != null ? c.across : across(c.pieces.map((p) => p.w), allowanceOf(c)));
  const uniq = (xs) => [...new Set(xs.filter((x) => x !== "" && x != null))];
  const r3 = (x) => Math.round(x * 1000) / 1000;

  // What the Excel export holds (plain rows; the page adds the styling).
  // info: {job, file, sheet, status, approvedBy, approvedAt, version, issues}
  // Every planned panel appears once in "Piece references", with its cut.
  function exportRows(result, info) {
    const S = result.settings, T = result.totals;
    const summary = [
      ["Job", info.job || ""],
      ["Status", info.status || "NOT APPROVED (draft)"],
      ["Job list file", info.file || ""],
      ["Sheet", info.sheet || ""],
      ["Plan", result.scopeName + (S.level ? " · " + S.level + " only" : " · all levels")],
      ["Calculator", result.version + (result.optimal ? " · least film proven" : " · best found in the time allowed, not proven the least film") +
        (result.floor ? " (at most " + r3(T.film - result.floor) + " m² above the best possible)" : "")],
      ["Roll widths (mm)", S.rolls.join(", ")],
      ["Width allowance per cut (mm)", S.allowance != null ? S.allowance : "— (older plan: " + (S.blade != null ? S.blade + " mm blade between panels" : "?") + ")"],
      ["Production order (roll widths)", S.order.join(" → ")],
      [],
      ["Panels planned", T.pieces],
      ["Panels not cut (no standard roll fits width + allowance)", (result.unfit || []).length],
      ["Film cut from the rolls (m²)", r3(T.film)],
      ["Panel area (m²)", r3(T.panels)],
      ["Offcut (m²)", r3(T.offcut)],
      ["Film used (%)", Math.round(T.yield * 1000) / 10],
      ["Cuts", T.cuts],
      [],
      ["How it is worked out"],
      ["Film of a cut (m²) = roll width (m) × cut length (m); cut length = the panels' height"],
      ["Used width incl. gaps (mm) = sum of the panel widths + the allowance (one per cut); it must not be more than the stock width"],
      ["Stock width = the smallest standard roll (1000 / 1200 / 1500 / 1800 mm) the cut fits; offcut width = stock width − used width"],
      ["Stock area (m²) = stock width × cut length ÷ 1,000,000; panel area (m²) = sum of panel width × height ÷ 1,000,000 (the allowance is not panel area)"],
      ["Utilization = panel area ÷ stock area; film used (%) of the whole plan = all panel area ÷ all stock area"],
      ["Panels are never turned. Production sequence and installation release are not part of this version."],
    ];
    if (info.issues && info.issues.length) {
      summary.push([], ["Checks from the job list"]);
      for (const i of info.issues) summary.push([i.kind, i.title + (i.text ? " — " + i.text : "")]);
    }
    if (result.stock) {
      summary.push([], ["Rolls on hand", result.stock.infeasible ? "NOT ENOUGH FILM — this plan does not fit the rolls entered" : result.stock.ok ? "The plan fits the rolls entered" : "Some cuts could not be placed on a roll"]);
    }
    // The 14 columns of the cutting results (names and order as asked).
    // Roll no.: the roll on hand the cut is placed on, else the 50 m roll.
    const use = rollUse(result, 50);
    const uniqJ = (xs, many) => { const u = uniq(xs); return u.length > 1 && many ? many : u.join(", "); };
    const cuts = {
      head: ["Cut ID", "Level", "Ref #", "Location", "Roll no.", "Stock width (mm)", "Cut length (mm)", "Pieces", "Pattern (mm)", "Used width incl. gaps", "Offcut width (mm)", "Stock area (m²)", "Panel area (m²)", "Utilization", "Piece IDs"],
      rows: result.cuts.map((c) => [c.id, uniqJ(c.pieces.map((p) => p.level), "Mixed"), uniq(c.pieces.map((p) => p.ref)).join(", "), uniqJ(c.pieces.map((p) => p.loc), "Multiple locations"),
        use.rollOf[c.id] != null ? use.rollOf[c.id] : "",
        c.W, c.L, c.pieces.length, pattern(c), usedOf(c), c.W - usedOf(c), r3(c.W * c.L / 1e6), r3(c.pieces.reduce((a, p) => a + p.w * p.h, 0) / 1e6),
        c.pieces.reduce((a, p) => a + p.w * p.h, 0) / (c.W * c.L), c.pieces.map((p) => p.id).join(", ")]),
    };
    const byPiece = new Map();
    for (const c of result.cuts) for (const p of c.pieces) byPiece.set(p.id, { p, c });
    const all = [...byPiece.values()].map((x) => x.p).concat(result.unfit || []).sort((a, b) => (a.id < b.id ? -1 : 1));
    const pieces = {
      head: ["Piece", "Level", "Ref", "Location", "Type", "Width (mm)", "Height (mm)", "File row", "Cut ID", "Batch", "Stock width (mm)", "Roll no."],
      rows: all.map((p) => {
        const x = byPiece.get(p.id);
        return [p.id, p.level, p.ref, p.loc, p.type || "", p.w, p.h, p.srcRow != null ? p.srcRow : p.row, x ? x.c.id : "NOT CUT: no standard roll fits (width + allowance)", x ? x.c.batch : "", x ? x.c.W : "", x && x.c.roll != null ? x.c.roll : ""];
      }),
    };
    const batches = {
      head: ["Batch", "Roll width (mm)", "Cuts", "Length (m)", "Film (m²)"],
      rows: Object.keys(result.byWidth).map(Number).sort((a, b) => result.byWidth[a].batch - result.byWidth[b].batch)
        .map((W) => { const b = result.byWidth[W]; return [b.batch, W, b.cuts, r3(b.metres), r3(b.film)]; }),
    };
    let rolls = null;
    if (result.stock && !result.stock.infeasible) {
      rolls = { head: ["Roll width (mm)", "Roll no.", "Metres at start", "Cuts", "Metres used", "Metres left", "Cut IDs"], rows: [] };
      for (const W of Object.keys(result.stock.rolls).map(Number).sort((a, b) => a - b)) {
        for (const r of result.stock.rolls[W]) rolls.rows.push([W, r.n, r.start, r.cuts.length, r3(r.start - r.left), r3(r.left), r.cuts.join(", ")]);
      }
    }
    return { summary, cuts, pieces, batches, rolls };
  }

  window.ORYX_CUT_CORE = {
    CALC_VERSION, DEFAULTS, SCOPE_NAMES,
    ROLLS, checkAllowance, readSheet, findHeader, patterns, groupsOf, buildModel, lpText, fromHighs, plan, verifyPlan,
    placeOnRolls, rollUse, rollCount, batchOrder, across, pattern, scopeKey, exportRows,
  };
})();

// ======================================================================
// The page (all active staff). Tests load the core above without a document.
// ======================================================================
(function () {
  "use strict";
  if (typeof document === "undefined" || !window.ORYX_AUTH) return;
  const C = window.ORYX_CUT_CORE;
  const AUTH = window.ORYX_AUTH;
  const sb = AUTH.sb;
  const $ = (s, root) => (root || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Who may use it: every signed-in, switched-on staff account (the server
  // asks the same through film_cut_access()).
  const canUse = () => !!(AUTH.profile && AUTH.profile.active);
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const m2 = (x) => (Math.round(x * 100) / 100).toFixed(2) + " m²";
  const m = (x) => (Math.round(x * 10) / 10).toFixed(1) + " m";
  const pct = (x) => (Math.round(x * 1000) / 10).toFixed(1) + " %";

  const XLSX_SRC = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
  const HIGHS_BASE = "https://cdn.jsdelivr.net/npm/highs@1.15.3/build/";
  const MAX_FILE = 10 * 1024 * 1024;

  const nav = $("#navFilmCutting");
  const body = $("#fcBody");
  if (nav) nav.hidden = !canUse();
  if (!body) return;
  if (!canUse()) {
    // Typed into the page some other way: nothing to use, nothing is read
    // (the server refuses non-Admins too).
    body.innerHTML = `<div class="card fc-empty">Film Cutting needs an active staff account.</div>`;
    return;
  }

  // ---------------------------------------------------------------- libraries
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = XLSX_SRC; s.onload = res; s.onerror = () => rej(new Error("couldn't load the Excel library"));
      document.head.appendChild(s);
    });
  }

  // HiGHS runs in a Web Worker so the page stays usable while it works.
  // The script and the WebAssembly are fetched here and handed over (the
  // worker itself loads nothing).
  let solver = null;
  function startSolver() {
    if (solver) return solver.ready;
    const s = { pending: new Map(), seq: 0 };
    s.ready = (async () => {
      const [js, wasm] = await Promise.all([
        fetch(HIGHS_BASE + "highs.js").then((r) => { if (!r.ok) throw new Error("couldn't load the calculator (" + r.status + ")"); return r.text(); }),
        fetch(HIGHS_BASE + "highs.wasm").then((r) => { if (!r.ok) throw new Error("couldn't load the calculator (" + r.status + ")"); return r.arrayBuffer(); }),
      ]);
      const glue = `
        let ready = null;
        onmessage = async (e) => {
          const d = e.data;
          if (d.wasm) {
            ready = Module({
              print: () => {}, printErr: () => {},
              instantiateWasm: (imports, done) => { WebAssembly.instantiate(d.wasm, imports).then((r) => done(r.instance)); return {}; },
            });
            return;
          }
          try {
            const h = await ready;
            const r = h.solve(d.lp, d.opts);
            const cols = {};
            for (const k in r.Columns || {}) cols[k] = r.Columns[k].Primal;
            postMessage({ id: d.id, res: { Status: r.Status, ObjectiveValue: r.ObjectiveValue, Columns: cols } });
          } catch (err) { postMessage({ id: d.id, error: String(err && err.message || err) }); }
        };`;
      const url = URL.createObjectURL(new Blob([js, "\n", glue], { type: "text/javascript" }));
      const w = new Worker(url);
      w.onmessage = (e) => {
        const p = s.pending.get(e.data.id);
        if (!p) return;
        s.pending.delete(e.data.id); clearTimeout(p.timer);
        if (e.data.error) p.rej(new Error(e.data.error)); else p.res(e.data.res);
      };
      w.onerror = (e) => { for (const p of s.pending.values()) p.rej(new Error(e.message || "the calculator stopped")); s.pending.clear(); stopSolver(); };
      w.postMessage({ wasm }, [wasm]);
      s.worker = w;
    })();
    s.ready.catch(() => { solver = null; });
    solver = s;
    return s.ready;
  }
  function stopSolver() {
    if (solver && solver.worker) solver.worker.terminate();
    solver = null;
  }
  async function solve(lp, o) {
    await startSolver();
    const s = solver;
    const id = ++s.seq;
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.pending.delete(id); stopSolver(); reject(new Error("the calculator did not answer")); }, (o.timeLimit + 60) * 1000);
      s.pending.set(id, { res: resolve, rej: reject, timer });
      s.worker.postMessage({ id, lp, opts: { output_flag: false, time_limit: o.timeLimit, mip_rel_gap: 0 } });
    });
    return C.fromHighs(res);
  }
  // A failed solve can leave HiGHS in a bad state: start a fresh one once.
  async function solveSafe(lp, o) {
    try { return await solve(lp, o); }
    catch (e) { stopSolver(); return await solve(lp, o); }
  }

  async function sha256(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Rows exactly as in Excel (row 1 = grid[0]), whatever the used range.
  function gridOf(ws) {
    const X = window.XLSX;
    if (!ws || !ws["!ref"]) return [];
    const range = X.utils.decode_range(ws["!ref"]);
    const rows = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const pad = (row) => new Array(range.s.c).fill(null).concat(row);
    return new Array(range.s.r).fill(null).map(() => []).concat(rows.map(pad));
  }

  // ---------------------------------------------------------------- state
  const ui = {
    step: "upload", busy: false, progress: "", msg: null,
    file: null, book: null, sheets: [], sheet: "", read: null, job: "", showAll: false,
    settings: { scope: "level", level: "", allowance: "30", order: "1000, 1200, 1800, 1500" },
    limit: true, stock: {}, result: null, compare: null, approved: null, confirming: false, checked: false, note: "",
    saved: [], savedMsg: "", logWarn: "", cutsAll: false,
  };

  async function log(action, plan_id, details) {
    try {
      const { error } = await sb.rpc("log_film_cut", { p_action: action, p_job: ui.job || null, p_plan_id: plan_id || null, p_details: details || {} });
      if (error) throw error;
      ui.logWarn = "";
    } catch (e) {
      ui.logWarn = "Couldn't write this in the Film Cutting record: " + (e.message || e) + ".";
    }
  }

  // ---------------------------------------------------------------- reading
  async function readFile(f) {
    ui.msg = null;
    if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) { ui.msg = ["bad", "Choose an Excel file (.xlsx or .xls)."]; return render(); }
    if (f.size > MAX_FILE) { ui.msg = ["bad", "That file is over 10 MB. Choose the job list itself."]; return render(); }
    ui.busy = true; ui.progress = "Reading " + f.name + "…"; render();
    try {
      await loadXlsx();
      const buf = await f.arrayBuffer();
      const hash = await sha256(buf.slice(0));
      const book = window.XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
      ui.book = book;
      ui.sheets = book.SheetNames.slice();
      ui.file = { name: f.name, hash, size: f.size, blob: f };
      // First sheet with a Width + Height header.
      ui.sheet = ui.sheets.find((n) => C.findHeader(gridOf(book.Sheets[n]))) || ui.sheets[0];
      const jm = /^([A-Z]{2,}\d{4}-\d+)/i.exec(f.name);
      ui.job = jm ? jm[1].toUpperCase() : f.name.replace(/\.[^.]+$/, "");
      readSheet();
      log("imported", null, { file: f.name, sha256: hash, sheet: ui.sheet, panels: ui.read.pieces.length, issues: ui.read.issues.length });
    } catch (e) {
      ui.read = null; ui.file = null;
      ui.msg = ["bad", "Couldn't read this file: " + (e.message || e) + "."];
    }
    ui.busy = false; ui.progress = "";
    render();
  }
  function readSheet() {
    ui.read = C.readSheet(gridOf(ui.book.Sheets[ui.sheet]), ui.sheet);
    ui.result = null; ui.compare = null; ui.approved = null; ui.showAll = false;
    if (ui.settings.level && !ui.read.levels.includes(ui.settings.level)) ui.settings.level = "";
  }

  // ---------------------------------------------------------------- settings
  const numList = (s) => String(s || "").split(/[,;\s]+/).filter(Boolean).map(Number);
  const rollWidths = () => C.ROLLS.slice();
  function stockRow(W) { return ui.stock[W] || (ui.stock[W] = { n: "", len: "50", part: "" }); }
  // {W: [metres, ...]} from the form; problems listed in errs.
  function stockOf(errs) {
    const out = {};
    for (const W of rollWidths()) {
      const r = stockRow(W);
      const n = r.n === "" ? 0 : Number(r.n), len = Number(r.len), parts = numList(r.part);
      if (!(Number.isInteger(n) && n >= 0 && n <= 200)) errs.push("Rolls of " + W + " mm: a whole number, 0 to 200.");
      if (n > 0 && !(len > 0 && len <= 1000)) errs.push("Metres each for " + W + " mm: above 0.");
      if (parts.some((x) => !(x > 0 && x <= 1000))) errs.push("Part-used rolls of " + W + " mm: metres above 0, separated by commas.");
      out[W] = new Array(n > 0 ? n : 0).fill(len).concat(parts);
    }
    return out;
  }
  function settingsOf(scope) {
    const errs = [];
    const S = ui.settings;
    const rolls = rollWidths();
    const al = C.checkAllowance(S.allowance);
    if (!al.ok) errs.push(al.error);
    const order = numList(S.order).filter((w) => rolls.includes(w));
    let stock = null;
    if (ui.limit) {
      stock = stockOf(errs);
      if (!Object.values(stock).some((l) => l.length)) errs.push("Enter the rolls on hand, or untick \"Stay within the rolls on hand\".");
    }
    return { errs, s: { scope: scope || S.scope, level: S.level, rolls, allowance: al.value, order, stock, timeLimit: 60 } };
  }

  async function calculate() {
    const { errs, s } = settingsOf();
    if (errs.length) { ui.msg = ["bad", errs.join(" ")]; return render(); }
    ui.busy = true; ui.msg = null; ui.progress = "Loading the calculator…"; render();
    try {
      const r = await C.plan(ui.read.pieces, s, solveSafe, (t) => { ui.progress = t; render(); });
      const problems = C.verifyPlan(ui.read.pieces, r);
      if (problems.length) throw new Error("the plan failed its own check (" + problems.slice(0, 3).join("; ") + "). Nothing is shown");
      ui.result = r; ui.approved = null; ui.confirming = false; ui.checked = false; ui.cutsAll = false;
      ui.step = "results";
      log("calculated", null, { scope: s.scope, level: s.level || "all", allowance_mm: s.allowance, film_m2: Math.round(r.totals.film * 1000) / 1000, cuts: r.totals.cuts, optimal: r.optimal, stock: !!s.stock, version: r.version });
    } catch (e) {
      ui.msg = ["bad", "Couldn't calculate: " + (e.message || e) + "."];
    }
    ui.busy = false; ui.progress = "";
    render();
    window.scrollTo(0, 0);
  }

  async function compare() {
    const rows = [];
    ui.busy = true; ui.msg = null; render();
    try {
      for (const scope of ["level", "whole", "location"]) {
        const { errs, s } = settingsOf(scope);
        if (errs.length) { ui.msg = ["bad", errs.join(" ")]; break; }
        const r = await C.plan(ui.read.pieces, s, solveSafe, (t) => { ui.progress = C.SCOPE_NAMES[scope] + " · " + t; render(); });
        if (C.verifyPlan(ui.read.pieces, r).length) throw new Error("a plan failed its own check");
        rows.push(r);
      }
      if (rows.length === 3) ui.compare = rows;
    } catch (e) {
      ui.msg = ["bad", "Couldn't compare: " + (e.message || e) + "."];
    }
    ui.busy = false; ui.progress = "";
    render();
  }

  // ---------------------------------------------------------------- approve / export
  function planJson(r) {
    const piece = (p) => ({ id: p.id, level: p.level, ref: p.ref, loc: p.loc, type: p.type, w: p.w, h: p.h, row: p.row, srcRow: p.srcRow == null ? null : p.srcRow });
    return {
      scopeName: r.scopeName, version: r.version, optimal: r.optimal, floor: r.floor || null, settings: r.settings, totals: r.totals, byWidth: r.byWidth,
      cuts: r.cuts.map((c) => ({ id: c.id, batch: c.batch, scope: c.scope, W: c.W, L: c.L, allowance: c.allowance, used: c.used, spare: c.spare, film: c.film, panels: c.panels, roll: c.roll == null ? null : c.roll, pieces: c.pieces.map(piece) })),
      unfit: (r.unfit || []).map(piece), stock: r.stock, how: r.how, pieceCount: r.pieceCount,
      issues: ui.read ? ui.read.issues : [],
    };
  }
  // Keep the original Excel in the private bucket "film-cut-files" as
  // <sha256>.<ext> (supabase/sql/film_cutting_files.sql). Already there
  // (same file approved before) counts as kept. Never blocks the approval.
  const FILE_BUCKET = "film-cut-files";
  const MIME = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", xls: "application/vnd.ms-excel" };
  async function keepFile() {
    try {
      const ext = ((/\.(xlsx|xlsm|xls)$/i.exec(ui.file.name) || [])[1] || "").toLowerCase();
      if (!ext || !ui.file.blob) return { error: "no file" };
      const path = ui.file.hash + "." + ext;
      const { error } = await sb.storage.from(FILE_BUCKET).upload(path, ui.file.blob, { upsert: false, contentType: MIME[ext] });
      if (!error || /exist|duplicate/i.test(error.message || "") || String(error.statusCode) === "409") return { path };
      return { error: error.message || String(error) };
    } catch (e) { return { error: e.message || String(e) }; }
  }
  async function approve() {
    const r = ui.result;
    if (!r || ui.approved) return;
    if (r.stock && r.stock.infeasible) return;
    ui.busy = true; ui.progress = "Keeping the original file…"; render();
    try {
      const kept = await keepFile();
      ui.progress = "Saving the approved plan…"; render();
      const p = {
        job: ui.job, scope: r.settings.scope, level: r.settings.level || "", source_file_name: ui.file.name, source_file_hash: ui.file.hash,
        source_file_path: kept.path || "",
        sheet: ui.sheet, calc_version: r.version, optimal: r.optimal, settings: r.settings, totals: r.totals, plan: planJson(r), note: ui.note,
      };
      let { data, error } = await sb.rpc("approve_film_cut_plan", { p_plan: p });
      if (error && /file_not_stored/.test(error.message || "")) {
        kept.error = "the file was not found in storage"; p.source_file_path = "";
        ({ data, error } = await sb.rpc("approve_film_cut_plan", { p_plan: p }));
      }
      if (error) throw error;
      ui.approved = { id: data.id, version: data.version, by: data.approved_by_name, at: new Date().toISOString() };
      ui.msg = data.file_kept ? ["ok", "Approved and saved as version " + data.version + " of " + ui.job + ", with the original Excel file."]
        : ["ok", "Approved and saved as version " + data.version + " of " + ui.job + ". The original Excel file could not be kept" + (kept.error ? " (" + kept.error + ")" : "") + "; the plan itself is saved."];
      loadSaved();
    } catch (e) {
      const t = String(e.message || e);
      ui.msg = ["bad", "Not approved: " + (/not_allowed/.test(t) ? "your account is not allowed to approve plans." : /job_missing/.test(t) ? "enter the job name." : t) + " Nothing was saved."];
    }
    ui.confirming = false; ui.busy = false; ui.progress = "";
    render();
  }

  const BRAND = "022A3A";
  const S_TITLE = { font: { bold: true, sz: 14, color: { rgb: BRAND } } };
  const S_HEAD = { fill: { fgColor: { rgb: BRAND } }, font: { bold: true, color: { rgb: "FFFFFF" } }, alignment: { vertical: "center", wrapText: true } };
  const S_BOLD = { font: { bold: true, color: { rgb: BRAND } } };
  function table(X, title, t, widths, formats) {
    const ws = X.utils.aoa_to_sheet([[title], [], t.head, ...t.rows]);
    for (const [c, z] of Object.entries(formats || {})) {
      for (let r = 0; r < t.rows.length; r++) { const cell = ws[X.utils.encode_cell({ r: r + 3, c: Number(c) })]; if (cell && typeof cell.v === "number") cell.z = z; }
    }
    ws["!cols"] = widths.map((w) => ({ wch: w }));
    ws.A1.s = S_TITLE;
    for (let c = 0; c < t.head.length; c++) ws[X.utils.encode_cell({ r: 2, c })].s = S_HEAD;
    ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: 2 + t.rows.length, c: t.head.length - 1 } }) };
    return ws;
  }
  // result: a fresh result or a saved plan's JSON; info as in exportRows.
  async function exportExcel(result, info, planId) {
    try {
      await loadXlsx();
      const X = window.XLSX;
      const e = C.exportRows(result, info);
      const wb = X.utils.book_new();
      const ws = X.utils.aoa_to_sheet([["Film cutting plan — " + (info.job || "")], [], ...e.summary]);
      ws["!cols"] = [{ wch: 42 }, { wch: 90 }];
      ws.A1.s = S_TITLE;
      e.summary.forEach((row, i) => { if (row.length === 1 && ws["A" + (i + 3)]) ws["A" + (i + 3)].s = S_BOLD; });
      X.utils.book_append_sheet(wb, ws, "Summary");
      X.utils.book_append_sheet(wb, table(X, "Cutting results — " + result.scopeName + (result.settings.allowance != null ? " · allowance " + result.settings.allowance + " mm per cut" : ""), e.cuts, [8, 10, 8, 24, 8, 10, 10, 7, 26, 12, 10, 10, 10, 8, 26], { 11: "0.000", 12: "0.000", 13: "0.0%" }), "Cutting results");
      X.utils.book_append_sheet(wb, table(X, "Piece references", e.pieces, [8, 10, 6, 24, 8, 10, 10, 8, 40, 7, 12, 8]), "Piece references");
      X.utils.book_append_sheet(wb, table(X, "Production batches (one roll width at a time)", e.batches, [8, 14, 8, 12, 12]), "Production batches");
      if (e.rolls) X.utils.book_append_sheet(wb, table(X, "Cuts on each roll", e.rolls, [14, 8, 14, 8, 12, 12, 60]), "Rolls");
      const scope = (result.scopeName || "").replace(/\s+/g, " ");
      const name = ((info.job || "Film cutting") + " cutting plan " + scope + (result.settings.level ? " " + result.settings.level : "") + (info.version ? " v" + info.version : " DRAFT")).replace(/[\\/:*?"<>|]+/g, "-") + ".xlsx";
      X.writeFile(wb, name);
      log("exported", planId || null, { file: name, approved: !!info.version });
    } catch (err) {
      ui.msg = ["bad", "Couldn't make the Excel file: " + (err.message || err) + "."];
      render();
    }
  }
  function exportCurrent() {
    const r = ui.result;
    const a = ui.approved;
    exportExcel(r, {
      job: ui.job, file: ui.file && ui.file.name, sheet: ui.sheet, issues: ui.read && ui.read.issues,
      status: a ? "APPROVED · version " + a.version + " · " + (a.by || "") + " · " + when(a.at) : "NOT APPROVED (draft)",
      version: a && a.version,
    }, a && a.id);
  }
  // The kept original Excel, through a 5-minute signed link.
  async function downloadOriginal(path, name) {
    const { data, error } = await sb.storage.from(FILE_BUCKET).createSignedUrl(path, 300, { download: name || true });
    if (error || !data || !data.signedUrl) { ui.savedMsg = "Couldn't open the original file: " + ((error && error.message) || "no link") + "."; return render(); }
    const a = document.createElement("a");
    a.href = data.signedUrl; a.rel = "noopener"; a.download = name || "";
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function exportSaved(id) {
    const { data, error } = await sb.from("film_cut_plans").select("*").eq("id", id).maybeSingle();
    if (error || !data) { ui.savedMsg = "Couldn't open that plan: " + ((error && error.message) || "not found") + "."; return render(); }
    const r = Object.assign({}, data.plan, { cuts: data.plan.cuts, settings: data.plan.settings || data.settings });
    exportExcel(r, {
      job: data.job, file: data.source_file_name, sheet: data.sheet, issues: data.plan.issues || [], version: data.version,
      status: "APPROVED · version " + data.version + " · " + (data.approved_by_name || "") + " · " + when(data.approved_at) + (data.note ? " · " + data.note : ""),
    }, data.id);
  }

  async function loadSaved() {
    const { data, error } = await sb.from("film_cut_plans")
      .select("id, job, version, scope, level, totals, optimal, approved_by_name, approved_at, source_file_name, source_file_path")
      .order("approved_at", { ascending: false }).order("id").limit(30);
    if (error) { ui.saved = []; ui.savedMsg = /film_cut_plans/.test(error.message || "") ? "Approved plans can't be listed yet (the Film Cutting tables are not set up)." : "Couldn't load the approved plans: " + error.message; }
    else { ui.saved = data || []; ui.savedMsg = ""; }
    render();
  }

  // ---------------------------------------------------------------- drawing
  const STEPS = [["upload", "1 Upload"], ["settings", "2 Settings"], ["results", "3 Results"], ["approve", "4 Approve + export"]];
  function stepper() {
    const at = ui.step === "results" && ui.approved ? 4 : STEPS.findIndex((s) => s[0] === ui.step) + 1;
    return `<ol class="fc-steps">${STEPS.map(([k, t], i) => `<li class="${i + 1 < at ? "done" : i + 1 === at ? "on" : ""}">${esc(t)}${i + 1 < at ? " ✓" : ""}</li>`).join("")}</ol>`;
  }
  const tile = (label, value, sub) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<span class="kpi-note">${esc(sub)}</span>` : ""}</div>`;
  const KIND_CLASS = { ERROR: "no", "LEFT OUT": "grey", CHECK: "warn", INFO: "dark" };

  function drawUpload() {
    const r = ui.read;
    let h = `<div class="card fc-file">
      <div><div class="fc-file-name">${ui.file ? esc(ui.file.name) : "Choose the job list"}</div>
        <div class="small muted">${ui.file ? "Read in your browser · never changed · nothing saved until you approve a plan" : "The job list (Width (mm), Height (mm), Qty and LEVEL rows) or a piece list (Piece, Level, Ref, Location, Type, Width (mm), Height (mm), File row)."}</div></div>
      <label class="btn-${ui.file ? "outline" : "yellow"} fc-file-btn" for="fcFile">${ui.file ? "Upload another file" : "Upload the job list"}</label>
      <input id="fcFile" type="file" accept=".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden>
    </div>`;
    if (r) {
      const errs = r.issues.filter((i) => i.kind === "ERROR").length;
      const rooms = new Set(r.pieces.map((p) => p.level + "|" + p.ref)).size;
      const area = r.pieces.reduce((a, p) => a + p.w * p.h, 0) / 1e6;
      const left = r.issues.filter((i) => i.kind === "LEFT OUT").length;
      h += `<div class="card fc-job">
        <div class="fc-field"><label class="field-label" for="fcJob">Job</label><input id="fcJob" value="${esc(ui.job)}" maxlength="120"></div>
        <div class="fc-field"><label class="field-label" for="fcSheet">Sheet</label><select id="fcSheet">${ui.sheets.map((n) => `<option ${n === ui.sheet ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
        <div class="small muted fc-job-note">${r.header ? "Header on row " + r.header.row + " · panels from the rows below it" : ""}</div>
      </div>
      <div class="kpis fc-kpis">${tile("Panels", String(r.pieces.length), left ? left + " row" + (left === 1 ? "" : "s") + " without a quantity left out" : "")}${tile("Rooms", String(rooms), "")}${tile("Levels", String(r.levels.length), r.levels.length ? r.levels[0] + (r.levels.length > 1 ? " – " + r.levels[r.levels.length - 1] : "") : "")}${tile("Panel area", m2(area), "film that ends up on glass")}</div>`;
      if (r.issues.length) {
        const c = { ERROR: 0, CHECK: 0 };
        r.issues.forEach((i) => { if (c[i.kind] != null) c[i.kind]++; });
        h += `<div class="card fc-issues"><div class="fc-card-h"><h2 class="card-title">Check before planning</h2>
          <span class="badge ${errs ? "no" : "warn"}">${c.CHECK} to check · ${errs} error${errs === 1 ? "" : "s"}</span></div>
          <ul class="fc-issue-list">${r.issues.map((i) => `<li class="fc-issue ${KIND_CLASS[i.kind] || ""}"><span class="fc-kind">${esc(i.kind)}</span><div><b>${esc(i.title)}</b>${i.text ? `<span>${esc(i.text)}</span>` : ""}</div></li>`).join("")}</ul></div>`;
      }
      const rows = ui.showAll ? r.pieces : r.pieces.slice(0, 12);
      h += `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Panels read (${rows.length === r.pieces.length ? "all " + r.pieces.length : "first " + rows.length + " of " + r.pieces.length})</h2>
        <span class="small muted">Heights as in the file (measured + allowance)</span></div>
        <div class="fc-scroll"><table class="fc-table"><thead><tr><th>Piece</th><th>Level</th><th>Ref</th><th>Location</th><th>Type</th><th class="r">Width (mm)</th><th class="r">Height (mm)</th><th class="r">File row</th></tr></thead><tbody>
        ${rows.map((p) => `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.level)}</td><td>${esc(p.ref)}</td><td>${esc(p.loc)}</td><td>${esc(p.type)}</td><td class="r">${p.w}</td><td class="r">${p.h}</td><td class="r muted">${p.srcRow != null ? p.srcRow : p.row}${p.of ? " · " + esc(p.of) : ""}</td></tr>`).join("")}
        </tbody></table></div>
        ${r.pieces.length > rows.length ? `<div class="fc-more"><button type="button" class="btn-outline btn-sm" data-act="all-pieces">Show all ${r.pieces.length}</button></div>` : ""}</div>`;
      h += `<div class="fc-bar"><span>${errs ? "Fix the " + (errs === 1 ? "error" : errs + " errors") + " in the file and upload it again." : r.pieces.length + " panels ready. Nothing is saved until you approve a plan. Stock is never touched."}</span>
        <button type="button" class="btn-yellow" data-act="to-settings" ${errs || !r.pieces.length ? "disabled" : ""}>Continue to settings</button></div>`;
    }
    h += savedHtml();
    return h;
  }

  function savedHtml() {
    if (!ui.saved.length && !ui.savedMsg) return "";
    return `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Approved plans</h2><span class="small muted">Saved with who approved them and when</span></div>
      ${ui.savedMsg ? `<p class="small muted fc-pad">${esc(ui.savedMsg)}</p>` : ""}
      ${ui.saved.length ? `<div class="fc-scroll"><table class="fc-table"><thead><tr><th>Job</th><th>Version</th><th>Plan</th><th class="r">Film</th><th class="r">Cuts</th><th>Approved</th><th>Original file</th><th></th></tr></thead><tbody>
      ${ui.saved.map((p) => `<tr><td>${esc(p.job)}</td><td>v${p.version}</td><td>${esc(C.SCOPE_NAMES[p.scope] || p.scope)}${p.level ? " · " + esc(p.level) : ""}</td>
        <td class="r">${p.totals && p.totals.film != null ? m2(p.totals.film) : ""}</td><td class="r">${p.totals ? esc(p.totals.cuts) : ""}</td>
        <td>${esc(p.approved_by_name || "")} · ${esc(when(p.approved_at))}</td>
        <td>${p.source_file_path ? `<button type="button" class="btn-outline btn-sm" data-act="download-original" data-path="${esc(p.source_file_path)}" data-name="${esc(p.source_file_name || p.source_file_path)}" title="${esc(p.source_file_name || "")}">Download</button>` : `<span class="small muted">not kept</span>`}</td>
        <td><button type="button" class="btn-outline btn-sm" data-act="export-saved" data-id="${esc(p.id)}">Excel</button></td></tr>`).join("")}
      </tbody></table></div>` : ""}</div>`;
  }

  // "950 + 830 + 20 = 1800 mm → 1800 roll" with the allowance as typed.
  function allowanceExample() {
    const a = C.checkAllowance(ui.settings.allowance);
    if (!a.ok) return `<span class="fc-bad">${esc(a.error)}</span>`;
    const need = 950 + 830 + a.value;
    const roll = C.ROLLS.find((W) => need <= W);
    return `Each cut: panel widths + ${a.value} mm allowance must fit the roll. Example: 950 + 830 + ${a.value} = ${need} mm → ${roll ? roll + " mm roll, " + (roll - need) + " mm offcut" : "<b>no standard roll fits</b> (widest is " + C.ROLLS[C.ROLLS.length - 1] + " mm)"}.`;
  }

  function drawSettings() {
    const S = ui.settings, r = ui.read;
    const rolls = rollWidths();
    const scopes = [["level", "By level", "Panels of one level are cut together (the team's choice)"], ["whole", "Whole job", "Any panels of the same height share cuts: least film"], ["location", "By location", "Each room on its own: most film, easiest to sort"]];
    let h = `<div class="card"><h2 class="card-title">Plan</h2>
      <div class="pill-row fc-scopes" role="group" aria-label="Plan">${scopes.map(([k, t, d]) => `<button type="button" class="pill ${S.scope === k ? "on" : ""}" data-act="scope" data-scope="${k}" title="${esc(d)}">${t}</button>`).join("")}</div>
      <p class="small muted fc-tight">${esc(scopes.find((x) => x[0] === S.scope)[2])}.</p>
      <div class="fc-form">
        <div class="fc-field"><label class="field-label" for="fcLevel">Levels</label><select id="fcLevel"><option value="">All levels (${r.pieces.length} panels)</option>${r.levels.map((l) => `<option value="${esc(l)}" ${S.level === l ? "selected" : ""}>${esc(l)} only (${r.pieces.filter((p) => p.level === l).length} panels)</option>`).join("")}</select></div>
        <div class="fc-field"><label class="field-label" for="fcAllow">Width allowance per cut (mm)</label><input id="fcAllow" value="${esc(S.allowance)}" inputmode="decimal" aria-describedby="fcAllowEx"></div>
        <div class="fc-field"><span class="field-label">Standard roll widths (mm)</span><div class="fc-fixed">${C.ROLLS.join(" · ")}</div></div>
        <div class="fc-field"><label class="field-label" for="fcOrder">Production order (roll widths)</label><input id="fcOrder" value="${esc(S.order)}"></div>
      </div>
      <p class="small fc-tight" id="fcAllowEx">${allowanceExample()}</p>
      <p class="small muted fc-tight">Only panels of the same height share a cut. Panels are never turned. The smallest roll that fits is used.</p></div>`;
    const errs = [];
    const st = stockOf(errs);
    h += `<div class="card fc-tbl-card"><div class="fc-card-h"><div><h2 class="card-title">Film rolls in stock</h2>
        <div class="small muted">Rolls on hand for this job. A part-used roll: its metres left (e.g. 12.5, 3). A cut never runs across two rolls.</div></div>
        <label class="fc-check"><input type="checkbox" id="fcLimit" ${ui.limit ? "checked" : ""}> Stay within the rolls on hand</label></div>
      <div class="fc-scroll"><table class="fc-table ${ui.limit ? "" : "fc-off"}"><thead><tr><th>Roll width</th><th class="r">Rolls</th><th class="r">Metres each</th><th>Part-used rolls (m)</th><th class="r">In stock</th></tr></thead><tbody>
      ${rolls.map((W) => { const x = stockRow(W); const tot = (st[W] || []).reduce((a, b) => a + b, 0); return `<tr><td><b>${W} mm</b></td>
        <td class="r"><input class="fc-num" data-stock="${W}" data-k="n" value="${esc(x.n)}" inputmode="numeric" aria-label="Rolls of ${W} mm" ${ui.limit ? "" : "disabled"}></td>
        <td class="r"><input class="fc-num" data-stock="${W}" data-k="len" value="${esc(x.len)}" inputmode="decimal" aria-label="Metres each, ${W} mm" ${ui.limit ? "" : "disabled"}></td>
        <td><input class="fc-parts" data-stock="${W}" data-k="part" value="${esc(x.part)}" aria-label="Part-used rolls of ${W} mm" ${ui.limit ? "" : "disabled"}></td>
        <td class="r" data-total="${W}">${tot ? m(tot) : "—"}</td></tr>`; }).join("")}
      </tbody></table></div>
      ${ui.limit ? "" : `<p class="small fc-warn fc-pad">Not limited: the plan may need more film than you have.</p>`}</div>`;
    if (ui.compare) {
      const best = Math.min(...ui.compare.map((x) => x.totals.film));
      h += `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Compare the plans</h2><span class="small muted">Same settings${S.level ? ", " + esc(S.level) + " only" : ""}</span></div>
        <div class="fc-scroll"><table class="fc-table"><thead><tr><th>Plan</th><th class="r">Film</th><th class="r">Panels</th><th class="r">Offcut</th><th class="r">Film used</th><th class="r">Cuts</th><th>Rolls on hand</th><th></th></tr></thead><tbody>
        ${ui.compare.map((x) => `<tr><td><b>${esc(x.scopeName)}</b>${x.optimal ? "" : ` <span class="badge warn" title="Best found in the time allowed">not proven</span>`}</td><td class="r">${m2(x.totals.film)}${x.totals.film > best + 1e-9 ? `<span class="small muted"> (+${m2(x.totals.film - best)})</span>` : ""}</td>
          <td class="r">${m2(x.totals.panels)}</td><td class="r">${m2(x.totals.offcut)}</td><td class="r">${pct(x.totals.yield)}</td><td class="r">${x.totals.cuts}</td>
          <td>${x.stock ? (x.stock.infeasible ? `<span class="badge no">Not enough film</span>` : x.stock.ok ? `<span class="badge ok">Fits</span>` : `<span class="badge warn">Doesn't fit</span>`) : "Not limited"}</td>
          <td><button type="button" class="btn-outline btn-sm" data-act="use-scope" data-scope="${x.settings.scope}">Use this plan</button></td></tr>`).join("")}
        </tbody></table></div></div>`;
    }
    h += `<div class="fc-bar"><button type="button" class="btn-outline fc-on-dark" data-act="back-upload">Back</button>
      <span class="fc-grow"></span>
      <button type="button" class="btn-outline fc-on-dark" data-act="compare">Compare the 3 plans</button>
      <button type="button" class="btn-yellow" data-act="calculate">Calculate</button></div>`;
    return h;
  }

  // Rolls the plan takes: "4 of 46" with rolls on hand, else full 50 m rolls.
  function rollsTile(r) {
    if (r.stock && r.stock.infeasible) return "";
    const rc = C.rollCount(r, 50);
    const per = Object.keys(rc.byWidth).map((W) => W + ": " + rc.byWidth[W].used + (rc.byWidth[W].of != null ? " of " + rc.byWidth[W].of : "")).join(" · ");
    return rc.of != null ? tile("Rolls", rc.used + " of " + rc.of, per)
      : tile("Rolls (50 m)", String(rc.used), per + " · no rolls on hand entered");
  }
  // Only the rolls the plan uses; the unused ones in one line.
  function rollLines(rolls) {
    if (!rolls.length) return "none";
    const used = rolls.filter((x) => x.cuts.length), unused = rolls.filter((x) => !x.cuts.length);
    const lines = used.map((x) => `Roll ${x.n} (${m(x.start)}): ${x.cuts.length} cut${x.cuts.length === 1 ? "" : "s"}, ${m(x.left)} left`);
    if (unused.length) {
      const same = unused.every((x) => x.start === unused[0].start);
      lines.push(`<span class="muted">${used.length ? "+ " : ""}${unused.length} roll${unused.length === 1 ? "" : "s"} not used (${same ? m(unused[0].start) + " each" : m(unused.reduce((a, x) => a + x.start, 0)) + " in all"})</span>`);
    }
    return lines.join("<br>");
  }

  function drawResults() {
    const r = ui.result, T = r.totals, S = r.settings;
    const infeasible = r.stock && r.stock.infeasible;
    let h = "";
    h += `<div class="kpis fc-kpis">${tile("Film", m2(T.film), "cut from the rolls")}${tile("Panels", m2(T.panels), T.pieces + " panels on glass")}${tile("Film used", pct(T.yield), "offcuts " + m2(T.offcut))}${tile("Cuts", String(T.cuts), "allowance " + S.allowance + " mm per cut")}${rollsTile(r)}</div>`;
    if (infeasible) {
      h += `<div class="fc-note bad"><b>Not enough film in the rolls entered.</b> ${r.stock.proven ? "No plan fits them." : "No plan that fits them was found in the time allowed."} Below is the plan with unlimited film; it needs:
        <ul>${Object.keys(r.stock.need).map((W) => `<li>${W} mm: ${m(r.stock.need[W])} (in stock ${m(r.stock.have[W] || 0)})</li>`).join("")}</ul>Add rolls, or change the plan, then calculate again. This plan can't be approved.</div>`;
    } else if (r.optimal) {
      h += `<div class="fc-note ok"><b>Least film possible${S.level ? " for " + esc(S.level) : ""} with these rules${r.stock ? " and the rolls on hand" : ""}.</b> Every one of the ${T.pieces} panels is in exactly one cut. No panel was left out, doubled or changed.</div>`;
    } else {
      h += `<div class="fc-note warn"><b>Best plan found in the time allowed — not proven the least film.</b>${r.floor ? " At most " + m2(Math.max(0, T.film - r.floor)) + " more than the best possible." : ""} Every one of the ${T.pieces} panels is in exactly one cut.</div>`;
    }
    if (r.unfit.length) h += `<div class="fc-note bad"><b>${r.unfit.length} panel${r.unfit.length === 1 ? "" : "s"} can't go on any standard roll (width + ${esc(S.allowance)} mm allowance is more than ${C.ROLLS[C.ROLLS.length - 1]} mm), so ${r.unfit.length === 1 ? "it is" : "they are"} not cut:</b> ${r.unfit.map((p) => esc(p.id + " (" + p.w + " × " + p.h + " mm, file row " + (p.srcRow != null ? p.srcRow : p.row) + ")")).join(", ")}</div>`;
    // rolls on hand
    if (r.stock && !infeasible) {
      h += `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Rolls on hand</h2>${r.stock.ok ? `<span class="badge ok">Fits the rolls</span>` : `<span class="badge no">Doesn't fit</span>`}</div>
        <div class="fc-scroll"><table class="fc-table"><thead><tr><th>Roll width</th><th class="r">In stock</th><th class="r">Plan uses</th><th>Each roll</th></tr></thead><tbody>
        ${Object.keys(r.stock.rolls).map(Number).sort((a, b) => a - b).map((W) => { const rolls = r.stock.rolls[W]; const use = r.byWidth[W] ? r.byWidth[W].metres : 0;
          return `<tr><td><b>${W} mm</b></td><td class="r">${m(r.stock.have[W] || 0)}</td><td class="r">${m(use)}</td>
          <td class="small">${rollLines(rolls)}</td></tr>`; }).join("")}
        </tbody></table></div>
        ${r.stock.ok ? "" : `<p class="small fc-warn fc-pad">Short: ${Object.keys(r.stock.short).map((W) => W + " mm " + m(r.stock.short[W])).join(", ")}.</p>`}</div>`;
    }
    // batches
    h += `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Production batches (one roll width at a time)</h2></div>
      <div class="fc-scroll"><table class="fc-table"><thead><tr><th>Batch</th><th>Roll width</th><th class="r">Cuts</th><th class="r">Length</th><th class="r">Film</th></tr></thead><tbody>
      ${Object.keys(r.byWidth).map(Number).sort((a, b) => r.byWidth[a].batch - r.byWidth[b].batch).map((W) => { const b = r.byWidth[W];
        return `<tr><td>${b.batch}</td><td><b>${W} mm</b></td><td class="r">${b.cuts}</td><td class="r">${m(b.metres)}</td><td class="r">${m2(b.film)}</td></tr>`; }).join("")}
      </tbody></table></div></div>`;
    // cut list: the 14 columns of the cutting workbook / prompt, in order
    const cuts = ui.cutsAll ? r.cuts : r.cuts.slice(0, 15);
    const e = C.exportRows(r, {});
    const rowsById = new Map(e.cuts.rows.map((x) => [x[0], x]));
    h += `<div class="card fc-tbl-card"><div class="fc-card-h"><h2 class="card-title">Cutting results (${cuts.length === r.cuts.length ? "all " + r.cuts.length : cuts.length + " of " + r.cuts.length + " shown"})</h2>
      <span class="small muted">One row per cut · used width = panel widths + ${esc(S.allowance)} mm allowance</span></div>
      <div class="fc-scroll"><table class="fc-table fc-results"><thead><tr>${e.cuts.head.map((t, i) => `<th class="${i >= 4 && i <= 13 && i !== 8 ? "r" : ""}">${esc(t)}</th>`).join("")}</tr></thead><tbody>
      ${cuts.map((c) => { const x = rowsById.get(c.id); return `<tr>${x.map((v, i) => `<td class="${i === 0 || i === 14 ? "mono" : ""}${i >= 4 && i <= 13 && i !== 8 ? " r" : ""}">${esc(i === 4 ? (v === "" ? "—" : "Roll " + v) : i === 11 || i === 12 ? v.toFixed(3) : i === 13 ? (Math.round(v * 1000) / 10).toFixed(1) + "%" : v)}</td>`).join("")}</tr>`; }).join("")}
      </tbody></table></div>
      ${r.cuts.length > cuts.length ? `<div class="fc-more"><button type="button" class="btn-outline btn-sm" data-act="all-cuts">Show all ${r.cuts.length} cuts</button></div>` : ""}</div>`;
    // approve + export
    const a = ui.approved;
    const flagged = (ui.read ? ui.read.issues : []).filter((i) => i.kind === "CHECK" || i.kind === "LEFT OUT").length;
    h += `<div class="card fc-approve"><h2 class="card-title">Approve and export</h2>`;
    if (a) {
      h += `<div class="fc-note ok"><b>Approved · version ${a.version} of ${esc(ui.job)}</b> · ${esc(a.by || "")} · ${esc(when(a.at))}</div>`;
    } else if (!infeasible) {
      h += `<p class="small muted">Approving saves this plan as the next version of job <b>${esc(ui.job)}</b> (who, when, settings, calculator version, every cut with its panels). Your uploaded file is never changed. Stock is never touched.</p>
        <div class="fc-field fc-wide"><label class="field-label" for="fcNote">Note (optional)</label><input id="fcNote" maxlength="300" value="${esc(ui.note)}"></div>
        <label class="fc-check"><input type="checkbox" id="fcChecked" ${ui.checked ? "checked" : ""}> I checked the plan${flagged ? " and the " + flagged + " flagged row" + (flagged === 1 ? "" : "s") + " from the job list" : ""}.</label>`;
      if (ui.confirming) h += `<div class="fc-confirm"><span>Approve <b>${esc(r.scopeName)}${S.level ? " · " + esc(S.level) : ""}</b> (${m2(T.film)}, ${T.cuts} cuts) for job <b>${esc(ui.job)}</b>?</span>
          <button type="button" class="btn-yellow" data-act="approve-yes">Yes, approve</button><button type="button" class="btn-outline" data-act="approve-no">Cancel</button></div>`;
    }
    h += `<div class="fc-row">${!a && !infeasible && !ui.confirming ? `<button type="button" class="btn-yellow" data-act="approve" ${ui.checked && ui.job.trim() ? "" : "disabled"}>Approve plan</button>` : ""}
      <button type="button" class="btn-outline" data-act="export">${a ? "Export to Excel" : "Export draft to Excel"}</button>
      <button type="button" class="btn-outline" data-act="to-settings">Change settings</button>
      <button type="button" class="btn-outline" data-act="reset">Start a new test</button></div>
      <p class="small muted fc-tight">Production sequence and installation release come later (Phase 2), once those rules are agreed.</p></div>`;
    return h;
  }

  let drawing = false;
  function render() {
    if (drawing) return;
    drawing = true;
    try {
      const head = $("#fcHeadSub");
      if (head) head.textContent = ui.read && ui.step !== "upload" ? (ui.job || "") + " · " + (ui.result && ui.step === "results" ? ui.result.scopeName + (ui.result.settings.level ? " · " + ui.result.settings.level : " · all levels") + " · " + ui.result.pieceCount + " panels · allowance " + ui.result.settings.allowance + " mm" : ui.read.pieces.length + " panels") : "Plan how smart film is cut from the rolls, with the least film";
      let h = stepper();
      if (ui.msg) h += `<div class="fc-note ${ui.msg[0] === "ok" ? "ok" : "bad"}" role="status">${esc(ui.msg[1])}</div>`;
      if (ui.logWarn) h += `<div class="fc-note warn small">${esc(ui.logWarn)}</div>`;
      if (ui.busy) h += `<div class="fc-note busy" role="status"><span class="fc-spin" aria-hidden="true"></span>${esc(ui.progress || "Working…")}</div>`;
      h += ui.step === "settings" && ui.read ? drawSettings() : ui.step === "results" && ui.result ? drawResults() : drawUpload();
      body.innerHTML = h;
      body.classList.toggle("fc-busy", ui.busy);
      body.querySelectorAll("button").forEach((b) => { if (ui.busy) b.disabled = true; });
    } finally { drawing = false; }
    saveWorkSoon();
  }

  // ---------------------------------------------------------------- work kept across a reload
  // The unfinished work (the uploaded file itself, the step, settings, rolls
  // on hand, the last result) is kept in this browser's IndexedDB, for the
  // signed-in person only, so a reload comes back to the same place (user's
  // request 2026-10-29). "Start a new test" clears it. Nothing goes to the
  // server; approved plans are saved there as before.
  const WORK_DB = "oryx-film-cut", WORK_KEY = "current", WORK_DAYS = 14;
  function workStore(mode, fn) {
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(WORK_DB, 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => req.result.createObjectStore("work");
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction("work", mode), st = tx.objectStore("work");
        const r = fn(st);
        tx.oncomplete = () => { db.close(); res(r && r.result); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }
  const uid = () => (AUTH.user && AUTH.user.id) || "";
  let saveTimer = null, restoring = false;
  function saveWorkSoon() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWork, 400);
  }
  function saveWork() {
    if (!ui.file || !ui.file.blob || !ui.read) return;
    let result = null;
    try { result = ui.result ? JSON.parse(JSON.stringify(ui.result)) : null; } catch (e) { result = null; }
    const rec = {
      uid: uid(), at: Date.now(), file: ui.file.blob, name: ui.file.name, hash: ui.file.hash, size: ui.file.size,
      sheet: ui.sheet, job: ui.job, step: ui.step, settings: ui.settings, limit: ui.limit, stock: ui.stock, note: ui.note,
      result, approved: ui.approved,
    };
    workStore("readwrite", (st) => st.put(rec, WORK_KEY)).catch(() => { /* private mode / storage full: just not kept */ });
  }
  function clearWork() { workStore("readwrite", (st) => st.delete(WORK_KEY)).catch(() => {}); }
  async function restoreWork() {
    let rec = null;
    try { rec = await workStore("readonly", (st) => st.get(WORK_KEY)); } catch (e) { return; }
    if (!rec || !rec.file || rec.uid !== uid() || Date.now() - rec.at > WORK_DAYS * 864e5) return;
    restoring = true;
    try {
      await loadXlsx();
      const buf = await rec.file.arrayBuffer();
      ui.book = window.XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellText: false, cellStyles: false });
      ui.sheets = ui.book.SheetNames.slice();
      ui.file = { name: rec.name, hash: rec.hash, size: rec.size, blob: rec.file };
      ui.sheet = ui.sheets.includes(rec.sheet) ? rec.sheet : ui.sheets[0];
      ui.read = C.readSheet(gridOf(ui.book.Sheets[ui.sheet]), ui.sheet);
      Object.assign(ui.settings, rec.settings || {});
      ui.limit = rec.limit !== false; ui.stock = rec.stock || {}; ui.job = rec.job || ""; ui.note = rec.note || "";
      // A kept result is shown again only if it still checks out against the file.
      if (rec.result && !C.verifyPlan(ui.read.pieces, rec.result).length) { ui.result = rec.result; ui.approved = rec.approved || null; }
      ui.step = rec.step === "results" && !ui.result ? "settings" : rec.step || "upload";
      ui.msg = ["ok", "Your work on " + (ui.job || rec.name) + " was kept after the reload. To begin again: \"Upload another file\", or \"Start a new test\" on the results."];
    } catch (e) {
      clearWork();
    } finally { restoring = false; }
    render();
  }

  // ---------------------------------------------------------------- events
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || ui.busy) return;
    const act = b.dataset.act;
    if (act === "to-settings") { ui.step = "settings"; ui.msg = null; render(); window.scrollTo(0, 0); }
    else if (act === "back-upload") { ui.step = "upload"; ui.msg = null; render(); }
    else if (act === "reset") {
      clearWork();
      Object.assign(ui, { step: "upload", msg: null, file: null, book: null, sheets: [], sheet: "", read: null, job: "", showAll: false,
        result: null, compare: null, approved: null, confirming: false, checked: false, note: "", cutsAll: false });
      render(); window.scrollTo(0, 0);
    }
    else if (act === "all-pieces") { ui.showAll = true; render(); }
    else if (act === "all-cuts") { ui.cutsAll = true; render(); }
    else if (act === "scope") { ui.settings.scope = b.dataset.scope; render(); }
    else if (act === "use-scope") { ui.settings.scope = b.dataset.scope; calculate(); }
    else if (act === "calculate") calculate();
    else if (act === "compare") compare();
    else if (act === "approve") { ui.confirming = true; render(); }
    else if (act === "approve-no") { ui.confirming = false; render(); }
    else if (act === "approve-yes") approve();
    else if (act === "export") exportCurrent();
    else if (act === "export-saved") exportSaved(b.dataset.id);
    else if (act === "download-original") downloadOriginal(b.dataset.path, b.dataset.name);
  });
  body.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fcFile") { const f = t.files[0]; t.value = ""; if (f) readFile(f); }
    else if (t.id === "fcSheet") { ui.sheet = t.value; readSheet(); render(); }
    else if (t.id === "fcLevel") { ui.settings.level = t.value; ui.compare = null; render(); }
    else if (t.id === "fcLimit") { ui.limit = t.checked; ui.compare = null; render(); }
    else if (t.id === "fcChecked") { ui.checked = t.checked; render(); }

  });
  body.addEventListener("input", (e) => {
    saveWorkSoon();
    const t = e.target;
    if (t.id === "fcJob") { ui.job = t.value; return; }
    if (t.id === "fcNote") { ui.note = t.value; return; }
    if (t.id === "fcAllow") {
      ui.settings.allowance = t.value; ui.compare = null;
      const ex = body.querySelector("#fcAllowEx");
      if (ex) ex.innerHTML = allowanceExample();
      return;
    }
    if (t.id === "fcOrder") { ui.settings.order = t.value; ui.compare = null; return; }
    if (t.dataset.stock) {
      stockRow(Number(t.dataset.stock))[t.dataset.k] = t.value;
      ui.compare = null;
      const W = Number(t.dataset.stock), errs = [];
      const tot = (stockOf(errs)[W] || []).reduce((a, b) => a + b, 0);
      const cell = body.querySelector(`[data-total="${W}"]`);
      if (cell) cell.textContent = tot ? m(tot) : "—";
    }
  });

  if (nav) nav.addEventListener("click", () => { loadSaved(); });
  render();
  restoreWork();
  window.ORYX_FILM_CUT = { render };
})();
