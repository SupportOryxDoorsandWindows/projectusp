/* Delivery Notes (tab "Delivery Notes"; user's request 2026-10-27).
 *
 * From the FP Pro job list of a confirmed Check-out, two notes are prepared:
 *   Powder coating  one line per part type, counted from FP Pro's own bar
 *                   codes (HOUSING, RECEIVER, DRAWBAR, TRACK, RECESS CHANNEL,
 *                   TRACK FILLER = 630148, BOX SECTION) + COMPONENTS = the
 *                   pieces of the accessories on Freedom's coating list.
 *                   The RAL code is typed (job lists carry none).
 *   Finished goods  one line per screen of the "Items list": location +
 *                   product + size, qty; Box Section sizes in Comments.
 * Staff fill in driver / date (/ RAL), Confirm gives the DN number (own
 * series DN-SF-0001), Print. Only Admins + delivery_note_correctors (Renato)
 * correct a confirmed note, with a reason (history kept).
 *
 * Never touches the stock: Check-out (fp-checkout.js) calls
 * ORYX_DN.afterCheckout() only AFTER its Check-out was saved, and the server
 * (supabase/sql/delivery_notes.sql) only accepts a job list that is on a
 * saved Check-out, one note of each kind per job list.
 * Admin TEST mode (2026-10-28, supabase/sql/delivery_notes_test_mode.sql):
 * "Test with a job list" prepares notes from ANY job list without a Check-out
 * (no stock), marked TEST, numbered TEST-0001, Admins only, deletable; they
 * appear only under the "Test notes" filter.
 * Pure parts (window.ORYX_DN_CORE) are tested in tests/delivery-notes.test.js.
 */
