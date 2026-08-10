/* Oryx Product Selector — sizing engine, knowledge bot and UI.
   All answers come from data/kb.js, which is generated from the USP
   spreadsheet by build_kb.py. Nothing is invented: if a fact is not in the
   knowledge base the bot says so and points to the technical team. */

const KB = window.ORYX_KB;
const SYS = KB.systems;
const NOT_KNOWN =
  "That is not in the approved knowledge base yet. Please check with the technical team " +
  "so the answer can be added.";

/* ------------------------------------------------------------------ *
 * Sizing engine
 * ------------------------------------------------------------------ */

// Leaf counts a system can be built with.
function leafOptions(sys) {
  if (sys.any_config) {
    const t = sys.tracks.map(Number);
    const hi = t.length ? Math.max(...t) : 6;
    return Array.from({ length: hi - 1 }, (_, i) => i + 2); // 2..maxTracks
  }
  const set = new Set();
  sys.configs.forEach(c => { if (c.leaves) set.add(c.leaves); });
  return [...set].sort((a, b) => a - b);
}

function configsWith(sys, n) {
  if (sys.any_config) return ["Any configuration"];
  return sys.configs.filter(c => c.leaves === n).map(c => c.label);
}

// Check one system against an opening. Returns a verdict object.
function checkSystem(sys, W, H, opt = {}) {
  const reasons = [];

  if (opt.family && sys.family !== opt.family)
    return { sys, fits: false, filteredOut: true, reasons: ["Different product family."] };
  if (opt.automation === "yes" && !/^yes$/i.test(sys.automation || ""))
    return { sys, fits: false, filteredOut: true, reasons: ["Automation is not available on this system."] };
  if (opt.threshold && sys.thresholds[opt.threshold] !== true)
    return {
      sys, fits: false, filteredOut: true,
      reasons: [opt.threshold + (sys.thresholds[opt.threshold] === false
        ? " is not available on this system."
        : " is not recorded for this system.")]
    };

  // A requested exact panel count must be one the system actually offers.
  // We never quietly substitute a different count.
  if (opt.panels) {
    const offered = leafOptions(sys);
    if (!offered.includes(opt.panels))
      return {
        sys, fits: false, configMiss: true,
        reasons: [`does not offer ${article(opt.panels)} ${opt.panels}-panel configuration` +
          (offered.length ? ` (it supports ${offered.join(", ")})` : "") + "."]
      };
  }

  // Height cannot be split — it is a hard gate.
  if (sys.sash_h_max && H > sys.sash_h_max) {
    reasons.push(`Opening height ${fmt(H)} mm exceeds the maximum sash height of ${fmt(sys.sash_h_max)} mm.`);
    return { sys, fits: false, reasons, heightFail: true };
  }
  if (sys.sash_h_min && H < sys.sash_h_min)
    reasons.push(`Opening height ${fmt(H)} mm is below the minimum sash height of ${fmt(sys.sash_h_min)} mm.`);

  let best = null;
  const tried = [];
  // With an exact count requested, evaluate only that count. Otherwise the
  // fewest panel count that fits wins.
  for (const n of (opt.panels ? [opt.panels] : leafOptions(sys))) {
    if (!opt.panels && opt.maxPanels && n > opt.maxPanels) continue;
    const sw = W / n, sh = H;
    const area = (sw * sh) / 1e6;
    const bad = [];
    if (sys.sash_w_max && sw > sys.sash_w_max)
      bad.push(`panel width ${fmt(sw)} mm > ${fmt(sys.sash_w_max)} mm`);
    if (sys.sash_w_min && sw < sys.sash_w_min)
      bad.push(`panel width ${fmt(sw)} mm < minimum ${fmt(sys.sash_w_min)} mm`);
    if (sys.sash_sqm_max && area > sys.sash_sqm_max + 1e-9)
      bad.push(`panel area ${area.toFixed(2)} m² > ${sys.sash_sqm_max} m²`);
    tried.push({ n, sw, sh, area, bad });
    if (!bad.length) { best = { n, sw, sh, area }; break; }
  }

  if (best && !reasons.length)
    return { sys, fits: true, panels: best, configs: configsWith(sys, best.n), reasons: [] };

  if (!best) {
    if (!tried.length) reasons.push("No panel count is available within the limits you set.");
    else {
      const t = tried[tried.length - 1];
      reasons.push(`${opt.panels ? "At" : "Even at"} ${t.n} panels the ${t.bad.join(" and ")}.`);
    }
  }
  return { sys, fits: false, reasons, tried };
}

// Full run across the range, ranked.
function checkOpening(W, H, opt = {}) {
  const all = SYS.map(s => checkSystem(s, W, H, opt));
  const fixedOnly = s => s.configs.every(c => c.operable === 0);
  const fits = all.filter(r => r.fits).sort((a, b) => {
    const fa = fixedOnly(a.sys) ? 1 : 0, fb = fixedOnly(b.sys) ? 1 : 0;
    if (fa !== fb) return fa - fb;                                       // operable systems first
    if (a.panels.n !== b.panels.n) return a.panels.n - b.panels.n;       // fewer panels = more glass
    return b.panels.sw - a.panels.sw;                                    // then widest panel
  });
  const misses = all.filter(r => !r.fits && !r.filteredOut);
  const excluded = all.filter(r => r.filteredOut);
  return { W, H, fits, misses, excluded };
}

