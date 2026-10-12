// Original PDF kept with each Check-in / Check-out: runs the REAL
// supabase/functions/checkout and checkin sources under Deno against a local
// stand-in Supabase (auth, PostgREST, Storage) -- nothing real is touched.
// Run it before redeploying either function:
//
//   node tests/edge/keep-pdf.js --deno <path to deno>
//
// (Deno 2: e.g. "npm install deno@2" in a scratch folder ->
// node_modules/.bin/deno. Behind a TLS-inspecting proxy set DENO_CERT.)
// Checks: stock saved BEFORE the file is kept; the exact bytes at
// <check-in|check-out>/<sha256>.pdf; never overwritten; wrong / non-PDF /
// over-25 MB files never kept and never fail the stock; JSON requests
// (manual adjustments, forget_alias) unchanged; attach_document only for a
// file a saved transaction was confirmed from; sign-in required.
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const assert = require("assert");

const path = require("path");
const args = process.argv.slice(2);
const denoBin = args.indexOf("--deno") >= 0 ? args[args.indexOf("--deno") + 1] : null;
if (!denoBin) { console.error("usage: node tests/edge/keep-pdf.js --deno <path to deno>"); process.exit(2); }
const repo = path.resolve(__dirname, "../..");
// A small but real PDF (header + one empty page).
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const STAFF = { user_id: "11111111-1111-1111-1111-111111111111", active: true, email: "p@x.com", full_name: "Paulo Test" };

const db = { calls: [], objects: new Map(), docs: [], txHashes: new Map(), storageFails: false, rpcResult: null };

function readBody(req) { return new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); }); }
const fake = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  db.calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname === "/auth/v1/user") {
    return (req.headers.authorization === "Bearer staff-token") ? send(200, { id: STAFF.user_id, aud: "authenticated", role: "authenticated", email: STAFF.email }) : send(401, { msg: "bad jwt" });
  }
  if (url.pathname === "/rest/v1/user_profiles") {
    return /vnd\.pgrst\.object/.test(req.headers.accept || "") ? send(200, STAFF) : send(200, [STAFF]);
  }
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const args = JSON.parse(body.toString());
    db.lastRpc = { name: url.pathname.slice(13), args };
    if (db.rpcResult) return send(200, db.rpcResult);
    if (args.p_pdf_hash) db.txHashes.set(args.p_pdf_hash, url.pathname.includes("checkin") ? "check_in" : "check_out");
    if (url.pathname.endsWith("remember_supplier_aliases")) return send(200, { saved: args.p_entries.length });
    return send(200, { ok: true, lines: args.p_lines.map((l, k) => ({ item_id: l.item_id || "new-" + k })) });
  }
  if (url.pathname.startsWith("/storage/v1/object/transaction-documents/")) {
    const path = decodeURIComponent(url.pathname.slice("/storage/v1/object/transaction-documents/".length));
    if (db.storageFails) return send(500, { statusCode: "500", error: "internal", message: "storage down" });
    if (db.objects.has(path)) return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
    db.objects.set(path, { bytes: body, type: req.headers["content-type"] });
    return send(200, { Key: "transaction-documents/" + path, Id: "x" });
  }
  if (url.pathname === "/rest/v1/transaction_documents") {
    const row = JSON.parse(body.toString());
    db.docRequest = { prefer: req.headers.prefer, onConflict: url.searchParams.get("on_conflict") };
    if (!db.docs.some((d) => d.document_hash === row.document_hash)) db.docs.push(row);
    return send(201, []);
  }
  if (url.pathname === "/rest/v1/inventory_transactions") {
    const h = (url.searchParams.get("source_document_hash") || "").replace(/^eq\./, "");
    const type = db.txHashes.get(h);
    const rows = type ? [{ type }] : [];
    return /vnd\.pgrst\.object/.test(req.headers.accept || "") ? (rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116" })) : send(200, rows);
  }
  if (url.pathname === "/rest/v1/supplier_item_aliases") return send(200, []);
  send(404, { error: "unhandled " + url.pathname });
});