(function (root) {
  // Coating list (FREEDOM COATING LIST 1.xlsx): accessories counted in pieces.
  const COAT_PCS = new Set(("230001 230003 230005 230019 230021 330001 330005 330093 330094 330095 330096 330097 330098 330099 " +
    "330100 630003 630007 630012 630016 630020 630024 630058 630059 630060 630061 630062 630063 630064 630065 630066 630067 " +
    "630068 630069 630070 630071 630072 630073 630074 630075 630132 630133 630136 630137 630160 630161").split(" "));

  const GROUP_ORDER = ["HOUSING", "RECEIVER", "DRAWBAR", "TRACK", "RECESS CHANNEL", "TRACK FILLER", "BOX SECTION", "L ANGLE", "FLAT TRIM", "COMPONENTS"];

  // One page's text pieces -> lines, top to bottom; a wide gap between two
  // pieces becomes two spaces (column break), a small one a single space.
  function pageLines(items) {
    const sorted = items.filter((it) => it.str && it.str.trim()).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 2.5) last.parts.push(it);
      else lines.push({ y: it.y, parts: [it] });
    }
    return lines.map((l) => {
      l.parts.sort((a, b) => a.x - b.x);
      let s = "", end = null;
      for (const p of l.parts) {
        if (end !== null) s += p.x - end > 6 ? "  " : " ";
        s += p.str.trim();
        end = p.x + (p.w || 0);
      }
      return s;
    });
  }

  // Bar group from FP Pro's own short bar code (and its description).
  function barGroup(code, desc) {
    const c = String(code || "").toUpperCase(), d = String(desc || "").toUpperCase();
    if (/MAGNET|ROLLER|MOHAIR/.test(c) || /MAGNET HOLDER|ROLLER TUBE|MOHAIR/.test(d)) return null;
    if (/RECIEVER|RECEIVER/.test(c)) return "RECEIVER";
    if (/TRACK_FILLER/.test(c)) return "TRACK FILLER";
    if (/DRAWBAR/.test(c)) return "DRAWBAR";
    if (/RECESS/.test(c)) return "RECESS CHANNEL";
    if (/TRACK/.test(c)) return "TRACK";
    if (/^\d+X\d+$/.test(c) || /BOX SECTION/.test(d)) return "BOX SECTION";
    if (/L[\s-]?ANGLE/.test(c + " " + d)) return "L ANGLE";
    if (/FLAT[\s_-]?TRIM/.test(c + " " + d)) return "FLAT TRIM";
    if (/^(SMB_|ZLX_)?\d+(-IS|-OS)?$/.test(c) || /HOUSING/.test(d)) return "HOUSING";
    return "?";
  }

  function parseBarsSection(text) {
    const out = [];
    const re = /Code:\s*(\S*)\s+Bars:\s*(\d+)\s*x\s*(\d+)[\s\S]*?Description:\s*([^\n]*?)(?:\s{2,}|\n|$)/g;
    let m;
    while ((m = re.exec(text))) out.push({ fpCode: m[1], bars: +m[2], lenMm: +m[3], description: m[4].trim() });
    return out;
  }

  function parseFittingLines(lines) {
    const out = [];
    for (const l of lines) {
      const m = l.match(/^ORYX\s+(\S.*?)\s{2,}(\d+(?:\.\d+)?)(\s*m)?\s{2,}(.+)$/);
      if (!m) continue;
      const code = (m[1].match(/^(\d+R?)\s*-/) || [])[1] || "";
      out.push({ code, qty: +m[2], unit: m[3] ? "m" : "pcs", description: m[4].trim() });
    }
    return out;
  }

  // Items list: each "Item:" label starts a block; its column runs to the
  // next label on the same row, its rows down to the next row of labels.
  function parseItemsPage(items) {
    const anchors = items.filter((it) => /^Item:/.test(it.str.trim()));
    const rowsY = [...new Set(anchors.map((a) => Math.round(a.y)))].sort((a, b) => b - a);
    const blocks = [];
    for (const a of anchors) {
      const ri = rowsY.indexOf(Math.round(a.y));
      const yBottom = ri + 1 < rowsY.length ? rowsY[ri + 1] + 2 : -Infinity;
      const right = anchors.filter((b) => Math.abs(b.y - a.y) < 3 && b.x > a.x + 5).map((b) => b.x).sort((p, q) => p - q)[0];
      const xRight = right === undefined ? Infinity : right - 2;
      const inBlock = items.filter((it) => it.x >= a.x - 2 && it.x < xRight && it.y <= a.y + 3 && it.y > yBottom);
      blocks.push(parseItemBlock(pageLines(inBlock)));
    }
    return blocks.filter((b) => b.n);
  }

  function parseItemBlock(lines) {
    const t = lines.join("\n");
    const n = (t.match(/Item:\s*(\d+)/) || [])[1];
    const name = (t.match(/Item:\s*\d+\s+([\s\S]*?)\n\s*View:/) || [])[1] || "";
    const qd = t.match(/Qty:\s*(\d+),\s*Dimension \(WxH\):\s*(\d+)\s*x\s*(\d+)/);
    const loc = ((t.match(/Location:[ \t]*([\s\S]*?)(?:\n\s*Code\b|$)/) || [])[1] || "")
      .replace(/\s*(Totals\b|Printout date\/time|Pagina \d)[\s\S]*$/, "").replace(/^\s*Code\s*$/, "");
    const type = (t.match(/Type:\s*(\S+)/) || [])[1] || "";
    const tidy = (s) => s.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
    return {
      n: n ? +n : null, type, product: tidy(name).replace(/\s*-\s*$/, "").replace(/ - ,/, " -"), location: tidy(loc),
      qty: qd ? +qd[1] : null, size: qd ? `${qd[2]} × ${qd[3]}` : "",
    };
  }

  // pages: [{items:[{str,x,y,w}]}] -> everything the two notes need.
  function readJobList(pages) {
    const pageTexts = pages.map((p) => pageLines(p.items));
    const all = pageTexts.map((l) => l.join("\n")).join("\n\n");
    const job = (all.match(/Job\/Group:\s*(\S+)/) || [])[1] || "";
    const client = ((all.match(/Description:\s*([^\n]*?)(?:\s{2,}|\n|$)/) || [])[1] || "").trim();
    const finished = [], bars = [], fittings = [];
    const colours = new Set();
    pages.forEach((p, i) => {
      const text = pageTexts[i].join("\n");
      if (/Items list-/.test(text)) finished.push(...parseItemsPage(p.items));
      if (/Bars Optimization Report/.test(text)) bars.push(...parseBarsSection(text));
      if (/Fittings List/.test(text)) fittings.push(...parseFittingLines(pageTexts[i]));
      for (const m of text.matchAll(/(?:Exter\.Color|Inter\.Color|Treatement):[ \t]*([^\n]*?)(?:\s{2,}|\n|$)/g)) {
        const v = m[1].replace(/[,\s]+/g, " ").trim();
        if (v && !/^(Exter|Inter|Fit)\b/.test(v)) colours.add(v);
      }
    });
    finished.sort((a, b) => a.n - b.n);
    return { job, client, finished, bars, fittings, colours: [...colours] };
  }

  function buildNotes(job) {
    const groups = new Map(), unknown = [], left = [];
    const add = (g, q, src) => {
      const cur = groups.get(g) || { qty: 0, src: [] };
      cur.qty += q; cur.src.push(src); groups.set(g, cur);
    };
    for (const b of job.bars) {
      const g = barGroup(b.fpCode, b.description);
      const src = `${b.description} — ${b.bars} × ${b.lenMm} mm`;
      if (g === null) left.push(src);
      else if (g === "?") unknown.push(src);
      else add(g, b.bars, src);
    }
    for (const f of job.fittings) {
      if (f.unit === "pcs" && COAT_PCS.has(f.code)) add("COMPONENTS", f.qty, `${f.description} — ${f.qty} pcs`);
    }
    const pcLines = GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({ description: g, qty: groups.get(g).qty, source: groups.get(g).src }));
    const boxSizes = [...new Set(job.bars.filter((b) => barGroup(b.fpCode, b.description) === "BOX SECTION")
      .map((b) => (b.fpCode && /^\d+X\d+$/i.test(b.fpCode) ? b.fpCode.toUpperCase() : b.description.replace(/box section/i, "").trim().toUpperCase())))];
    const fgComment = boxSizes.length ? `${boxSizes.join(", ")} Box section` : "";
    const fgLines = job.finished.map((f) => ({
      description: [f.location, [f.product, f.size].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
      qty: f.qty, comments: fgComment,
    }));
    const flags = [];
    if (!job.colours.length) flags.push("No RAL code on the job list — type it in.");
    else if (job.colours.length > 1) flags.push(`More than one colour on the job list (${job.colours.join(" / ")}) — check which one.`);
    if (unknown.length) flags.push(`${unknown.length} bar line(s) not recognised — check if they go for coating.`);
    if (!job.finished.length) flags.push("No finished items found in the Items list.");
    return { pcLines, fgLines, unknown, left, flags, colour: job.colours.length === 1 ? job.colours[0] : "" };
  }

  const api = { pageLines, barGroup, parseBarsSection, parseFittingLines, parseItemBlock, readJobList, buildNotes, COAT_PCS, GROUP_ORDER };
  root.ORYX_DN_CORE = api;
})(typeof window !== "undefined" ? window : globalThis);