const fmt = n => Math.round(n).toLocaleString("en-GB");
// "a" / "an" for a panel count — 8, 11 and 18 take "an".
const article = n => ([8, 11, 18].includes(Number(n)) ? "an" : "a");

/* ------------------------------------------------------------------ *
 * Knowledge index — every stored fact becomes a searchable card
 * ------------------------------------------------------------------ */

const MARK = v => (v === true ? "✔" : v === false ? "✘" : "—");
const yesNo = obj => Object.entries(obj || {})
  .map(([k, v]) => `${MARK(v)} ${k}${v === null ? " (not recorded)" : ""}`).join("\n");

function buildFacts() {
  const F = [];
  const add = (sysId, sysName, category, question, keywords, answer, drawings) =>
    F.push({ sysId, sysName, category, question, keywords: keywords.toLowerCase(), answer, drawings: drawings || [] });

  for (const s of SYS) {
    const d = k => s.drawings.filter(x => x.kind === k);
    const lim = [
      `Maximum sash width: ${fmt(s.sash_w_max)} mm`,
      `Maximum sash height: ${fmt(s.sash_h_max)} mm`,
      s.sash_w_min ? `Minimum sash width: ${fmt(s.sash_w_min)} mm` : null,
      s.sash_h_min ? `Minimum sash height: ${fmt(s.sash_h_min)} mm` : null,
      s.sash_sqm_max ? `Maximum sash area: ${s.sash_sqm_max} m²` : "Maximum sash area: not stated in the source data",
      `Glass thickness: ${s.glass} mm`
    ].filter(Boolean).join("\n");

    add(s.id, s.name, "Limitations", `What are the sash limitations for ${s.name}?`,
      `${s.name} maximum minimum size limitation sash width height area sqm big large small span opening`,
      lim, d("size"));

    add(s.id, s.name, "Glass", `What glass thickness does ${s.name} take?`,
      `${s.name} glass thickness glazing dgu igu mm`,
      `${s.name} takes ${s.glass} mm glass.`, []);

    const cfg = s.any_config
      ? `Any configuration. Track options: ${s.tracks.join(", ")}.`
      : s.configs.map(c => `• ${c.label}${c.tracks ? ` — ${c.tracks} track${c.tracks === "1" ? "" : "s"}` : ""}`).join("\n");
    add(s.id, s.name, "Configurations", `What configurations are available for ${s.name}?`,
      `${s.name} configuration typology panels leaves layout sliding fixed track tracks arrangement`,
      cfg, d("configuration"));

    if (Object.keys(s.thresholds).length)
      add(s.id, s.name, "Thresholds", `What threshold options does ${s.name} have?`,
        `${s.name} threshold bottom track floor flushed stepped ffl integrated marble wood level`,
        yesNo(s.thresholds), d("threshold"));

    if (Object.keys(s.drainage).length)
      add(s.id, s.name, "Drainage", `What drainage options does ${s.name} have?`,
        `${s.name} drainage drain water weep outlet visible concealed`,
        yesNo(s.drainage), d("drainage"));

    if (Object.keys(s.sightlines).length) {
      const eng = KB.engineering[s.id] || {};
      const visible = Object.entries(eng)
        .filter(([k]) => /visible|sightline|interlock|jamb|frame|track/i.test(k))
        .map(([k, v]) => `${k}: ${v}`).join("\n");
      add(s.id, s.name, "Sightlines", `What are the visible dimensions of ${s.name}?`,
        `${s.name} sightline sightlines visible dimension slim slimmest frame interlock jamb section elevation`,
        (visible ? visible + "\n\n" : "") + yesNo(s.sightlines) +
        (visible ? "" : "\nExact visible dimensions are not yet recorded for this system. See the section drawings below."),
        d("sightline"));
    }

    add(s.id, s.name, "Hardware", `What locking and automation does ${s.name} offer?`,
      `${s.name} lock locking handle latch pop-out hardware automation motorised motorized automatic`,
      `Locking: ${s.locking || "not stated"}\nAutomation: ${s.automation || "not stated"}`, []);
  }

  // Engineering detail confirmed by the technical team
  for (const [sysId, notes] of Object.entries(KB.engineering || {})) {
    const s = SYS.find(x => x.id === sysId);
    for (const [k, v] of Object.entries(notes))
      add(sysId, s ? s.name : sysId, "Engineering", `${s ? s.name : sysId} — ${k}`,
        `${s ? s.name : sysId} ${k} ${v}`, v, []);
  }

  // Glossary
  for (const [term, meaning] of Object.entries(KB.glossary || {}))
    add(null, null, "Glossary", `What does "${term}" mean?`,
      `${term} meaning definition what is explain`, meaning, []);

  return F;
}
const FACTS = buildFacts();

/* Aliases let "series 3", "640", "tilt and turn" or "bi-fold" resolve to a
   system without "series" alone matching every slider. */
