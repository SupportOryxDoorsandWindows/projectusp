// Check-in sweep: reads EVERY sample invoice in a folder the way staff do,
// and records what the screen shows and what Confirm would save -- so a
// change made for one invoice is checked against all of them.
//
//   node tests/browser/checkin-sweep.js --pdfs <folder> --libs <folder> [--baseline <file>] [--update]
//
// --pdfs      supplier PDFs (kept OUT of this public repo).
// --libs      unpacked npm tarballs: pdfjs-dist@4.7.76 (as "pdfjs"),
//             @supabase/supabase-js@2.45.4 (as "supabase-supabase-js-2.45.4"),
//             xlsx-js-style@1.2.0 (as "xlsx-js-style-1.2.0") -- the CDN may be
//             unreachable from a sandbox. `npm pack <name>@<version>` + tar -x.
// --baseline  JSON from an earlier run; differences are printed and the exit
//             code is 1 if anything changed. --update rewrites it.
//
// Nothing is ever saved: the Edge Functions are answered here, the exchange
// rate is fixed (USD 3.6725, AUD 2.41 AED). Master Inventory is read live
// (read-only), so "current stock" is left out of the comparison.
// Per file it records: every row as read; every row after pressing
// "Use this item" on each Possible match; and the Confirm payload with the
// remaining unmatched lines acknowledged.
const fs = require("fs");
const path = require("path");
const { chromium } = require(require("child_process").execSync("npm root -g").toString().trim() + "/playwright");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const pdfDir = opt("--pdfs"), libDir = opt("--libs"), baselineFile = opt("--baseline");
if (!pdfDir || !libDir) { console.error("usage: --pdfs <folder> --libs <folder> [--baseline <file>] [--update]"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
const cdn = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "supabase-supabase-js-2.45.4/package/dist/umd/supabase.js",
  "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js": "xlsx-js-style-1.2.0/package/dist/xlsx.bundle.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs": "pdfjs/package/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs": "pdfjs/package/build/pdf.worker.min.mjs",
};
const round = (n) => (typeof n === "number" ? Math.round(n * 10000) / 10000 : n);

async function sweepFile(browser, file) {
  const p = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("https://app.local/**", (route) => {
    let f = new URL(route.request().url()).pathname; if (f === "/") f = "/index.html";
    const full = path.join(repo, f);
    if (!full.startsWith(repo) || !fs.existsSync(full)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".css": "text/css", ".json": "application/json" };
    route.fulfill({ status: 200, contentType: types[path.extname(full)] || "application/octet-stream", body: fs.readFileSync(full) });
  });
  await p.route("https://cdn.jsdelivr.net/**", (route) => {
    const url = route.request().url();
    const fx = url.match(/currency-api@([^/]+)\/v1\/currencies\/(\w+)\.json/);
    if (fx) {
      const rates = { usd: 3.6725, aud: 2.41 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ date: fx[1] === "latest" ? "2026-10-02" : fx[1], [fx[2]]: { aed: rates[fx[2]] } }) });
    }
    if (!cdn[url]) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(libDir, cdn[url])) });
  });
  const sent = [];
  await p.route("**/functions/v1/**", (route) => {
    sent.push(JSON.parse(route.request().postData() || "{}"));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, lines: [] }) });
  });
  await p.goto("https://app.local/", { waitUntil: "networkidle" });
  await p.click('nav button[data-v="checkin"]');
  await p.setInputFiles("#ciPdf", file);
  await p.waitForTimeout(300);
  await p.click("#ciExtract");
  for (let k = 0; k < 30 && !(await p.$("#ciOut table tbody tr")); k++) await p.waitForTimeout(1000);
  await p.waitForTimeout(500);
  // Code · Description (first line) · Check-in qty · Unit cost (no "Stored" AED, which follows the rate) · Status
  const rows = () => p.$$eval("#ciOut .fp-checkin-table tbody tr, #ciOut table tbody tr", (trs) => [...new Set(trs)].map((tr) => {
    const c = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
    return c.length < 10 ? null : [c[0], (tr.children[1].innerText.split("\n")[0] || "").trim(), c[3], c[5], c[9]].join(" | ");
  }).filter(Boolean));
  const result = { file: path.basename(file), asRead: await rows() };
  for (let k = 0; k < 40; k++) { const u = await p.$('#ciOut button[data-act="use-suggestion"]'); if (!u) break; await u.click(); await p.waitForTimeout(150); }
  result.afterUseThisItem = await rows();
  for (let k = 0; k < 60; k++) { const a = await p.$('#ciOut button[data-act="skip"]:not(.on):text-is("Acknowledge")'); if (!a) break; await a.click(); await p.waitForTimeout(80); }
  for (let k = 0; k < 20; k++) { const a = await p.$('#ciOut button[data-act="accept-pack"], #ciOut button[data-act="use-exact"]'); if (!a) break; await a.click(); await p.waitForTimeout(100); }
  if (!(await p.inputValue("#ciSupplier"))) await p.fill("#ciSupplier", "Sweep");
  if (!(await p.inputValue("#ciInvoiceNumber"))) await p.fill("#ciInvoiceNumber", "SWEEP");
  for (const sel of ["#ciMissingLnAck", "#ciOcrAck", "#ciLowConfAck"]) { const el = await p.$(sel); if (el) await el.check().catch(() => {}); }
  await p.waitForTimeout(300);
  if (await p.isDisabled("#ciConfirm")) {
    result.confirm = "disabled: " + (await p.textContent("#ciConfirmSummary"));
  } else {
    await p.click("#ciConfirm"); await p.waitForTimeout(1000);
    const body = sent.find((b) => Array.isArray(b.lines)) || { lines: [] };
    result.confirm = { currency: body.currency, rate: body.exchange_rate, lines: body.lines.map((l) => ({
      item_id: l.item_id, new_item: l.new_item ? l.new_item.item_code : undefined, qty: round(l.quantity), unit: l.unit,
      unit_cost_aed: round(l.unit_cost), orig: round(l.original_unit_cost), landed: round(l.landed_unit_cost), ship: round(l.shipping_allocated),
      rolls: l.package_qty, per_roll: l.qty_per_package, roll_cost_aed: round(l.package_cost),
    })) };
  }
  if (errors.length) result.pageErrors = errors;
  await p.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({ args: ["--ignore-certificate-errors"], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "192.0.2.2" } : undefined });
  const files = fs.readdirSync(pdfDir).filter((f) => /\.pdf$/i.test(f)).sort();
  const out = [];
  for (const f of files) {
    const r = await sweepFile(browser, path.join(pdfDir, f));
    out.push(r);
    console.log(`\n== ${r.file}`);
    r.afterUseThisItem.forEach((line, k) => console.log(`  ${r.asRead[k] === line ? " " : "*"} ${line}`));
    console.log("  confirm:", typeof r.confirm === "string" ? r.confirm : `${r.confirm.lines.length} line(s) saved`);
    if (r.pageErrors) console.log("  PAGE ERRORS:", r.pageErrors.join("; "));
  }
  await browser.close();
  console.log("\n(* = changed by pressing Use this item)");
  if (!baselineFile) return;
  if (args.includes("--update") || !fs.existsSync(baselineFile)) {
    fs.writeFileSync(baselineFile, JSON.stringify(out, null, 1));
    console.log(`baseline written: ${baselineFile}`);
    return;
  }
  const base = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  let diffs = 0;
  for (const r of out) {
    const b = base.find((x) => x.file === r.file);
    if (!b) { console.log(`NEW FILE (no baseline): ${r.file}`); diffs++; continue; }
    for (const key of ["asRead", "afterUseThisItem", "confirm"]) {
      const a = JSON.stringify(b[key]), c = JSON.stringify(r[key]);
      if (a !== c) { diffs++; console.log(`CHANGED ${r.file} · ${key}\n  before: ${a}\n  now:    ${c}`); }
    }
  }
  console.log(diffs ? `\n${diffs} difference(s) from the baseline.` : "\nIdentical to the baseline.");
  process.exit(diffs ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