/* ---------------- note helpers (same file, same ORYX_DN_CORE) ---------------- */
(function (root) {
  const C = root.ORYX_DN_CORE;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // "2026-10-27" -> "27-Oct-2026" (the format on the current delivery notes).
  function fmtDate(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}-${MONTHS[+m[2] - 1]}-${m[1]}` : "";
  }

  // The same checks as confirm_delivery_note() on the server, in words.
  function problems(n) {
    const out = [];
    if (n.kind === "powder_coating" && !String(n.ral_code || "").trim()) out.push("Type the RAL code.");
    if (!String(n.delivery_address || "").trim()) out.push("Fill in the delivery address.");
    if (!String(n.delivered_by || "").trim()) out.push("Fill in who delivers it (Delivered by).");
    if (!n.delivery_date) out.push("Fill in the delivery date.");
    if (!(n.lines || []).length) out.push("Add at least one line.");
    (n.lines || []).forEach((l, i) => {
      if (!String(l.description || "").trim()) out.push(`Line ${i + 1}: add a description.`);
      if (!(Number(l.qty) > 0)) out.push(`Line ${i + 1}: the quantity must be more than 0.`);
    });
    return out;
  }

  // The editable fields sent to save / confirm / correct.
  function fieldsOf(n) {
    const f = {};
    ["delivery_address", "contact_no", "secondary_contact_no", "delivered_by", "customer_ref", "ral_code"].forEach((k) => { f[k] = n[k] || ""; });
    f.delivery_date = n.delivery_date || "";
    f.lines = (n.lines || []).map((l) => ({ description: String(l.description || ""), qty: l.qty === "" ? null : Number(l.qty), comments: String(l.comments || "") }));
    return f;
  }

  const SHEET_CSS = `.dn-sheet{background:#fff;color:#111;width:760px;min-height:980px;margin:0 auto;padding:44px 48px;font-size:12px;
      display:flex;flex-direction:column;gap:18px;box-shadow:0 1px 4px rgba(0,0,0,.15);font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}
    .dn-sheet .sh{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #022A3A;padding-bottom:10px}
    .dn-sheet .co{font-weight:700;color:#022A3A;font-size:13px}
    .dn-sheet h3{font-size:22px;color:#022A3A;text-align:right;margin:0}
    .dn-sheet .kind{font-size:11px;font-weight:700;color:#4F5F66;text-align:right;letter-spacing:.06em}
    .dn-sheet .hdr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 28px}
    .dn-sheet .hdr div{display:flex;gap:8px} .dn-sheet .hdr span{width:140px;flex:none;color:#4F5F66}
    .dn-sheet table{width:100%;border-collapse:collapse;font-size:12px}
    .dn-sheet th{text-align:left;border-bottom:1.5px solid #111;padding:6px;color:#111;font-weight:700;background:none}
    .dn-sheet td{border-bottom:1px solid #D5DADD;padding:7px 6px;white-space:pre-line;vertical-align:top}
    .dn-sheet .legal{text-align:center;font-weight:700;font-size:10.5px;line-height:1.6}
    .dn-sheet .sign{display:flex;flex-direction:column;gap:12px}
    .dn-sheet .stamp{align-self:flex-start;border:1.5px solid #8A5A0F;color:#8A5A0F;padding:3px 10px;font-weight:700;letter-spacing:.08em;font-size:11px}
    .dn-sheet .test{border:2px dashed #A23A33;color:#A23A33;text-align:center;padding:8px;font-weight:700;letter-spacing:.08em;font-size:14px}`;

  // The printed note, in the layout of the current delivery notes (DN-5470 etc.).
  function sheetHtml(n) {
    const pc = n.kind === "powder_coating";
    const comments = (l) => (pc ? n.ral_code || "" : l.comments || "");
    return `<div class="dn-sheet">
      ${n.is_test ? `<div class="test">TEST – NOT A REAL DELIVERY NOTE</div>` : ""}
      <div class="sh"><div class="co">ORYX DOOR SYSTEMS LLC</div><div><h3>DELIVERY NOTE</h3><div class="kind">${pc ? "POWDER COATING" : "FINISHED GOODS"}</div></div></div>
      <div class="hdr">
        <div><span>Delivery Address:</span><b>${esc(n.delivery_address || "")}</b></div><div><span>Company Name:</span><b>Oryx Doors and Windows</b></div>
        <div><span>Contact No:</span><b>${esc(n.contact_no || "")}</b></div><div><span>Customer Ref:</span><b>${esc(n.customer_ref || n.client || "")}</b></div>
        <div><span>Secondary Contact No:</span><b>${esc(n.secondary_contact_no || "")}</b></div><div><span>Order No:</span><b>${esc(n.job_number || "")}</b></div>
        <div><span>Delivered by:</span><b>${esc(n.delivered_by || "")}</b></div><div><span>Delivery Date:</span><b>${esc(fmtDate(n.delivery_date))}</b></div>
        <div><span>DN No:</span><b>${esc(n.dn_number || "(given when confirmed)")}</b></div>
      </div>
      ${n.dn_number ? "" : `<div class="stamp">DRAFT · NOT CONFIRMED</div>`}
      <table><thead><tr><th style="width:40px">S.No</th><th>Item Description</th><th style="width:70px;text-align:right">Quantity</th><th style="width:220px">Comments</th></tr></thead>
      <tbody>${(n.lines || []).map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td style="text-align:right">${esc(l.qty)}</td><td>${esc(comments(l))}</td></tr>`).join("")}</tbody></table>
      <div class="legal">PLEASE CHECK ALL ITEMS MENTIONED IN THIS DELIVERY NOTE HAVE BEEN RECEIVED BEFORE SIGNING.<br>ORYX DOOR SYSTEMS LLC WILL NOT ACCEPT RESPONSIBILITY FOR ANY MISSING PARTS SHOULD THESE BE REPORTED AFTER THE DAY OF DELIVERY.</div>
      <div class="sign"><div>Have you checked the items in the delivery note? (YES/NO)</div><div>RECEIVER NAME: ______________________</div><div>SIGN: ______________________</div><div>DATE: ${esc(fmtDate(n.delivery_date) || "______________")}</div><div>COMMENTS: ______________________</div></div>
    </div>`;
  }

  Object.assign(C, { fmtDate, problems, fieldsOf, sheetHtml, SHEET_CSS });
})(typeof window !== "undefined" ? window : globalThis);

/* ---------------- Delivery Notes page + the Check-out hook ---------------- */
(function () {
  if (typeof document === "undefined" || !window.ORYX_AUTH) return; // tests load the core only
  const C = window.ORYX_DN_CORE;
  const AUTH = window.ORYX_AUTH;
  const sb = AUTH.sb;
  const PDFJS_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const CONTACT_1 = "+971 526648991", CONTACT_2 = "+971 545112407"; // on every delivery note so far
  const KIND = { powder_coating: "Powder coating", finished_goods: "Finished goods" };
  const STATUS = { prepared: ["Prepared", "grey"], review: ["Needs review", "warn"], confirmed: ["Confirmed", "ok"], corrected: ["Corrected", "dark"] };
  const $ = (s, root) => (root || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

  // Server refusals in plain words.
  const MISSING = { ral_code: "the RAL code", delivery_address: "the delivery address", delivered_by: "who delivers it (Delivered by)", delivery_date: "the delivery date", lines: "at least one line" };
  function explain(err) {
    const m = String((err && (err.message || err.details)) || err || "");
    if (/missing:/.test(m)) return "Fill in " + m.split("missing:")[1].split(",").map((k) => MISSING[k.trim()] || k).join(", ") + " before confirming.";
    if (/already_confirmed/.test(m)) return "Someone already confirmed this note. Reload the list to see it.";
    if (/no_checkout/.test(m)) return "This job list hasn't been checked out yet. Check it out first; its delivery notes are prepared then.";
    if (/reason_required/.test(m)) return "Write the reason for the correction.";
    if (/not_allowed/.test(m)) return "Your account isn't allowed to do this.";
    if (/line_qty_invalid/.test(m)) return "Every line needs a quantity above 0.";
    if (/line_description_invalid/.test(m)) return "Every line needs a description.";
    if (/date_invalid/.test(m)) return "The delivery date isn't a valid date.";
    if (/not_confirmed/.test(m)) return "Only a confirmed note can be corrected.";
    if (/not_a_test_note/.test(m)) return "Only test notes can be deleted.";
    return "It didn't work: " + (m || "unknown error") + ". Try again; if it keeps failing, tell the admin.";
  }

  // ---------- reading the job list (pdf.js, same build as Check-out) ----------
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (window.__pdfjs) return Promise.resolve(window.__pdfjs);
    if (!pdfjsPromise) pdfjsPromise = import(PDFJS_SRC).then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return m; });
    return pdfjsPromise;
  }
  async function sha256(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function readJobListFile(file) {
    const buf = await file.arrayBuffer();
    const hash = await sha256(buf);
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      pages.push({ items: c.items.filter((it) => it.transform).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })) });
    }
    return { job: C.readJobList(pages), hash };
  }
  function notesPayload(built) {
    return [
      { kind: "powder_coating", delivery_address: "ALUMETAL", contact_no: CONTACT_1, secondary_contact_no: CONTACT_2, ral_code: built.colour || "",
        lines: built.pcLines.map((l) => ({ description: l.description, qty: l.qty })), flags: built.flags.filter((f) => !/finished items/i.test(f)).concat(built.unknown.map((u) => "Not recognised, check: " + u)) },
      { kind: "finished_goods", contact_no: CONTACT_1, secondary_contact_no: CONTACT_2,
        lines: built.fgLines.filter((l) => l.qty > 0).map((l) => ({ description: l.description, qty: l.qty, comments: l.comments })), flags: built.flags.filter((f) => /finished items/i.test(f)) },
    ].filter((n) => n.lines.length);
  }
  // test = Admin test mode: any job list, no Check-out, marked TEST.
  async function prepareFrom(job, hash, fileName, jobNumber, client, test) {
    const built = C.buildNotes(job);
    const notes = notesPayload(built);
    if (!notes.length) return { created: 0, existing: 0, nothing: true };
    const { data, error } = await sb.rpc(test ? "prepare_delivery_test_notes" : "prepare_delivery_notes", {
      p_hash: hash, p_job: jobNumber || job.job, p_client: client || job.client, p_doc_name: fileName, p_notes: notes,
    });
    if (error) throw error;
    return data;
  }

  // ---------- Check-out hook: called after a Check-out was saved ----------
  // Never touches the stock: the Check-out is already confirmed when this runs,
  // and a failure here only shows a message with "Try again".
  async function afterCheckout(opts) {
    const host = document.createElement("div");
    host.className = "dn-after";
    const box = opts && opts.container;
    if (!box || !opts.file || !opts.hash) return;
    box.appendChild(host);
    const run = async () => {
      host.innerHTML = `<p class="small muted">Preparing the delivery notes…</p>`;
      try {
        const { job, hash } = await readJobListFile(opts.file);
        if (hash !== opts.hash) throw new Error("The job list changed while it was being read.");
        const r = await prepareFrom(job, hash, opts.file.name, opts.job, opts.client);
        host.innerHTML = r.nothing
          ? `<p class="small muted">No delivery notes: nothing on this job list goes for coating or delivery.</p>`
          : `<div class="dn-after-ok"><span><b>Delivery notes prepared</b> (powder coating + finished goods). Fill in the driver, date and RAL code when the delivery goes out.</span>
             <button type="button" class="btn-outline btn-sm" data-dn-open>Open Delivery Notes</button></div>`;
        const b = $("[data-dn-open]", host);
        if (b) b.addEventListener("click", () => openPage(hash));
      } catch (e) {
        host.innerHTML = `<div class="dn-after-bad"><span>The Check-out is saved, but the delivery notes weren't prepared. ${esc(explain(e))}</span>
          <button type="button" class="btn-outline btn-sm" data-dn-retry>Try again</button></div>`;
        $("[data-dn-retry]", host).addEventListener("click", run);
      }
    };
    run();
  }

  // ---------- the page ----------
  const ui = { notes: [], selected: null, draft: null, history: [], canCorrect: false, correcting: false, busy: false, msg: null, filter: "open", search: "", focusHash: null, prepMsg: null };
  const status = (n) => (n.dn_number ? (n.corrected_count > 0 ? "corrected" : "confirmed") : n.kind === "powder_coating" && !String(n.ral_code || "").trim() ? "review" : "prepared");
  const pill = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
  const testBadge = (n) => (n.is_test ? ` <span class="badge no" title="Test note: no stock involved, not a real delivery note">TEST</span>` : "");
  const isAdmin = () => !!(AUTH.isAdmin && AUTH.isAdmin());

  async function load() {
    const list = $("#dnList");
    if (!list) return;
    const tl = $("#dnTestLabel");
    if (tl) tl.hidden = !isAdmin();
    list.innerHTML = `<p class="small muted">Loading…</p>`;
    const [notes, corr] = await Promise.all([
      sb.from("delivery_notes").select("*").order("created_at", { ascending: false }).order("kind").order("id").limit(500),
      sb.rpc("can_correct_delivery_notes"),
    ]);
    if (notes.error) { list.innerHTML = `<p class="small" style="color:#A23A33">Could not load the delivery notes: ${esc(notes.error.message)}</p>`; return; }
    ui.notes = notes.data || [];
    ui.canCorrect = !corr.error && corr.data === true;
    if (ui.focusHash) {
      // A test note is filed under its own fingerprint (SHA-256 of "test:" +
      // the job list's), so it is found by that.
      const want = ui.focusTest ? await sha256(new TextEncoder().encode("test:" + ui.focusHash)) : ui.focusHash;
      const first = ui.notes.find((n) => n.source_document_hash === want && !!n.is_test === !!ui.focusTest);
      if (first) { ui.selected = first.id; ui.filter = first.is_test ? "test" : "all"; }
      ui.focusHash = null; ui.focusTest = false;
    }
    if (ui.selected) await selectNote(ui.selected, true); else render();
  }
  async function selectNote(id, keepMsg) {
    if (!keepMsg || id !== ui.selected) ui.msg = null;
    ui.confirmDelete = false;
    ui.selected = id; ui.correcting = false;
    const n = ui.notes.find((x) => x.id === id);
    ui.draft = n ? JSON.parse(JSON.stringify(n)) : null;
    ui.history = [];
    render();
    if (!n) return;
    const { data } = await sb.from("delivery_note_history").select("*").eq("note_id", id).order("created_at");
    if (ui.selected === id) { ui.history = data || []; render(); }
  }
  function visible() {
    const q = ui.search.trim().toLowerCase();
    return ui.notes.filter((n) => {
      const s = status(n);
      // Test notes (Admins only) never mix with the real ones.
      if ((ui.filter === "test") !== !!n.is_test) return false;
      if (ui.filter === "open" && (s === "confirmed" || s === "corrected")) return false;
      if (ui.filter === "done" && !(s === "confirmed" || s === "corrected")) return false;
      if (!q) return true;
      return [n.job_number, n.client, n.customer_ref, n.dn_number, n.delivered_by, n.source_document_name, KIND[n.kind]].some((v) => String(v || "").toLowerCase().includes(q));
    });
  }

  // Redrawing removes the box being typed in; its "change" event then fires
  // during the redraw. The guard skips that nested redraw (the typed value is
  // already in the draft from its "input" event).
  let rendering = false;
  function render() {
    if (rendering) return;
    rendering = true;
    try { draw(); } finally { rendering = false; }
  }
  function draw() {
    const list = $("#dnList"), detail = $("#dnDetail");
    if (!list) return;
    const rows = visible();
    const counts = { open: 0, done: 0, real: 0, test: 0 };
    ui.notes.forEach((n) => {
      if (n.is_test) { counts.test++; return; }
      counts.real++;
      const s = status(n); if (s === "confirmed" || s === "corrected") counts.done++; else counts.open++;
    });
    const filters = [["open", `Waiting (${counts.open})`], ["done", `Confirmed (${counts.done})`], ["all", `All (${counts.real})`]];
    if (isAdmin()) filters.push(["test", `Test notes (${counts.test})`]);
    $("#dnFilters").innerHTML = filters
      .map(([k, t]) => `<button type="button" class="ghost${ui.filter === k ? " on" : ""}" data-dn-filter="${k}" aria-pressed="${ui.filter === k}">${t}</button>`).join("");
    list.innerHTML = ui.filter === "test" && !rows.length
      ? `<div class="card dn-empty">No test notes. Use "Test with a job list" above: any FP Pro job list, no Check-out and no stock involved.</div>`
      : !ui.notes.length
      ? `<div class="card dn-empty">No delivery notes yet. They're prepared automatically when a job list is checked out. For a job that was checked out before this page existed, use "Prepare from a job list" above.</div>`
      : !rows.length ? `<div class="card dn-empty">Nothing here. Try another filter.</div>`
      : `<div class="card dn-list-card"><div class="dn-scroll"><table class="fp-table dn-table">
          <thead><tr><th>Note</th><th>Order</th><th>Customer</th><th>Status</th><th>DN No</th><th>Delivery</th><th>Prepared</th></tr></thead><tbody>
          ${rows.map((n) => `<tr data-dn-id="${esc(n.id)}" tabindex="0" class="${ui.selected === n.id ? "sel" : ""}">
            <td><b>${KIND[n.kind]}</b>${testBadge(n)}</td><td>${esc(n.job_number)}</td><td>${esc(n.customer_ref || n.client)}</td><td>${pill(status(n))}</td>
            <td>${esc(n.dn_number || "—")}</td><td>${esc([C.fmtDate(n.delivery_date), n.delivered_by].filter(Boolean).join(" · ") || "—")}</td><td class="small muted">${esc(when(n.created_at))}</td></tr>`).join("")}
          </tbody></table></div></div>`;
    detail.innerHTML = ui.draft ? detailHtml(ui.draft) : "";
    wire();
  }

  function detailHtml(n) {
    const saved = ui.notes.find((x) => x.id === n.id) || n;
    const st = status(saved), editable = !saved.dn_number || ui.correcting;
    const probs = C.problems(n);
    const dis = editable && !ui.busy ? "" : "disabled";
    const field = (id, key, label, need, type) => `<div class="dn-field"><label class="field-label" for="${id}">${label}</label>
      <input id="${id}" data-f="${key}" type="${type || "text"}" value="${esc(n[key] || "")}" ${dis} class="${need && !String(n[key] || "").trim() ? "dn-need" : ""}"></div>`;
    let h = `<div class="card dn-detail">
      <div class="dn-detail-h">
        <div><h2 class="card-title" style="margin:0">${KIND[n.kind]} · Order ${esc(n.job_number)}${testBadge(n)}</h2>
          <div class="small muted">${esc(n.client || "")} · from ${esc(n.source_document_name || "job list")}${n.created_by_name ? " · prepared by " + esc(n.created_by_name) : ""}</div></div>
        <div class="dn-detail-st">${pill(st)}${saved.dn_number ? `<b>${esc(saved.dn_number)}</b>` : ""}</div>
      </div>`;
    if (n.is_test) h += `<div class="dn-msg bad">Test note: made from the job list only, no Check-out and no stock involved. It is numbered TEST-…, seen only by Admins, and can be deleted.</div>`;
    if (!saved.dn_number && (n.flags || []).length) h += `<ul class="dn-flags">${n.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`;
    if (ui.msg) h += `<div class="dn-msg ${ui.msg.kind}" role="status">${esc(ui.msg.text)}</div>`;
    h += `<div class="dn-form">
      ${n.kind === "powder_coating" ? `<div class="dn-field dn-wide"><label class="field-label" for="dnRal">RAL code (printed in the Comments column)</label>
        <input id="dnRal" data-f="ral_code" value="${esc(n.ral_code || "")}" placeholder="e.g. REL7006M SD3000700634" ${dis} class="${!String(n.ral_code || "").trim() ? "dn-need" : ""}"></div>` : ""}
      ${field("dnAddress", "delivery_address", "Delivery address", true)}
      ${field("dnDriver", "delivered_by", "Delivered by", true)}
      ${field("dnDate", "delivery_date", "Delivery date", true, "date")}
      ${field("dnC1", "contact_no", "Contact No")}
      ${field("dnC2", "secondary_contact_no", "Secondary Contact No")}
      ${field("dnRef", "customer_ref", "Customer Ref")}
    </div>
    <div class="dn-scroll"><table class="fp-table dn-lines">
      <thead><tr><th style="width:48px">S.No</th><th>Item description</th><th style="width:110px;text-align:right">Quantity</th>${n.kind === "finished_goods" ? "<th>Comments</th>" : ""}${editable ? "<th style='width:80px'></th>" : ""}</tr></thead>
      <tbody>${n.lines.map((l, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${editable ? `<textarea data-i="${i}" data-k="description" rows="${Math.max(1, String(l.description).split("\n").length)}" aria-label="Line ${i + 1} description" ${dis}>${esc(l.description)}</textarea>` : `<span class="dn-pre">${esc(l.description)}</span>`}</td>
        <td class="num">${editable ? `<input data-i="${i}" data-k="qty" type="number" min="0" step="any" value="${esc(l.qty)}" aria-label="Line ${i + 1} quantity" ${dis}>` : esc(l.qty)}</td>
        ${n.kind === "finished_goods" ? `<td>${editable ? `<textarea data-i="${i}" data-k="comments" rows="1" aria-label="Line ${i + 1} comments" ${dis}>${esc(l.comments || "")}</textarea>` : esc(l.comments || "")}</td>` : ""}
        ${editable ? `<td><button type="button" class="btn-outline btn-sm" data-remove="${i}" ${dis}>Remove</button></td>` : ""}</tr>`).join("")}</tbody>
    </table></div>`;
    if (editable) h += `<div class="dn-row"><button type="button" class="btn-outline btn-sm" id="dnAddLine" ${dis}>Add line</button>${n.kind === "powder_coating" ? `<span class="small muted">e.g. L ANGLE, FLAT TRIM</span>` : ""}</div>`;
    if (editable && probs.length) h += `<ul class="dn-probs">${probs.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
    if (!saved.dn_number) {
      h += `<div class="dn-row dn-actions">
        <button type="button" class="btn-outline" id="dnSave" ${dis}>Save</button>
        <button type="button" class="btn-yellow" id="dnConfirm" ${probs.length || ui.busy ? "disabled" : ""}>Confirm and give DN number</button>
        <span class="small muted">${probs.length ? "Fill in what's listed above to confirm." : "After confirming, the note is locked."}</span></div>`;
    } else if (ui.correcting) {
      h += `<div class="dn-field dn-wide"><label class="field-label" for="dnReason">Reason for the correction (kept with the note)</label>
          <textarea id="dnReason" rows="2" placeholder="e.g. Housing was 4 bars, not 3" ${ui.busy ? "disabled" : ""}></textarea></div>
        <div class="dn-row dn-actions"><button type="button" class="btn-yellow" id="dnSaveCorr" ${probs.length || ui.busy ? "disabled" : ""}>Save correction</button>
          <button type="button" class="btn-outline" id="dnCancelCorr" ${ui.busy ? "disabled" : ""}>Cancel</button></div>`;
    } else {
      h += `<div class="dn-row dn-actions"><button type="button" class="btn-dark" id="dnPrint">Print</button>
        ${ui.canCorrect ? `<button type="button" class="btn-outline" id="dnStartCorr">Correct this note</button>` : `<span class="small muted">Confirmed notes are locked. Only Admins and named people (Renato) can correct them.</span>`}</div>`;
    }
    if (n.is_test && isAdmin() && !ui.correcting) {
      h += ui.confirmDelete
        ? `<div class="dn-row dn-delete"><span>Delete this test note for good?</span><button type="button" class="btn-outline btn-sm" id="dnDeleteYes" ${ui.busy ? "disabled" : ""}>Delete</button><button type="button" class="btn-outline btn-sm" id="dnDeleteNo">Keep</button></div>`
        : `<div class="dn-row"><button type="button" class="btn-outline btn-sm" id="dnDeleteAsk">Delete test note</button></div>`;
    }
    if (ui.history.length) {
      h += `<div><h3 class="dn-h3">History</h3><ul class="dn-history">${ui.history.map((x) => `<li><b>${esc(when(x.created_at))}</b> · ${esc(
        x.action === "prepared" ? `Prepared by ${x.by_name || "someone"}` : x.action === "confirmed" ? `Confirmed by ${x.by_name || "someone"}` : `Corrected by ${x.by_name || "someone"}: ${x.reason || ""}`)}</li>`).join("")}</ul></div>`;
    }
    h += `<div><h3 class="dn-h3">Printed note</h3><div class="dn-sheet-wrap">${C.sheetHtml(saved.dn_number && !ui.correcting ? saved : n)}</div></div>`;
    return h + `</div>`;
  }

  function wire() {
    document.querySelectorAll("[data-dn-filter]").forEach((b) => b.addEventListener("click", () => { ui.filter = b.dataset.dnFilter; render(); }));
    document.querySelectorAll("#dnList tr[data-dn-id]").forEach((tr) => {
      tr.addEventListener("click", () => selectNote(tr.dataset.dnId));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNote(tr.dataset.dnId); } });
    });
    const d = ui.draft, root = $("#dnDetail");
    if (!d || !root) return;
    const refresh = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };
    root.querySelectorAll("[data-f]").forEach((el) => {
      el.addEventListener("input", () => { d[el.dataset.f] = el.value; });
      el.addEventListener("change", refresh);
    });
    root.querySelectorAll("[data-k]").forEach((el) => {
      el.addEventListener("input", () => { const l = d.lines[+el.dataset.i]; l[el.dataset.k] = el.dataset.k === "qty" ? (el.value === "" ? "" : Number(el.value)) : el.value; });
      el.addEventListener("change", refresh);
    });
    root.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => { d.lines.splice(+b.dataset.remove, 1); refresh(); }));
    const on = (id, fn) => { const el = $("#" + id, root); if (el) el.addEventListener("click", fn); };
    on("dnAddLine", () => { d.lines.push({ description: "", qty: 1, comments: "" }); refresh(); });
    on("dnSave", () => send("save_delivery_note", { p_id: d.id, p_fields: C.fieldsOf(d) }, "Saved."));
    on("dnConfirm", () => send("confirm_delivery_note", { p_id: d.id, p_fields: C.fieldsOf(d) }, null));
    on("dnStartCorr", () => { ui.correcting = true; ui.msg = null; refresh(); });
    on("dnCancelCorr", () => { ui.correcting = false; ui.draft = JSON.parse(JSON.stringify(ui.notes.find((x) => x.id === d.id))); refresh(); });
    on("dnSaveCorr", () => {
      const reason = ($("#dnReason", root).value || "").trim();
      if (!reason) { ui.msg = { kind: "bad", text: "Write the reason for the correction before saving." }; refresh(); return; }
      send("correct_delivery_note", { p_id: d.id, p_fields: C.fieldsOf(d), p_reason: reason }, "Correction saved. The DN number stays the same.");
    });
    on("dnPrint", () => printNote(ui.notes.find((x) => x.id === d.id)));
    on("dnDeleteAsk", () => { ui.confirmDelete = true; refresh(); });
    on("dnDeleteNo", () => { ui.confirmDelete = false; refresh(); });
    on("dnDeleteYes", async () => {
      ui.busy = true; refresh();
      const { error } = await sb.rpc("delete_test_delivery_note", { p_id: d.id });
      ui.busy = false; ui.confirmDelete = false;
      if (error) { ui.msg = { kind: "bad", text: explain(error) }; refresh(); return; }
      ui.selected = null; ui.draft = null;
      const st = $("#dnPrepStatus"); st.textContent = "Test note deleted."; st.className = "small dn-ok-text";
      await load();
    });
  }

  async function send(fn, args, okText) {
    if (ui.busy) return;
    ui.busy = true; ui.msg = null; render();
    const { data, error } = await sb.rpc(fn, args);
    ui.busy = false;
    if (error) { ui.msg = { kind: "bad", text: explain(error) }; render(); return; }
    const row = Array.isArray(data) ? data[0] : data;
    const i = ui.notes.findIndex((x) => x.id === row.id);
    if (i >= 0) ui.notes[i] = row;
    ui.msg = { kind: "ok", text: okText || `Confirmed as ${row.dn_number}. Press Print to print it.` };
    await selectNote(row.id, true);
  }

  // A hidden frame on this page; the browser's print window also offers "Save as PDF".
  function printNote(n) {
    if (!n) return;
    const old = $("#dnPrintFrame");
    if (old) old.remove();
    const f = document.createElement("iframe");
    f.id = "dnPrintFrame";
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed; right:0; bottom:0; width:0; height:0; border:0; visibility:hidden";
    document.body.appendChild(f);
    const doc = f.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(n.dn_number || "Delivery note")} ${esc(n.job_number)}</title>
      <style>@page{size:A4;margin:14mm} body{margin:0;font-family:Arial,Helvetica,sans-serif} ${C.SHEET_CSS} .dn-sheet{box-shadow:none;width:auto;min-height:0;padding:0}</style></head>
      <body>${C.sheetHtml(n)}</body></html>`);
    doc.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); }, 250);
  }

  // "Prepare from a job list": for jobs checked out before this page existed,
  // or when preparing after a Check-out failed. The server only accepts a job
  // list that is on a saved Check-out, and never makes a second copy.
  async function prepareFromFile(file, test) {
    const st = $("#dnPrepStatus");
    st.textContent = "Reading the job list…"; st.className = "small muted";
    try {
      const { job, hash } = await readJobListFile(file);
      const r = await prepareFrom(job, hash, file.name, null, null, test);
      const what = test ? "test note" : "delivery note";
      st.textContent = r.nothing ? "Nothing on this job list goes for coating or delivery."
        : r.created ? `Prepared ${r.created} ${what}${r.created === 1 ? "" : "s"} for Order ${job.job}.${test ? " No stock was touched." : ""}`
        : `This job list's ${what}s already exist (Order ${job.job}).`;
      st.className = "small dn-ok-text";
      ui.focusHash = hash; ui.focusTest = !!test;
      await load();
    } catch (e) {
      st.textContent = explain(e); st.className = "small dn-bad-text";
    }
  }

  function openPage(hash) {
    ui.focusHash = hash || null;
    if (window.ORYX_SHOW_VIEW) window.ORYX_SHOW_VIEW("delivery-notes");
    load();
  }

  // The printed-note layout, shared with the print window.
  const sheetStyle = document.createElement("style");
  sheetStyle.textContent = C.SHEET_CSS;
  document.head.appendChild(sheetStyle);

  const nav = $("#navDeliveryNotes");
  if (nav) nav.addEventListener("click", () => load());
  const search = $("#dnSearch");
  if (search) search.addEventListener("input", () => { ui.search = search.value; render(); });
  const reload = $("#dnReload");
  if (reload) reload.addEventListener("click", () => load());
  const pf = $("#dnPrepFile");
  if (pf) pf.addEventListener("change", () => { const f = pf.files[0]; pf.value = ""; if (f) prepareFromFile(f, false); });
  // Admin test mode (the server checks again): any job list, no Check-out.
  const tf = $("#dnTestFile"), tl = $("#dnTestLabel");
  if (tl) tl.hidden = !isAdmin();
  if (tf) tf.addEventListener("change", () => { const f = tf.files[0]; tf.value = ""; if (f && isAdmin()) prepareFromFile(f, true); });

  window.ORYX_DN = { afterCheckout, open: openPage };
})();