const ALIAS_EXTRA = {
  "series-3": ["640"],
  "s22-36": ["s22", "s 22"], "s22-44": ["s22", "s 22"],
  "hy40": ["hy 40"],
  "tilt-turn": ["tilt and turn", "tilt turn", "tilt&turn"],
  "hinged-window": ["side hung", "casement window"],
  "single-door": ["hinged door", "single leaf"],
  "bifold": ["bi-fold", "bi fold", "folding door"],
  "reinforced-bifold": ["reinforced", "reinforced bi-fold", "reinforced bi fold"],
  "t8400": ["t 8400"],
};
const ALIASES = Object.fromEntries(SYS.map(s => {
  const n = s.name.toLowerCase();
  const list = [n, n.replace(/\s*\(.*?\)\s*/g, " ").trim()];
  const ser = n.match(/^series\s*(\d)/);          // "series 3", never bare "series"
  if (ser) list.push("series " + ser[1], "series" + ser[1]);
  return [s.id, [...new Set(list.concat(ALIAS_EXTRA[s.id] || []).filter(Boolean))]];
}));

function systemsNamedIn(text) {
  const q = " " + text.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim() + " ";
  return SYS.filter(s => ALIASES[s.id].some(a =>
    q.includes(" " + a.replace(/[^a-z0-9&]+/g, " ").trim() + " ")));
}

const CATEGORY_HINTS = [
  [/\bdrain|weep|water\b/, "Drainage"],
  [/\bhandle|lock|latch|pop.?out|automat|motoris|motoriz/, "Hardware"],
  [/\bsightline|visible|interlock|slim|jamb|section\b/, "Sightlines"],
  [/\bthreshold|floor|ffl|flush|stepped|track\b/, "Thresholds"],
  [/\bglass|glaz|dgu|igu|thickness\b/, "Glass"],
  [/\bmax|min|limit|size|height|width|area|sqm|big|large\b/, "Limitations"],
  [/\btypolog|configur|panel|leaf|leaves|layout\b/, "Configurations"],
  [/\bmean|definition|what is a\b/, "Glossary"],
];
const STOP = new Set(("the a an is are was for of to in on it can i we you do does what which "
  + "how and or my me please tell about with have has will would be am at").split(" "));

const DEFINITIONAL = /\b(what (is|are|does)|what'?s|define|definition|meaning|mean by|explain)\b/;

function searchFacts(q) {
  const ql = q.toLowerCase();
  const words = ql.replace(/[^a-z0-9. ]/g, " ").split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
  const cat = (CATEGORY_HINTS.find(([re]) => re.test(ql)) || [])[1];
  const named = systemsNamedIn(q).map(s => s.id);
  const definitional = DEFINITIONAL.test(ql) && !named.length;

  // When the question names a system, never answer with a different one.
  const pool = named.length
    ? FACTS.filter(f => !f.sysId || named.includes(f.sysId))
    : FACTS;

  const scored = pool.map(f => {
    let sc = 0;
    if (cat && f.category === cat) sc += 5;
    if (named.length && f.sysId) sc += 6;
    // A definitional question wants the glossary, not a system's option list.
    if (f.category === "Glossary") {
      const term = f.question.match(/"(.+)"/)[1].toLowerCase();
      if (ql.includes(term)) sc += definitional ? 12 : 7;
      else if (definitional) sc += 2;
    } else if (definitional) sc -= 3;
    for (const w of words) {
      if (f.question.toLowerCase().includes(w)) sc += 3;
      if (f.keywords.includes(w)) sc += 2;
    }
    return { f, sc };
  }).filter(x => x.sc >= 6).sort((a, b) => b.sc - a.sc);

  // A definition question is fully answered by the glossary entry alone.
  if (definitional && scored.length && scored[0].f.category === "Glossary")
    return [scored[0].f];
  return scored.slice(0, named.length ? 3 : 2).map(x => x.f);
}

/* ------------------------------------------------------------------ *
 * Cross-system questions: "which systems have automation?"
 * ------------------------------------------------------------------ */

const CROSS = [
  { re: /automat|motoris|motoriz/, title: "Automation",
    test: s => /^yes$/i.test(s.automation || ""),
    label: () => "automation available" },
  { re: /pop.?out/, title: "Pop-out locking",
    test: s => /pop.?out/i.test(s.locking || ""), label: s => s.locking },
  { re: /latch/, title: "Latch locking",
    test: s => /latch/i.test(s.locking || ""), label: s => s.locking },
  { re: /concealed drain/, title: "Concealed drainage",
    test: s => s.drainage["Concealed drainage"] === true, label: () => "concealed drainage" },
  { re: /visible drain/, title: "Visible drainage",
    test: s => s.drainage["Visible drainage"] === true, label: () => "visible drainage" },
  { re: /floor integrated|marble|wood(en)? floor/, title: "Floor Integrated threshold",
    test: s => s.thresholds["Floor Integrated (marble or wood)"] === true,
    label: () => "Floor Integrated threshold" },
  { re: /flush/, title: "Floor Flushed threshold",
    test: s => s.thresholds["Floor Flushed"] === true, label: () => "Floor Flushed threshold" },
  { re: /stepped/, title: "Stepped Floor threshold",
    test: s => s.thresholds["Stepped Floor"] === true, label: () => "Stepped Floor threshold" },
];

function crossSystem(text) {
  const t = text.toLowerCase();
  if (!/\b(which|what|any|list|all)\b/.test(t) || !/\b(system|systems|series|product|products|profile|profiles)\b/.test(t))
    return null;

  // superlatives
  if (/\b(widest|largest|biggest|maximum width|max width)\b/.test(t)) {
    const s = SYS.reduce((a, b) => (b.sash_w_max > a.sash_w_max ? b : a));
    return `<h4>Widest sash</h4><p><b>${esc(s.name)}</b> — up to ${fmt(s.sash_w_max)} mm wide per sash.</p>`;
  }
  if (/\b(tallest|highest|maximum height|max height)\b/.test(t)) {
    const s = SYS.reduce((a, b) => (b.sash_h_max > a.sash_h_max ? b : a));
    return `<h4>Tallest sash</h4><p><b>${esc(s.name)}</b> — up to ${fmt(s.sash_h_max)} mm high per sash.</p>`;
  }

  const rule = CROSS.find(c => c.re.test(t));
  if (!rule) return null;
  const hits = SYS.filter(rule.test);
  if (!hits.length) return `<h4>${esc(rule.title)}</h4><p>No system in the knowledge base offers this.</p>`;
  return `<h4>${esc(rule.title)}</h4><ul>` +
    hits.map(s => `<li><b>${esc(s.name)}</b> <span class="small muted">${esc(rule.label(s))}</span></li>`).join("") +
    `</ul>`;
}

/* ------------------------------------------------------------------ *
 * Question parsing — dimensions
 * ------------------------------------------------------------------ */

function toMm(value, unit) {
  const v = parseFloat(String(value).replace(/,/g, ""));
  if (!isFinite(v)) return null;
  if (unit) {
    if (/^mm$/i.test(unit)) return v;
    if (/^cm$/i.test(unit)) return v * 10;
    if (/^m$/i.test(unit) || /metre|meter/i.test(unit)) return v * 1000;
  }
  return v < 30 ? v * 1000 : v;      // "3.6" or "4" means metres
}

function parseDims(text) {
  const t = text.toLowerCase();
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|metres?|meters?)?\s*(?:x|×|\*|by)\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m|metres?|meters?)?/);
  if (m) {
    const W = toMm(m[1], m[2] || m[4]), H = toMm(m[3], m[4]);
    if (W && H) return { W, H, order: "w×h" };
  }
  const w = t.match(/(?:width|wide)\D{0,8}(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/) ||
            t.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*(?:wide|width)/);
  const h = t.match(/(?:height|high|tall)\D{0,8}(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/) ||
            t.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*(?:high|tall|height)/);
  if (w && h) return { W: toMm(w[1], w[2]), H: toMm(h[1], h[2]), order: "stated" };
  return null;
}

