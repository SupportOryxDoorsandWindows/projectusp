/* Original PDFs kept with each Check-in / Check-out.
 *
 * At Confirm the browser sends the PDF along with the lines; the checkin /
 * checkout Edge Function keeps it in the PRIVATE Storage bucket
 * "transaction-documents" after the stock was saved, and lists it in
 * transaction_documents. The link to the transaction is the fingerprint:
 * transaction_documents.document_hash = inventory_transactions.
 * source_document_hash (the same SHA-256 the duplicate-PDF check uses).
 *
 * window.ORYX_DOCS:
 *  - lookup(hashes): Map<hash, kept row> for the hashes that have a file.
 *  - links(hash) / attachLink(hash, kind): button HTML. Any page can render
 *    them; the clicks are handled here (one listener for the whole page).
 *  - open / download: a 5-minute signed link, made only when clicked, for
 *    signed-in active staff (Storage policy; nobody else can read the bucket).
 *  - attach(kind, file, expectedHash): keep the PDF of an already saved
 *    transaction ("Try again" after a failed keep, or an older one). The
 *    server only accepts the exact file the transaction was confirmed from.
 * Nothing here deletes a kept file.
 */
(function () {
  const AUTH = window.ORYX_AUTH;
  if (!AUTH) return;
  const sb = AUTH.sb;
  const CFG = window.ORYX_CONFIG;
  const BUCKET = "transaction-documents";
  const MAX_BYTES = 25 * 1024 * 1024; // the bucket's own limit
  const FN = { check_in: CFG.supabaseUrl + "/functions/v1/checkin", check_out: CFG.supabaseUrl + "/functions/v1/checkout" };
  const HASH_RE = /^[0-9a-f]{64}$/;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kept = new Map(); // hash -> row (a kept file never changes, so it's safe to remember)

  async function lookup(hashes) {
    const all = [...new Set((hashes || []).filter((h) => h && HASH_RE.test(h)))];
    const want = all.filter((h) => !kept.has(h));
    const chunks = [];
    for (let i = 0; i < want.length; i += 80) chunks.push(want.slice(i, i + 80));
    await Promise.all(chunks.map(async (chunk) => {
      const { data, error } = await sb.from("transaction_documents")
        .select("document_hash, kind, storage_path, file_name, size_bytes, uploaded_by_name, created_at")
        .in("document_hash", chunk);
      if (error) throw error;
      for (const r of data || []) kept.set(r.document_hash, r);
    }));
    const out = new Map();
    for (const h of all) if (kept.has(h)) out.set(h, kept.get(h));
    return out;
  }

  async function signedUrl(hash, download) {
    const row = (await lookup([hash])).get(hash);
    if (!row) throw new Error("this PDF isn't kept");
    const { data, error } = await sb.storage.from(BUCKET)
      .createSignedUrl(row.storage_path, 300, download ? { download: row.file_name || "document.pdf" } : undefined);
    if (error) throw error;
    return data.signedUrl;
  }

  // The tab is opened during the click itself (pop-up blockers allow that),
  // then sent to the signed link once it's ready.
  async function open(hash) {
    const w = window.open("", "_blank");
    if (!w) throw new Error("the browser blocked the new tab — allow pop-ups for this site");
    try { w.document.title = "Opening PDF…"; w.document.body.textContent = "Opening the PDF…"; } catch (e) { /* ignore */ }
    try {
      w.location.replace(await signedUrl(hash, false));
    } catch (err) {
      w.close();
      throw err;
    }
  }

  async function download(hash) {
    const url = await signedUrl(hash, true);
    const a = document.createElement("a");
    a.href = url; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  }

  const REASONS = {
    too_large: "it's over 25 MB",
    not_a_pdf: "it isn't a PDF file",
    different_file: "it isn't the same file this transaction was confirmed from",
    no_transaction: "no Check-in or Check-out was confirmed from this file",
    missing_document: "no file was chosen",
    empty_file: "the file is empty",
    upload_failed: "the file store didn't take it",
    record_failed: "the file store didn't take it",
    sign_in_required: "you're signed out — sign in again",
  };
  const reason = (code, detail) => REASONS[code] || detail || code || "unknown error";

  async function attach(kind, file, expectedHash) {
    if (!file) throw new Error(reason("missing_document"));
    if (file.size > MAX_BYTES) throw new Error(reason("too_large"));
    const headers = await AUTH.fnHeaders();
    delete headers["Content-Type"]; // the browser sets the multipart boundary
    const form = new FormData();
    form.append("payload", JSON.stringify({ action: "attach_document", expected_hash: expectedHash || null }));
    form.append("document", file, file.name);
    const res = await fetch(FN[kind] || FN.check_out, { method: "POST", headers, body: form });
    let data;
    try { data = await res.json(); } catch { throw new Error(`the server didn't answer properly (HTTP ${res.status})`); }
    if (!data.ok) throw new Error(reason(data.error || (data.document && data.document.error), data.detail));
    if (expectedHash) kept.delete(expectedHash);
    document.dispatchEvent(new CustomEvent("oryx-doc-kept", { detail: { hash: expectedHash } }));
    return data;
  }

  function links(hash) {
    return `<span class="doc-links"><button type="button" class="doc-btn" data-doc-open="${esc(hash)}">View PDF</button>` +
      `<button type="button" class="doc-btn quiet" data-doc-download="${esc(hash)}">Download</button></span>`;
  }
  function attachLink(hash, kind) {
    return `<span class="doc-links"><span class="doc-none">No PDF kept</span>` +
      `<button type="button" class="doc-btn quiet" data-doc-attach="${esc(hash)}" data-doc-kind="${esc(kind)}">Attach the original PDF</button></span>`;
  }

  function say(btn, text) {
    const holder = btn.closest(".doc-links") || btn.parentElement;
    let el = holder.querySelector(".doc-msg");
    if (!el) { el = document.createElement("span"); el.className = "doc-msg"; el.setAttribute("role", "status"); holder.appendChild(el); }
    el.textContent = text;
  }

  let picker = null;
  function pickFile() {
    return new Promise((resolve) => {
      if (!picker) {
        picker = document.createElement("input");
        picker.type = "file"; picker.accept = "application/pdf,.pdf"; picker.hidden = true;
        document.body.appendChild(picker);
      }
      picker.value = "";
      picker.onchange = () => resolve(picker.files && picker.files[0] ? picker.files[0] : null);
      picker.click();
    });
  }

  // Buttons may sit inside a <summary> (Activity): stop the click from also
  // opening/closing the card.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("[data-doc-open],[data-doc-download],[data-doc-attach]");
    if (!btn) return;
    e.preventDefault();
    if (btn.disabled) return;
    const hash = btn.dataset.docOpen || btn.dataset.docDownload || btn.dataset.docAttach;
    if (btn.dataset.docAttach) {
      const file = await pickFile();
      if (!file) return;
      btn.disabled = true; say(btn, "Checking and keeping the file…");
      try {
        await attach(btn.dataset.docKind, file, hash);
        const holder = btn.closest(".doc-links");
        if (holder && holder.isConnected) holder.outerHTML = links(hash);
      } catch (err) {
        say(btn, "Not kept: " + err.message + ".");
      } finally { btn.disabled = false; }
      return;
    }
    btn.disabled = true;
    try {
      if (btn.dataset.docOpen) await open(hash); else await download(hash);
      say(btn, "");
    } catch (err) {
      console.error(err);
      say(btn, "Couldn't open the PDF: " + (err.message || err) + ".");
    } finally { btn.disabled = false; }
  });

  window.ORYX_DOCS = { lookup, open, download, attach, links, attachLink, reason, MAX_BYTES };
})();