async function startFn(name, port) {
  const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${fake.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "service", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const p = spawn(denoBin, ["run", "-A", `${repo}/supabase/functions/${name}/index.ts`], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 600; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { method: "OPTIONS" }); return { p, log: () => log }; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(name + " did not start:\n" + log);
}

function form(payload, file, name = "Quote.pdf") {
  const f = new FormData();
  f.append("payload", JSON.stringify(payload));
  if (file) f.append("document", new Blob([file], { type: "application/pdf" }), name);
  return f;
}
const call = async (port, body, token = "staff-token") => {
  const headers = { Authorization: "Bearer " + token };
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers, body: body instanceof FormData ? body : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const reset = () => { db.calls = []; db.objects.clear(); db.docs = []; db.txHashes.clear(); db.storageFails = false; db.rpcResult = null; db.lastRpc = null; };

(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  // Deno's `--port` doesn't apply to Deno.serve() without options; it uses
  // 8000 by default, so the two functions run one after the other.
  const results = [];
  const ok = (name) => { results.push("PASS " + name); };

  /* ---------------- checkout ---------------- */
  let fn = await startFn("checkout", 8000);
  try {
    const H = sha(PDF);
    const base = { job_number: "26334", client: "ADAM", pdf_hash: H, source_document_name: "Job.pdf", lines: [{ item_id: "a", quantity: 2, unit: "pcs" }] };

    reset();
    let r = await call(8000, { ...base, pdf_hash: undefined, source_document_name: undefined, client: "Manual correction", job_number: "fix" });
    assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.document, null);
    assert.equal(db.objects.size, 0); assert.equal(db.lastRpc.args.p_job_number, "fix");
    ok("checkout JSON (manual adjustment) unchanged, nothing kept");

    reset();
    r = await call(8000, form(base, PDF, "26334F-Adam OPT LIST Rev. 01.pdf"));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.document, { saved: true });
    const obj = db.objects.get(`check-out/${H}.pdf`);
    assert.ok(obj && Buffer.compare(obj.bytes, PDF) === 0, "stored bytes equal the PDF");
    assert.equal(obj.type, "application/pdf");
    assert.equal(db.docs.length, 1);
    assert.deepEqual({ ...db.docs[0] }, { document_hash: H, kind: "check_out", storage_path: `check-out/${H}.pdf`, file_name: "26334F-Adam OPT LIST Rev. 01.pdf", size_bytes: PDF.length, uploaded_by: STAFF.user_id, uploaded_by_name: "Paulo Test" });
    assert.ok(/ignore-duplicates/.test(db.docRequest.prefer), "row insert never overwrites");
    const iRpc = db.calls.findIndex((c) => c.includes("/rpc/checkout_transaction_by")), iUp = db.calls.findIndex((c) => c.includes("/storage/"));
    assert.ok(iRpc >= 0 && iUp > iRpc, "stock saved before the file is kept");
    assert.equal(db.lastRpc.args.p_pdf_hash, H); assert.equal(db.lastRpc.args.p_job_number, "26334");
    ok("checkout multipart: stock saved first, exact PDF kept at check-out/<sha256>.pdf, row recorded");

    reset();
    r = await call(8000, form({ ...base, pdf_hash: "0".repeat(64) }, PDF));
    assert.equal(r.json.ok, true); assert.deepEqual(r.json.document, { saved: false, error: "different_file" }); assert.equal(db.objects.size, 0);
    ok("checkout: file whose fingerprint differs from pdf_hash is not kept (stock still saved)");

    reset();
    const notPdf = Buffer.from("hello, not a pdf");
    r = await call(8000, form({ ...base, pdf_hash: sha(notPdf) }, notPdf));
    assert.equal(r.json.ok, true); assert.deepEqual(r.json.document, { saved: false, error: "not_a_pdf" }); assert.equal(db.objects.size, 0);
    ok("checkout: non-PDF not kept");

    reset();
    db.rpcResult = { ok: false, error: "duplicate_document" };
    r = await call(8000, form(base, PDF));
    assert.equal(r.status, 409); assert.equal(r.json.error, "duplicate_document"); assert.equal(db.objects.size, 0); assert.equal(db.docs.length, 0);
    ok("checkout: duplicate document -> 409, nothing kept");

    reset();
    db.storageFails = true;
    r = await call(8000, form(base, PDF));
    assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.document.saved, false); assert.equal(r.json.document.error, "upload_failed"); assert.equal(db.docs.length, 0);
    ok("checkout: storage down -> Check-out still saved, document.saved=false");

    // attach_document (the retry, or an older transaction)
    db.storageFails = false;
    r = await call(8000, form({ action: "attach_document", expected_hash: H }, PDF, "again.pdf"));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json, { ok: true, document: { saved: true } });
    assert.equal(db.docs.length, 1); assert.equal(db.docs[0].kind, "check_out");
    ok("attach_document: retry keeps the file for the saved transaction");

    const before = db.objects.get(`check-out/${H}.pdf`).bytes;
    r = await call(8000, form({ action: "attach_document" }, PDF, "third.pdf"));
    assert.equal(r.json.ok, true); assert.equal(db.objects.get(`check-out/${H}.pdf`).bytes, before); assert.equal(db.docs.length, 1); assert.equal(db.docs[0].file_name, "again.pdf");
    ok("attach_document twice: no overwrite, still ok");

    r = await call(8000, form({ action: "attach_document", expected_hash: "f".repeat(64) }, PDF));
    assert.equal(r.status, 400); assert.equal(r.json.error, "different_file");
    ok("attach_document: a different file than expected is refused");

    reset();
    r = await call(8000, form({ action: "attach_document" }, PDF));
    assert.equal(r.status, 404); assert.equal(r.json.error, "no_transaction"); assert.equal(db.objects.size, 0);
    ok("attach_document: a file no transaction was confirmed from is refused");

    r = await call(8000, form({ action: "attach_document" }, null));
    assert.equal(r.status, 400); assert.equal(r.json.error, "missing_document");
    ok("attach_document without a file is refused");

    reset();
    const big = Buffer.alloc(25 * 1024 * 1024 + 1); big.write("%PDF-1.4");
    r = await call(8000, form({ ...base, pdf_hash: sha(big) }, big));
    assert.equal(r.json.ok, true); assert.deepEqual(r.json.document, { saved: false, error: "too_large" }); assert.equal(db.objects.size, 0);
    ok("checkout: over 25 MB not kept (stock still saved)");

    r = await call(8000, form(base, PDF), "nope");
    assert.equal(r.status, 401); assert.equal(r.json.error, "sign_in_required");
    ok("no sign-in -> 401");

    r = await call(8000, form({ action: "attach_document" }, PDF), "nope");
    assert.equal(r.status, 401);
    ok("attach_document needs sign-in");
  } catch (e) { console.error(fn.log()); throw e; } finally { fn.p.kill(); await new Promise((r) => setTimeout(r, 500)); }

  /* ---------------- checkin ---------------- */
  fn = await startFn("checkin", 8000);
  try {
    const H = sha(PDF);
    const base = { supplier: "FREEDOM", invoice_number: "47457", pdf_hash: H, source_document_name: "Quote.pdf", currency: "AUD", exchange_rate: 2.4,
      lines: [{ item_id: "a", quantity: 10, unit: "pcs", unit_cost: 5, remember: { supplier_key: "freedom", code_key: "ZIP49", description_key: null, example: "ZIP49" } }] };
    reset();
    let r = await call(8000, form(base, PDF, "Quote 47457.pdf"));
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true); assert.equal(r.json.remembered, 1);
    assert.deepEqual(r.json.document, { saved: true });
    assert.ok(db.objects.has(`check-in/${H}.pdf`)); assert.equal(db.docs[0].kind, "check_in"); assert.equal(db.docs[0].file_name, "Quote 47457.pdf");
    assert.equal(db.lastRpc.name !== undefined, true);
    ok("checkin multipart: stock saved, remembered links saved, PDF kept at check-in/<sha256>.pdf");

    reset();
    r = await call(8000, { ...base, pdf_hash: undefined, supplier: "Manual correction", lines: [{ item_id: "a", quantity: 1, unit: "", unit_cost: 2 }] });
    assert.equal(r.json.ok, true); assert.equal(r.json.document, null); assert.equal(db.objects.size, 0);
    ok("checkin JSON (manual adjustment) unchanged");

    reset();
    r = await call(8000, { action: "forget_alias", id: "not-a-uuid" });
    assert.equal(r.status, 400); assert.equal(r.json.error, "invalid_id");
    ok("checkin forget_alias still parsed as before");

    reset();
    db.txHashes.set(H, "check_in");
    r = await call(8000, form({ action: "attach_document", expected_hash: H }, PDF, "Quote.pdf"));
    assert.deepEqual(r.json, { ok: true, document: { saved: true } }); assert.ok(db.objects.has(`check-in/${H}.pdf`));
    ok("checkin attach_document keeps an older Check-in's PDF");

    reset();
    r = await call(8000, form({ ...base, lines: [{ item_id: "a", quantity: 0, unit: "", unit_cost: 1 }] }, PDF));
    assert.equal(r.status, 400); assert.equal(r.json.error, "invalid_line"); assert.equal(db.objects.size, 0);
    ok("checkin: invalid request -> nothing saved, nothing kept");
  } catch (e) { console.error(fn.log()); throw e; } finally { fn.p.kill(); }

  console.log(results.join("\n"));
  console.log(`\n${results.length} checks passed`);
  fake.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