// An explicit panel/leaf count in the question ("4-panel", "4 panels",
// "four leaf"). Returned as an exact requirement — never a maximum.
function parsePanels(text) {
  const t = text.toLowerCase();
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const unit = "(?:panel|pane|leaf|leaves|sash|track|vent)s?";
  let m = t.match(new RegExp("(\\d+)\\s*-?\\s*" + unit + "\\b"));
  if (m) { const n = parseInt(m[1], 10); return n >= 2 && n <= 20 ? n : null; }
  m = t.match(new RegExp("\\b(one|two|three|four|five|six|seven|eight)\\s*-?\\s*" + unit + "\\b"));
  if (m) { const n = words[m[1]]; return n >= 2 ? n : null; }
  return null;
}

function askedFamily(text) {
  const t = text.toLowerCase();
  if (/\bslid|slider|patio\b/.test(t)) return "Sliding";
  if (/\bbifold|bi-fold|folding|fold\b/.test(t)) return "Folding";
  if (/\bcasement|hinged|tilt|window|door\b/.test(t) && !/slid/.test(t)) return null; // too broad to force
  return null;
}

/* ------------------------------------------------------------------ *
 * Answer composition
 * ------------------------------------------------------------------ */

const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const nl = s => esc(s).replace(/\n/g, "<br>");

function answerSizeQuestion(text, dims) {
  const opt = {};
  const fam = askedFamily(text);
  if (fam) opt.family = fam;
  if (/\bautomat|motoris|motoriz/.test(text.toLowerCase())) opt.automation = "yes";
  const panels = parsePanels(text);
  if (panels) opt.panels = panels;

  const asked = systemsNamedIn(text);
  const r = checkOpening(dims.W, dims.H, opt);
  let html = `<h4>Opening ${fmt(dims.W)} × ${fmt(dims.H)} mm (width × height)</h4>`;

  // Make the requested configuration explicit, so it is clear it was respected.
  if (panels)
    html += `<p class="small muted">Requested: ${article(panels)} <b>${panels}-panel</b> configuration${fam ? `, ${fam.toLowerCase()}` : ""} —
      nominal panel width ${fmt(dims.W)} ÷ ${panels} = <b>${fmt(dims.W / panels)} mm</b>.</p>`;

  if (asked.length) {
    const v = checkSystem(asked[0], dims.W, dims.H, opt);
    html += v.fits
      ? `<p><span class="tag ok">SUITABLE</span> <b>${esc(v.sys.name)}</b> works at
         <b>${v.panels.n} panels</b> — ${fmt(v.panels.sw)} × ${fmt(v.panels.sh)} mm each
         (${v.panels.area.toFixed(2)} m² per panel).</p>${configList(v.configs, v.panels.n)}`
      : `<p><span class="tag no">NOT SUITABLE</span> <b>${esc(v.sys.name)}</b> — ${esc(v.reasons.join(" "))}</p>`;
    if (v.fits) {
      html += optionLine(v.sys);
      return html;
    }
    if (r.fits.length)
      html += `<p>${panels ? `Other systems that support ${article(panels)} ${panels}-panel layout here:` : "Better suited to this opening:"}</p>`;
  }

  if (!r.fits.length) {
    html += `<p><span class="tag no">NO MATCH</span> ${panels
      ? `No system supports ${article(panels)} ${panels}-panel configuration for this opening`
      : "Nothing in the range covers this opening as a single unit"}`
      + (fam ? ` within the ${fam} family` : "") + `.</p>`;

    if (panels) {
      // Explain why, system by system, rather than quietly changing the count.
      const why = r.misses.filter(m => !asked.some(a => a.id === m.sys.id));
      if (why.length)
        html += `<p class="small muted">Why each was ruled out:</p><ul>` +
          why.map(m => `<li><b>${esc(m.sys.name)}</b> — <span class="small muted">${esc(m.reasons.join(" "))}</span></li>`).join("") +
          `</ul>`;
      if (r.excluded.length)
        html += `<p class="small muted">${r.excluded.length} system(s) excluded by the filters you set.</p>`;
      html += `<p class="small muted">Ask without a fixed panel count to see the configurations that do fit,
        or raise it with the technical team.</p>`;
      return html;
    }

    const hardest = r.misses.filter(m => m.heightFail);
    if (hardest.length) {
      const tallest = SYS.reduce((a, b) => (b.sash_h_max > a.sash_h_max ? b : a));
      html += `<p>Height is the limiting factor. The tallest sash in the range is
        <b>${esc(tallest.name)}</b> at ${fmt(tallest.sash_h_max)} mm.
        A transom above the door, or splitting the elevation, would be the way forward —
        please raise it with the technical team.</p>`;
    }
    return html;
  }

  const top = r.fits.slice(0, asked.length ? 3 : 4);
  html += `<ul>` + top.map(v =>
    `<li><b>${esc(v.sys.name)}</b> <span class="tag n">${v.panels.n} panels</span>
      ${fmt(v.panels.sw)} × ${fmt(v.panels.sh)} mm per panel${v.sys.sash_sqm_max ? `, ${v.panels.area.toFixed(2)} m²` : ""}
      <br><span class="small muted">${configSummary(v.configs)}</span></li>`
  ).join("") + `</ul>`;
  html += `<p class="small muted">${panels
    ? `All shown as ${panels}-panel layouts, ${fmt(dims.W / panels)} × ${fmt(dims.H)} mm per panel.`
    : "Ranked by fewest panels, which gives the largest glass and the cleanest elevation."}
    Panel width is the nominal opening ÷ panels; frame and interlock allowances are confirmed by the technical team.</p>`;
  return html;
}

/* A system usually offers several alternative layouts at a given panel count
   (all-sliding, sliding with fixed ends, and so on). Each label already lists
   exactly that many leaves — the point below is to keep the alternatives
   visually separate so two 4-panel options never read as one 8-panel run. */

// Full, unambiguous list — one layout per line.
function configList(configs, n) {
  if (!configs || !configs.length) return "";
  if (configs.length === 1)
    return `<p class="small muted">Layout: ${esc(configs[0])}.</p>`;
  return `<p class="small muted">${n}-panel layout options (any one of these):</p>` +
    `<ul class="small muted" style="margin:4px 0 0">` +
    configs.map(c => `<li>${esc(c)}</li>`).join("") + `</ul>`;
}

// Compact one-line summary for the ranked list: one layout plus a count.
function configSummary(configs) {
  if (!configs || !configs.length) return "";
  const more = configs.length - 1;
  return esc(configs[0]) +
    (more > 0 ? ` (or ${more} other ${more === 1 ? "layout" : "layouts"})` : "");
}

function optionLine(s) {
  const on = o => Object.entries(o).filter(([, v]) => v === true).map(([k]) => k);
  const bits = [];
  const th = on(s.thresholds); if (th.length) bits.push(`Thresholds: ${th.join(", ")}`);
  const dr = on(s.drainage); if (dr.length) bits.push(`Drainage: ${dr.join(", ")}`);
  bits.push(`Glass: ${s.glass} mm`);
  bits.push(`Locking: ${s.locking}`);
  if (/^yes$/i.test(s.automation || "")) bits.push("Automation available");
  return `<p class="small muted">${esc(bits.join(" · "))}</p>`;
}

function answerFactQuestion(text) {
  const hits = searchFacts(text);
  if (!hits.length) return `<p>${esc(NOT_KNOWN)}</p>`;
  return hits.map(f => {
    let h = `<h4>${esc(f.sysName ? f.sysName + " — " + f.category : f.category)}</h4><p>${nl(f.answer)}</p>`;
    if (f.drawings.length) h += figures(f.drawings.slice(0, 6));
    return h;
  }).join("<hr style='border:none;border-top:1px solid var(--line);margin:12px 0'>");
}

function figures(list) {
  return `<div class="gallery">` + list.map(d => {
    // A drawing with no signed URL has not been uploaded to the bucket yet.
    const body = d.url
      ? `<img loading="lazy" src="${esc(d.url)}" alt="${esc(d.label)}"
           onclick="zoom(this.src,'${esc(d.label)}')">`
      : `<div class="fig-missing">Drawing not uploaded</div>`;
    return `<div class="fig">${body}<div class="cap">${esc(d.label)}</div></div>`;
  }).join("") + `</div>`;
}

function respond(text) {
  const dims = parseDims(text);
  if (dims) return answerSizeQuestion(text, dims);
  const cross = crossSystem(text);
  if (cross) return cross;
  if (!systemsNamedIn(text).length &&
      /\b(list|show me|what)\b[^?]*\b(all systems|all products|systems do you|products do you|systems are there|systems available|full range|whole range)\b/i.test(text))
    return `<h4>Systems in the knowledge base</h4><ul>` +
      SYS.map(s => `<li><b>${esc(s.name)}</b> — ${s.family}, up to ${fmt(s.sash_w_max)} × ${fmt(s.sash_h_max)} mm per sash</li>`).join("") +
      `</ul>`;
  return answerFactQuestion(text);
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

const $ = s => document.querySelector(s);
const chat = $("#chat");

function say(html, who) {
  const d = document.createElement("div");
  d.className = "msg " + who;
  d.innerHTML = who === "u" ? esc(html) : html;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Chat history
 *
 * Saved in THIS browser only (localStorage) — never sent anywhere.
 * That makes it private by construction: no other person's browser
 * ever holds these chats, so there is nothing to leak and no write
 * endpoint to abuse. Each conversation is removed automatically two
 * days after its last message, which also frees the space it used.
 * ------------------------------------------------------------------ */

const HIST_KEY = "oryx_chats_v1";
const EXPIRY_MS = 2 * 24 * 60 * 60 * 1000;   // 2 days after the last message
const MAX_CONVERSATIONS = 40;                 // keep browser storage bounded

// Wrap localStorage so private mode or a full quota degrades to
// "history off, bot still works" rather than throwing.
const store = {
  ok: (() => {
    try { const k = "__oryx_t"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
    catch { return false; }
  })(),
  read() {
    if (!this.ok) return [];
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; }
  },
  write(list) {
    if (!this.ok) return;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list)); } catch { /* quota — skip */ }
  },
};

const clock = () => Date.now();

// Drop conversations whose last message is older than the expiry window.
// Keep one id alive (the open chat) so it can't vanish mid-view.
function sweep(list, keepId) {
  const cut = clock() - EXPIRY_MS;
  const kept = (list || []).filter(c => c.id === keepId || (c.updatedAt || 0) > cut);
  if (kept.length !== (list || []).length) store.write(kept);
  return kept;
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
         "c" + Math.random().toString(36).slice(2) + clock().toString(36);
}

let conversations = sweep(store.read());
let currentId = null;

const historyEl = $("#history");
const historyList = $("#historyList");

// A short, honest title from the first question — no invention, just a
// summary of what was actually asked (size, system and/or topic).
function titleFor(text) {
  const dims = parseDims(text);
  const named = systemsNamedIn(text).map(s => s.name);
  const cat = (CATEGORY_HINTS.find(([re]) => re.test(text.toLowerCase())) || [])[1];
  if (dims && named.length) return `${named[0]} · ${fmt(dims.W)}×${fmt(dims.H)}`;
  if (dims)                 return `${fmt(dims.W)} × ${fmt(dims.H)} opening`;
  if (named.length)         return cat ? `${named[0]} — ${cat}` : named[0];
  let t = text.replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+/u, "");
  if (t.length > 46) t = t.slice(0, 44).replace(/\s+\S*$/, "") + "…";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "New chat";
}

function expiryLabel(c) {
  const left = c.updatedAt + EXPIRY_MS - clock();
  if (left <= 0) return "Expiring…";
  const h = left / 36e5;
  if (h >= 24) { const d = Math.round(h / 24); return `Expires in ${d} day${d === 1 ? "" : "s"}`; }
  if (h >= 1)  return `Expires in ${Math.round(h)}h`;
  return `Expires in ${Math.max(1, Math.round(left / 60000))}m`;
}

function renderHistory() {
  if (!store.ok) { historyEl.hidden = true; return; }
  const list = conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) {
    historyList.innerHTML = `<p class="history-empty">No saved chats yet. Ask a question to start one.</p>`;
    return;
  }
  historyList.innerHTML = list.map(c => `
    <div class="history-item${c.id === currentId ? " on" : ""}" data-id="${c.id}" role="button" tabindex="0">
      <div class="hi-main">
        <div class="hi-title">${esc(c.title)}</div>
        <div class="hi-exp">${esc(expiryLabel(c))}</div>
      </div>
      <button class="hi-del" data-del="${c.id}" type="button" title="Delete this chat" aria-label="Delete this chat">×</button>
    </div>`).join("");
}

function currentConv() { return conversations.find(c => c.id === currentId) || null; }

const INTRO = `<h4>Technical assistant</h4><p>Give me an opening size and I will tell you which systems fit,
  how many panels are needed and what to use instead if a system does not work.
  I also answer specification questions — thresholds, drainage, sightlines, glass, hardware.</p>
  <p class="small muted">Every answer comes from the USP data and the approved engineering notes.
  If something is not recorded, I will say so rather than guess.</p>`;

function startNewChat(focus) {
  currentId = null;
  chat.innerHTML = "";
  say(INTRO, "b");
  renderHistory();
  if (focus) $("#askInput").focus();
}

function openChat(id) {
  const c = conversations.find(x => x.id === id);
  if (!c) return;
  currentId = id;
  chat.innerHTML = "";
  if (!c.messages.length) say(INTRO, "b");
  else c.messages.forEach(m => say(m.who === "u" ? m.text : m.html, m.who));
  renderHistory();
}

function deleteChat(id) {
  conversations = conversations.filter(c => c.id !== id);
  store.write(conversations);
  if (currentId === id) startNewChat();
  else renderHistory();
}

// Persist a message, creating the conversation on the first user turn.
function recordMessage(who, payload) {
  let c = currentConv();
  if (!c) {
    c = { id: uid(), title: who === "u" ? titleFor(payload) : "New chat",
          createdAt: clock(), updatedAt: clock(), messages: [] };
    conversations.push(c);
    currentId = c.id;
    if (conversations.length > MAX_CONVERSATIONS) {
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      conversations = conversations.slice(0, MAX_CONVERSATIONS);
    }
  }
  c.messages.push(who === "u" ? { who, text: payload } : { who, html: payload });
  c.updatedAt = clock();
  store.write(conversations);
  renderHistory();
}

historyList.addEventListener("click", e => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
  const item = e.target.closest(".history-item");
  if (item) openChat(item.dataset.id);
});
historyList.addEventListener("keydown", e => {
  const item = e.target.closest && e.target.closest(".history-item");
  if (item && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openChat(item.dataset.id); }
});
$("#newChat").addEventListener("click", () => startNewChat(true));

// Refresh the expiry labels and clear anything that has just expired,
// while the page stays open.
setInterval(() => {
  conversations = sweep(conversations, currentId);
  renderHistory();
}, 60000);

$("#askForm").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#askInput").value.trim();
  if (!q) return;
  say(q, "u");
  recordMessage("u", q);
  $("#askInput").value = "";
  setTimeout(() => {
    const html = respond(q);
    say(html, "b");
    recordMessage("b", html);
  }, 90);
});

const SAMPLES = [
  "I have a 4200 x 2700 opening — what do you recommend?",
  "Will Series 1 work for 3000 x 2600?",
  "What are the sash limitations for Series 3?",
  "What threshold options does HY40 have?",
  "Why can't I use a pop-out handle on Series 1?",
  "What is the interlock sightline on Series 1?",
  "Which systems have automation?",
  "What is concealed drainage?"
];
$("#chips").innerHTML = SAMPLES.map(s => `<span class="chip">${esc(s)}</span>`).join("");
$("#chips").addEventListener("click", e => {
  if (!e.target.classList.contains("chip")) return;
  $("#askInput").value = e.target.textContent;
  $("#askForm").requestSubmit();
});

// First paint: a fresh, unsaved chat with the sidebar alongside it.
startNewChat();

// ---- tabs ----
document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + b.dataset.v));
}));

// ---- checker ----
const ALL_THRESHOLDS = [...new Set(SYS.flatMap(s => Object.keys(s.thresholds)))];
$("#thr").innerHTML = `<option value="">Any</option>` +
  ALL_THRESHOLDS.map(t => `<option>${esc(t)}</option>`).join("");

$("#chkForm").addEventListener("submit", e => {
  e.preventDefault();
  const W = +$("#ow").value, H = +$("#oh").value;
  if (!W || !H) { $("#chkOut").innerHTML = `<div class="card">Enter both the width and the height.</div>`; return; }
  const opt = {
    family: $("#fam").value || null,
    threshold: $("#thr").value || null,
    automation: $("#autom").value || null,
    maxPanels: +$("#maxp").value || null
  };
  const r = checkOpening(W, H, opt);
  let out = `<div class="card"><h2>Opening ${fmt(W)} × ${fmt(H)} mm — ${r.fits.length} suitable system${r.fits.length === 1 ? "" : "s"}</h2>`;
  if (!r.fits.length) out += `<p class="muted">No system in the range covers this opening under the constraints selected.</p>`;
  out += r.fits.map(v => `
    <div class="result fit">
      <h4>${esc(v.sys.name)} <span class="tag ok">SUITABLE</span> <span class="tag n">${v.panels.n} panels</span></h4>
      <div class="small">Panel size ${fmt(v.panels.sw)} × ${fmt(v.panels.sh)} mm · ${v.panels.area.toFixed(2)} m² per panel</div>
      <div class="small muted" style="margin-top:5px">${esc(v.configs.join(" · "))}</div>
      ${optionLine(v.sys)}
    </div>`).join("");
  if (r.misses.length) {
    out += `<h3>Not suitable</h3>` + r.misses.map(v => `
      <div class="result no">
        <h4>${esc(v.sys.name)} <span class="tag no">NO</span></h4>
        <div class="small muted">${esc(v.reasons.join(" "))}</div>
      </div>`).join("");
  }
  if (r.excluded.length)
    out += `<p class="small muted">${r.excluded.length} system(s) excluded by the filters you set.</p>`;
  out += `</div>`;
  $("#chkOut").innerHTML = out;
});

// ---- systems browser ----
$("#sysnav").innerHTML = SYS.map((s, i) =>
  `<button class="ghost" data-i="${i}">${esc(s.name)}</button>`).join("");
$("#sysnav").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  showSystem(+b.dataset.i);
});

function showSystem(i) {
  const s = SYS[i];
  $("#sysnav").querySelectorAll("button").forEach((b, idx) => b.classList.toggle("on", idx === i));
  const flags = o => Object.entries(o).map(([k, v]) =>
    `<span class="${v === true ? "yes" : "nope"}">${MARK(v)} ${esc(k)}${v === null ? " <i>(not recorded)</i>" : ""}</span>`)
    .join("<br>") || "<span class='nope'>—</span>";
  let h = `<h3 style="margin-top:0">${esc(s.name)} <span class="tag fam">${s.family}</span></h3>
    <dl class="kv">
      <dt>Maximum sash</dt><dd>${fmt(s.sash_w_max)} × ${fmt(s.sash_h_max)} mm</dd>
      ${s.sash_w_min ? `<dt>Minimum sash</dt><dd>${fmt(s.sash_w_min)} × ${fmt(s.sash_h_min)} mm</dd>` : ""}
      <dt>Maximum sash area</dt><dd>${s.sash_sqm_max ? s.sash_sqm_max + " m²" : "<span class='muted'>Not stated in the source data</span>"}</dd>
      <dt>Glass thickness</dt><dd>${esc(s.glass)} mm</dd>
      <dt>Tracks</dt><dd>${s.tracks.length ? esc(s.tracks.join(", ")) : "<span class='muted'>—</span>"}</dd>
      <dt>Locking</dt><dd>${esc(s.locking || "—")}</dd>
      <dt>Automation</dt><dd>${esc(s.automation || "—")}</dd>
      <dt>Thresholds</dt><dd>${flags(s.thresholds)}</dd>
      <dt>Drainage</dt><dd>${flags(s.drainage)}</dd>
      <dt>Configurations</dt><dd>${s.configs.map(c => esc(c.label) + (c.tracks ? ` <span class="muted">(${esc(c.tracks)} tracks)</span>` : "")).join("<br>")}</dd>
    </dl>`;

  const eng = KB.engineering[s.id];
  if (eng) {
    h += `<h3>Engineering notes — confirmed by the technical team</h3><dl class="kv">` +
      Object.entries(eng).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + `</dl>`;
  }

  for (const kind of ["configuration", "threshold", "drainage", "sightline", "size"]) {
    const g = s.drawings.filter(d => d.kind === kind);
    if (!g.length) continue;
    h += `<h3>${kind[0].toUpperCase() + kind.slice(1)} drawings</h3>` + figures(g);
  }
  $("#sysBody").innerHTML = h;
}
showSystem(0);

// ---- header counts ----
$("#sysCount").textContent = SYS.length;
$("#drwCount").textContent = SYS.reduce((n, s) => n + s.drawings.length, 0);

// ---- comparison ----
$("#srcName").textContent = KB.source;
const MCOLS = [
  ["System", s => s.name], ["Family", s => s.family],
  ["Max sash W", s => fmt(s.sash_w_max) + " mm"], ["Max sash H", s => fmt(s.sash_h_max) + " mm"],
  ["Max area", s => s.sash_sqm_max ? s.sash_sqm_max + " m²" : "—"],
  ["Glass", s => s.glass + " mm"], ["Tracks", s => s.tracks.join(", ") || "—"],
  ["Locking", s => s.locking || "—"], ["Automation", s => s.automation || "—"],
  ["Thresholds", s => Object.entries(s.thresholds).filter(([, v]) => v === true).map(([k]) => k).join(", ") || "Not recorded"],
  ["Drainage", s => Object.entries(s.drainage).filter(([, v]) => v === true).map(([k]) => k).join(", ") || "Not recorded"],
];
$("#matrix").innerHTML =
  `<thead><tr>${MCOLS.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody>` +
  SYS.map(s => `<tr>${MCOLS.map(c => `<td>${esc(c[1](s))}</td>`).join("")}</tr>`).join("") +
  `</tbody>`;

// ---- lightbox ----
function zoom(src, cap) { $("#lbImg").src = src; $("#lbCap").textContent = cap; $("#lightbox").showModal(); }
window.zoom = zoom;
