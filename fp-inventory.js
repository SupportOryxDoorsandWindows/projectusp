/* Master Inventory: item list (Kanban colours, Show filter, search, pages), photos, Adjust dialog, Transaction History and the inventory Extract (.xlsx).
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, CHECKOUT_FN_URL, esc, fmt, fnHeaders, loadXlsxLib, money, readFnJson, sb,
    itemPhotoButton, loadItemPhotos, openItemPhoto, CHECKIN_FN_URL, genericMoney,
    loadSupplierAliases, STYLE_HEADER, STYLE_LABEL, STYLE_TITLE, todayISO } = FP;

  // "Extract inventory": the Master Inventory item list as an .xlsx, exactly
  // as the Items table shows it (search and Show filter applied, every
  // page), with the same Oryx-blue title/header styling as the
  // transactions report. Read-only -- nothing is written anywhere.
  const INVENTORY_COLS = ["Code", "Description", "Category", "Bar length (mm)", "Unit", "Qty", "Unit cost (AED)", "Value (AED)", "Kanban trigger", "Critical level", "Status"];
  // Same Kanban rule as the rows (kanban.js).
  function inventoryStatus(it) {
    const k = kanbanOf(it);
    if (k === "critical") return "Critical";
    if (k === "low") return "Low";
    return it.current_qty <= 0 ? "Out" : "OK";
  }
  function buildInventorySheet(items, filterNote) {
    const n = INVENTORY_COLS.length;
    const aoa = [
      ["Oryx Doors & Windows — Master Inventory"],
      [`Generated ${todayISO()}${filterNote ? " — " + filterNote : ""}`],
      [],
      INVENTORY_COLS,
    ];
    const firstDataRow = aoa.length;
    for (const it of items) {
      aoa.push([
        it.item_code, it.description || "", it.category || "",
        it.bar_length_mm != null ? it.bar_length_mm : "",
        it.unit_of_measure || "", it.current_qty, it.unit_cost, it.current_value,
        it.buffer_level != null ? it.buffer_level : "", it.critical_level != null ? it.critical_level : "", inventoryStatus(it),
      ]);
    }
    const totalRow = aoa.length;
    aoa.push(["", `${items.length} item${items.length === 1 ? "" : "s"}`, "", "", "", "", "Total",
      items.reduce((s, it) => s + (it.current_value || 0), 0)]);

    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: n - 1 } }];
    ws["!cols"] = [{ wch: 12 }, { wch: 44 }, { wch: 12 }, { wch: 15 }, { wch: 8 }, { wch: 10 }, { wch: 15 }, { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 9 }];
    ws["!rows"] = [{ hpt: 22 }];
    ws["!autofilter"] = { ref: window.XLSX.utils.encode_range({ s: { r: firstDataRow - 1, c: 0 }, e: { r: totalRow - 1, c: n - 1 } }) };
    const cell = (r, c) => {
      const addr = window.XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: "s", v: "" };
      return ws[addr];
    };
    cell(0, 0).s = STYLE_TITLE;
    cell(1, 0).s = { font: { italic: true } };
    for (let c = 0; c < n; c++) cell(firstDataRow - 1, c).s = STYLE_HEADER;
    for (let r = firstDataRow; r <= totalRow; r++) {
      for (const c of [6, 7]) if (typeof cell(r, c).v === "number") cell(r, c).z = '"AED" #,##0.00';
    }
    cell(totalRow, 6).s = STYLE_LABEL;
    cell(totalRow, 7).s = STYLE_LABEL;
    return ws;
  }
  async function exportInventoryList() {
    const btn = $("#miExtractBtn");
    const setStatus = (text, kind) => {
      const el = $("#miExtractStatus");
      el.textContent = text || "";
      el.style.color = kind === "err" ? "var(--danger)" : "";
    };
    const items = miFilteredItems;
    if (!miCurrentItems.length) { setStatus("The Master Inventory hasn't loaded yet — try again in a moment.", "err"); return; }
    if (!items.length) { setStatus("No items match the current search/filter — nothing to extract.", "err"); return; }
    btn.disabled = true;
    setStatus("Preparing the Excel file…");
    try {
      await loadXlsxLib();
      const q = ($("#miSearch").value || "").trim();
      const filterKey = $("#miFilter").value || "all";
      const notes = [];
      if (filterKey !== "all") notes.push(({ out: "out of stock", nocost: "no cost", nophoto: "no photo", normal: "normal stock", low: "low stock", critical: "critical stock" })[filterKey] + " only");
      if (q) notes.push(`search "${q}"`);
      const filterNote = notes.length ? `filtered: ${notes.join(", ")} (${items.length} of ${miCurrentItems.length} items)` : "";
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, buildInventorySheet(items, filterNote), "Master Inventory");
      const outName = `Oryx Master Inventory - ${todayISO()}${notes.length ? " (filtered)" : ""}.xlsx`;
      window.XLSX.writeFile(wb, outName);
      setStatus(`Extracted ${items.length} item${items.length === 1 ? "" : "s"} as ${outName}.`);
    } catch (err) {
      console.error(err);
      setStatus("Could not extract: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }
  async function loadMasterInventoryView() {
    $("#miItemsBody").innerHTML = `<tr><td colspan="7" class="small muted">Loading…</td></tr>`;
    $("#miTxBody").innerHTML = `<tr><td colspan="7" class="small muted">Loading…</td></tr>`;
    try {
      const [itemsRes, txRes, aliases, photos, lastChange] = await Promise.all([
        sb.from("inventory_items").select("*").order("item_code"),
        // Fetched at line-item grain, then grouped back into one Check-out
        // per (job, client, timestamp) below -- Postgres's now() returns the
        // same value for every row inserted inside one checkout_transaction()
        // call, so that triple is a reliable grouping key.
        sb.from("inventory_transactions").select("*").order("created_at", { ascending: false }).limit(500),
        loadSupplierAliases(),
        loadItemPhotos(),
        loadLastChangeByItem(),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (txRes.error) throw txRes.error;
      renderMasterInventoryView(itemsRes.data, txRes.data, photos, lastChange);
      renderRememberedMatches(aliases, itemsRes.data);
    } catch (err) {
      console.error(err);
      $("#miItemsBody").innerHTML = `<tr><td colspan="7" class="small" style="color:var(--danger)">Could not load: ${esc(err.message)}</td></tr>`;
      $("#miTxBody").innerHTML = "";
    }
  }

  // "Last change" column (proposal page 7): each item's newest movement and
  // who made it (performed_by_name, recorded since 2026-10-07).
  async function loadLastChangeByItem() {
    const last = new Map();
    try {
      const PAGE = 1000;
      for (let from = 0; from < 50000; from += PAGE) {
        const { data, error } = await sb.from("inventory_transactions")
          .select("item_id, created_at, performed_by_name")
          .order("created_at", { ascending: false }).range(from, from + PAGE - 1);
        if (error) throw error;
        for (const t of data) if (t.item_id && !last.has(t.item_id)) last.set(t.item_id, t);
        if (data.length < PAGE) break;
      }
    } catch (e) { console.error("last change", e); }
    return last;
  }
  function lastChangeCell(t) {
    if (!t) return `<td class="mi-last muted">—</td>`;
    const w = window.ORYX_ITEM ? window.ORYX_ITEM.when(t.created_at).long : new Date(t.created_at).toLocaleString("en-GB");
    return `<td class="mi-last"><b>${esc(t.performed_by_name || "Before sign-in")}</b><div>${esc(w)}</div></td>`;
  }

  // Remembered matches ("teach once, remember"): every saved link, newest
  // first, with Forget. Forgetting goes through the `checkin` Edge Function
  // (the table itself is read-only to the site).
  function renderRememberedMatches(aliases, items) {
    const body = $("#miAliasBody");
    const box = $("#miAliasBox");
    if (!body || !box) return;
    const byId = new Map((items || []).map((it) => [it.id, it]));
    const list = [...(aliases || [])].sort((a, b) => String(b.last_confirmed_at).localeCompare(String(a.last_confirmed_at)));
    // Nothing to show -> no section at all.
    box.hidden = !list.length;
    $("#miAliasCount").textContent = list.length ? `(${list.length})` : "";
    body.innerHTML = list.map((a) => {
      const it = byId.get(a.item_id);
      const wrote = a.match_kind === "code" ? `Code ${a.match_key}` : (a.example_text || a.match_key);
      return `<tr>
        <td>${esc(wrote)}<div class="small muted">${esc(a.supplier || a.supplier_key)}</div></td>
        <td>${it ? `<span class="code">${esc(it.item_code)}</span> — ${esc(it.description || "")}${it.bar_length_mm ? ` <span class="small muted">(${esc(it.bar_length_mm)} mm)</span>` : ""}` : `<span class="small muted">item no longer exists</span>`}</td>
        <td><button class="ghost" type="button" data-alias-forget="${esc(a.id)}">Forget</button></td>
      </tr>`;
    }).join("");
    for (const btn of body.querySelectorAll("[data-alias-forget]")) {
      btn.onclick = async () => {
        const a = list.find((x) => x.id === btn.dataset.aliasForget);
        if (!a) return;
        const it = byId.get(a.item_id);
        if (!window.confirm(`Forget this match?\n\n${a.match_kind === "code" ? "Code " + a.match_key : (a.example_text || a.match_key)}  →  ${it ? it.item_code : "this item"}`)) return;
        btn.disabled = true;
        const statusEl = $("#miAliasStatus");
        try {
          const res = await fetch(CHECKIN_FN_URL, {
            method: "POST",
            headers: await fnHeaders(),
            body: JSON.stringify({ action: "forget_alias", id: a.id }),
          });
          const data = await readFnJson(res);
          if (!data.ok) throw new Error(data.detail || data.error || "The link was not removed.");
          statusEl.textContent = "Forgotten.";
          renderRememberedMatches(list.filter((x) => x.id !== a.id), items);
        } catch (err) {
          console.error(err);
          statusEl.textContent = "Could not forget: " + err.message;
          btn.disabled = false;
        }
      };
    }
  }

  // Manual Check-in/Check-out -- a single-item correction typed in directly,
  // for cases like a physical recount finding one item off with no source
  // document to drive it through the normal PDF-parsing flow. Goes through
  // the exact same checkin/checkout Edge Functions and Postgres functions as
  // every other transaction (so it shows up identically in Transaction
  // History, via txTypeBadge above) -- the only difference is the line item
  // is typed by hand instead of parsed from a PDF. Always AED, rate 1: this
  // is an internal correction, never a supplier document in another currency.
  function openMiAdjustDialog(item) {
    const dlg = $("#miAdjustDialog");
    $("#miAdjustTitle").textContent = `Adjust ${item.item_code}`;
    $("#miAdjustSubtitle").textContent = `${item.description || ""} — current stock: ${fmt(item.current_qty)}`;
    // Default: set the stock to what was counted (e.g. 58). The system works
    // out the difference and books it as a Check-in or Check-out.
    $("#miAdjustDirection").value = "set_to";
    $("#miAdjustQty").value = "";
    $("#miAdjustCost").value = item.unit_cost != null ? item.unit_cost : "";
    $("#miAdjustReason").value = "";
    $("#miAdjustError").style.display = "none";

    const updateAdjustForm = () => {
      const dir = $("#miAdjustDirection").value;
      const qty = parseFloat($("#miAdjustQty").value);
      $("#miAdjustQtyLabel").textContent = dir === "set_to" ? "Counted quantity (new stock)" : dir === "check_in" ? "Quantity to add" : "Quantity to take out";
      $("#miAdjustCostField").style.display = dir === "check_in" ? "" : "none";
      let preview = "";
      if (isFinite(qty) && $("#miAdjustQty").value !== "") {
        const after = dir === "set_to" ? qty : dir === "check_in" ? item.current_qty + qty : item.current_qty - qty;
        const diff = after - item.current_qty;
        preview = `Stock: ${fmt(item.current_qty)} → ${fmt(after)}` +
          (diff === 0 ? " (no change)" : ` (${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff))})`);
      }
      $("#miAdjustPreview").textContent = preview;
    };
    $("#miAdjustDirection").onchange = updateAdjustForm;
    $("#miAdjustQty").oninput = updateAdjustForm;
    updateAdjustForm();

    function showErr(msg) {
      $("#miAdjustError").textContent = msg;
      $("#miAdjustError").style.display = "";
    }

    $("#miAdjustCancel").onclick = () => dlg.close();

    $("#miAdjustSubmit").onclick = async () => {
      let direction = $("#miAdjustDirection").value;
      let qty = parseFloat($("#miAdjustQty").value);
      const reason = $("#miAdjustReason").value.trim();
      let unitCostForSet = null;
      if (direction === "set_to") {
        // A stock count: book only the difference, at the item's own cost
        // (so it never moves the item's average cost).
        if (!(qty >= 0) || $("#miAdjustQty").value === "") return showErr("Enter the counted quantity (0 or more).");
        // The difference must come from the stock as it is NOW: the list may
        // be minutes old, and a Check-out by someone else in the meantime
        // would leave the stock off by that amount instead of at the count.
        const { data: fresh, error: freshErr } = await sb.from("inventory_items")
          .select("current_qty").eq("id", item.id).maybeSingle();
        if (freshErr || !fresh) return showErr("Could not re-read the current stock. Please try again.");
        if (Math.abs(Number(fresh.current_qty) - Number(item.current_qty)) > 1e-9) {
          item.current_qty = Number(fresh.current_qty);
          $("#miAdjustSubtitle").textContent = `${item.description || ""} — current stock: ${fmt(item.current_qty)}`;
          updateAdjustForm();
          return showErr(`The stock changed to ${fmt(item.current_qty)} since this list was loaded. Check the preview and press Save again.`);
        }
        const diff = qty - item.current_qty;
        if (Math.abs(diff) < 1e-9) return showErr(`Stock is already ${fmt(item.current_qty)} — nothing to change.`);
        if (!reason) return showErr("A reason is required for every manual adjustment.");
        direction = diff > 0 ? "check_in" : "check_out";
        qty = Math.round(Math.abs(diff) * 1e6) / 1e6;
        unitCostForSet = item.unit_cost != null ? Number(item.unit_cost) : 0;
      } else {
        if (!(qty > 0)) return showErr("Enter a quantity greater than 0.");
        if (!reason) return showErr("A reason is required for every manual adjustment.");
      }

      if (direction === "check_out" && qty > item.current_qty && unitCostForSet == null) {
        const proceed = confirm(
          `This would take ${item.item_code} to ${fmt(item.current_qty - qty)}, below zero. Continue anyway?`
        );
        if (!proceed) return;
      }

      const btn = $("#miAdjustSubmit");
      btn.disabled = true;
      try {
        if (direction === "check_in") {
          const unitCost = unitCostForSet != null ? unitCostForSet : parseFloat($("#miAdjustCost").value);
          if (!(unitCost >= 0)) { showErr("Enter a valid unit cost."); return; }
          const res = await fetch(CHECKIN_FN_URL, {
            method: "POST",
            headers: await fnHeaders(),
            body: JSON.stringify({
              supplier: "Manual correction",
              invoice_number: unitCostForSet != null ? `Stock count: ${reason}` : reason,
              currency: "AED",
              exchange_rate: 1,
              lines: [{ item_id: item.id, quantity: qty, unit: item.unit_of_measure || "", unit_cost: unitCost }],
            }),
          });
          const data = await readFnJson(res);
          if (!data.ok) throw new Error(data.detail || data.error || "The manual Check-in was not applied.");
        } else {
          const res = await fetch(CHECKOUT_FN_URL, {
            method: "POST",
            headers: await fnHeaders(),
            body: JSON.stringify({
              job_number: unitCostForSet != null ? `Stock count: ${reason}` : reason,
              client: "Manual correction",
              lines: [{ item_id: item.id, quantity: qty, unit: item.unit_of_measure || "" }],
            }),
          });
          const data = await readFnJson(res);
          if (!data.ok) throw new Error(data.detail || data.error || "The manual Check-out was not applied.");
        }
        dlg.close();
        await loadMasterInventoryView();
        // An open item panel shows the new stock and the new line straight away.
        if (window.ORYX_ITEM && window.ORYX_ITEM.currentItemId() === item.id) window.ORYX_ITEM.open(item);
      } catch (err) {
        console.error(err);
        showErr(err.message);
      } finally {
        btn.disabled = false;
      }
    };

    dlg.showModal();
  }

  // What the Items table is currently showing (after search / Show filter,
  // across every page) -- the Extract button exports exactly this.
  let miCurrentItems = [];
  let miFilteredItems = [];

  // Kanban state of an item (unset / normal / low / critical): the shared
  // rule in kanban.js -- the row colour, the badge, the Show filter and the
  // Extract all read it, so they can't disagree.
  const kanbanOf = (it) => window.ORYX_KANBAN.kanbanState(it).state;

  // Status badge shown in the list. Out of stock is said first; then the
  // Kanban state (same as the row colour), then No cost.
  function miStatus(it) {
    const k = kanbanOf(it);
    if (!(Number(it.current_qty) > 0)) return { key: "out", html: `<span class="badge no">Out of stock</span>` };
    if (k === "critical" || k === "low") return { key: k, html: window.ORYX_KANBAN.BADGE[k] };
    if (!(Number(it.unit_cost) > 0)) return { key: "nocost", html: `<span class="badge warn">No cost</span>` };
    return { key: "ok", html: `<span class="badge ok">In stock</span>` };
  }

  let miPage = 0;
  // Fabrication stock (L Angle, Box Section, Flat Trim) is listed after
  // everything else, i.e. on the last page(s); otherwise by item code.
  const LAST_PAGE_ITEMS = /\b(l angle|box section|box|flat trim)\b/i;
  const sortForList = (items) => [...items].sort((a, b) =>
    LAST_PAGE_ITEMS.test(a.description || "") - LAST_PAGE_ITEMS.test(b.description || ""));

  function renderMasterInventoryView(items, txs, photos, lastChange) {
    items = sortForList(items);
    lastChange = lastChange || new Map();
    const totalValue = items.reduce((s, it) => s + (it.current_value || 0), 0);
    const codes = new Set(items.map((it) => String(it.item_code).toUpperCase()));
    const hasPhoto = (it) => photos && photos.has(String(it.item_code).toUpperCase());
    const noPhotoCodes = [...codes].filter((c) => !(photos && photos.has(c))).length;
    $("#miTally").innerHTML = `
      <span class="mi-kpi"><b>${esc(money(totalValue).replace(/\.\d\d$/, ""))}</b> stock value</span>
      <span class="mi-kpi"><b>${items.length}</b> items in ${codes.size} codes</span>`;

    // The "Show" dropdown beside the search box (was a row of chips).
    const FILTERS = {
      all: { label: "All items", test: () => true },
      // Kanban: only items with a trigger level set (left out while none).
      normal: { label: "Normal stock", test: (it) => kanbanOf(it) === "normal", kanban: true, group: "Stock" },
      low: { label: "Low stock", test: (it) => kanbanOf(it) === "low", kanban: true, group: "Stock" },
      critical: { label: "Critical stock", test: (it) => kanbanOf(it) === "critical", kanban: true, group: "Stock" },
      out: { label: "Out of stock", test: (it) => !(Number(it.current_qty) > 0), group: "Stock" },
      nocost: { label: "No cost", test: (it) => Number(it.current_qty) > 0 && !(Number(it.unit_cost) > 0), group: "Missing details" },
      nophoto: { label: "No photo", test: (it) => !hasPhoto(it), count: `${noPhotoCodes} codes`, group: "Missing details" },
    };
    const drawFilter = () => {
      const sel = $("#miFilter");
      const cur = FILTERS[sel.value] ? sel.value : "all";
      const opt = (k, f) => {
        const n = items.filter(f.test).length;
        if (f.kanban && !n && k !== cur) return "";
        return `<option value="${k}"${k === cur ? " selected" : ""}>${esc(f.label)} (${esc(f.count || n)})</option>`;
      };
      const groups = new Map();
      for (const [k, f] of Object.entries(FILTERS)) if (f.group) groups.set(f.group, (groups.get(f.group) || "") + opt(k, f));
      sel.innerHTML = opt("all", FILTERS.all) +
        [...groups].filter(([, html]) => html).map(([g, html]) => `<optgroup label="${esc(g)}">${html}</optgroup>`).join("");
      sel.value = cur;
    };

    const PAGE_SIZE = 10;
    miCurrentItems = items;

    function draw() {
      const q = ($("#miSearch").value || "").trim().toLowerCase();
      const f = FILTERS[$("#miFilter").value] || FILTERS.all;
      const filtered = items.filter((it) => {
        if (!f.test(it)) return false;
        if (!q) return true;
        return it.item_code.toLowerCase().includes(q) || (it.description || "").toLowerCase().includes(q);
      });

      miFilteredItems = filtered;
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      miPage = Math.min(miPage, pageCount - 1);
      const start = miPage * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);
      const openId = window.ORYX_ITEM && window.ORYX_ITEM.currentItemId();

      $("#miItemsBody").innerHTML = pageItems.map((it) => {
        const sub = [esc(it.item_code), it.bar_length_mm ? `${esc(fmt(it.bar_length_mm))} mm` : "", hasPhoto(it) ? "" : "no photo yet"].filter(Boolean).join(" · ");
        // Whole-row Kanban colour: kb-low (yellow) / kb-critical (red).
        const k = kanbanOf(it);
        const kb = k === "low" || k === "critical" ? ` kb-${k}` : "";
        return `<tr class="mi-row${kb} ${it.id === openId ? "sel" : ""}" data-mi-row="${esc(it.id)}">
          <td><div class="mi-item">${itemPhotoButton(photos, it)}<div><div class="mi-name">${esc(it.description || it.item_code)}</div><div class="mi-code mono">${sub}</div></div></div></td>
          <td class="num mono">${fmt(it.current_qty)}</td>
          <td class="num mono">${Number(it.unit_cost || 0).toFixed(2)}</td>
          <td class="num mono">${Number(it.current_value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${miStatus(it).html}</td>
          ${lastChangeCell(lastChange.get(it.id))}
          <td class="mi-actions"><button class="btn-outline btn-sm" type="button" data-mi-timeline="${esc(it.id)}">Timeline</button>
            <button class="btn-outline btn-sm" type="button" data-mi-adjust="${esc(it.id)}">Adjust</button></td>
        </tr>`;
      }).join("") || `<tr><td colspan="7" class="small muted">No items match.</td></tr>`;

      for (const btn of $("#miItemsBody").querySelectorAll("[data-mi-photo]")) {
        btn.onclick = (e) => { e.stopPropagation(); openItemPhoto(btn.dataset.miPhoto, btn.dataset.miPhotoCap); };
      }
      const openTimeline = (id) => {
        const item = pageItems.find((it) => String(it.id) === id);
        if (!item || !window.ORYX_ITEM) return;
        window.ORYX_ITEM.open(item, { onAdjust: (fresh) => openMiAdjustDialog(fresh || item) });
        for (const tr of $("#miItemsBody").querySelectorAll("tr[data-mi-row]")) tr.classList.toggle("sel", tr.dataset.miRow === id);
      };
      for (const btn of $("#miItemsBody").querySelectorAll("[data-mi-timeline]")) {
        btn.onclick = (e) => { e.stopPropagation(); openTimeline(btn.dataset.miTimeline); };
      }
      for (const tr of $("#miItemsBody").querySelectorAll("tr[data-mi-row]")) {
        tr.onclick = (e) => { if (!e.target.closest("button")) openTimeline(tr.dataset.miRow); };
      }
      for (const btn of $("#miItemsBody").querySelectorAll("[data-mi-adjust]")) {
        btn.onclick = (e) => {
          e.stopPropagation();
          const item = pageItems.find((it) => String(it.id) === btn.dataset.miAdjust);
          if (item) openMiAdjustDialog(item);
        };
      }

      $("#miItemsPagerInfo").textContent = filtered.length
        ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} · tap a photo to enlarge`
        : "No items match.";
      $("#miItemsPageLabel").textContent = `Page ${miPage + 1} of ${pageCount}`;
      $("#miItemsPrev").disabled = miPage === 0;
      $("#miItemsNext").disabled = miPage >= pageCount - 1;
    }
    drawFilter();
    draw();
    $("#miFilter").onchange = () => { miPage = 0; draw(); };
    $("#miSearch").oninput = () => { miPage = 0; draw(); };
    $("#miItemsPrev").onclick = () => { miPage = Math.max(0, miPage - 1); draw(); };
    $("#miItemsNext").onclick = () => { miPage = miPage + 1; draw(); };
    if (!renderMasterInventoryView.wired) {
      renderMasterInventoryView.wired = true;
      document.addEventListener("oryx-item-closed", () => {
        for (const tr of document.querySelectorAll("#miItemsBody tr.sel")) tr.classList.remove("sel");
      });
      // New Kanban levels (item panel, Admins) change the row colour, badge
      // and Show filter: re-read the list.
      document.addEventListener("oryx-item-changed", () => { loadMasterInventoryView(); });
    }

    renderTransactionHistory(txs);
  }

  function txTypeBadge(type) {
    if (type === "check_in") return `<span class="fp-status-ok">Check-in</span>`;
    if (type === "stock_adjustment") return `<span class="fp-status-review">Stock adjustment</span>`;
    return `<span class="fp-status-unmatched">Check-out</span>`;
  }

  // One row per transaction event (Check-out job or Check-in document), not
  // per line item — expandable to see the individual items that moved.
  // Check-out groups by (job, client, timestamp); Check-in groups by
  // (invoice/PO, supplier, timestamp) -- both rely on the same fact: every
  // line inserted by one checkout_transaction()/checkin_transaction() call
  // shares one Postgres now() value.
  function renderTransactionHistory(txs) {
    const groups = new Map();
    for (const tx of txs) {
      const isCheckin = tx.type === "check_in";
      const reference = isCheckin ? (tx.invoice_number || tx.po_number || "") : tx.job_number;
      const party = isCheckin ? tx.supplier : tx.client;
      const key = `${tx.type}|${reference}|${party}|${tx.created_at}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, type: tx.type, created_at: tx.created_at, reference, party, lines: [], totalValue: 0, hash: null, docName: "" };
        groups.set(key, g);
      }
      g.lines.push(tx);
      g.totalValue += tx.value || 0;
      if (!g.hash && tx.source_document_hash) { g.hash = tx.source_document_hash; g.docName = tx.source_document_name || ""; }
    }
    const groupList = [...groups.values()].slice(0, 20);

    $("#miTxBody").innerHTML = groupList.map((g) => `
      <tr class="fp-tx-group" data-key="${esc(g.key)}">
        <td><button class="fp-tx-toggle" data-key="${esc(g.key)}" aria-label="Show items">▸</button></td>
        <td>${esc(String(g.created_at).slice(0, 16).replace("T", " "))}</td>
        <td>${txTypeBadge(g.type)}</td>
        <td class="code">${esc(g.reference || "—")}</td>
        <td>${esc(g.party || "—")}</td>
        <td class="num">${g.lines.length}</td>
        <td class="num">${money(g.totalValue)}</td>
      </tr>
      <tr class="fp-tx-detail" data-detail-for="${esc(g.key)}" hidden>
        <td></td>
        <td colspan="6">
          ${g.hash ? `<div class="tx-doc small muted" data-tx-doc="${esc(g.hash)}" data-tx-kind="${esc(g.type)}" data-tx-name="${esc(g.docName || "PDF")}">${esc(g.docName || "PDF")}</div>` : ""}
          <table class="fp-table fp-tx-detail-table">
            <thead><tr><th>Code</th><th>Description</th><th class="num">Qty</th><th class="num">Value</th></tr></thead>
            <tbody>
              ${g.lines.map((tx) => `<tr>
                <td class="code">${esc(tx.item_code)}</td>
                <td>${esc(tx.description)}${tx.shipping_allocated ? `<div class="small muted" style="margin-top:2px">Landed cost: includes ${esc(genericMoney(tx.shipping_allocated, tx.original_currency || ""))} shipping allocation (original cost ${esc(genericMoney(tx.original_unit_cost, tx.original_currency || ""))} + shipping = ${esc(genericMoney(tx.landed_unit_cost, tx.original_currency || ""))} landed).</div>` : ""}</td>
                <td class="num">${fmt(tx.quantity)} ${esc(tx.unit)}</td>
                <td class="num">${money(tx.value)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="7" class="small muted">No transactions recorded yet.</td></tr>`;

    document.querySelectorAll(".fp-tx-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const detail = document.querySelector(`.fp-tx-detail[data-detail-for="${CSS.escape(key)}"]`);
        const open = !detail.hidden;
        detail.hidden = open;
        btn.textContent = open ? "▸" : "▾";
      });
    });
    fillTxDocs();
  }

  // Original PDF of each transaction (kept since 2026-10-12): View / Download,
  // or "Attach the original PDF" when only its fingerprint is on record.
  async function fillTxDocs() {
    const cells = [...document.querySelectorAll("#miTxBody [data-tx-doc]")];
    if (!cells.length || !window.ORYX_DOCS) return;
    let keptByHash;
    try { keptByHash = await window.ORYX_DOCS.lookup(cells.map((c) => c.dataset.txDoc)); } catch (err) { console.error("kept PDFs", err); return; }
    for (const c of cells) {
      const name = c.dataset.txName;
      c.innerHTML = `<span class="tx-doc-name">${esc(name)}</span> ` + (keptByHash.has(c.dataset.txDoc)
        ? window.ORYX_DOCS.links(c.dataset.txDoc)
        : window.ORYX_DOCS.attachLink(c.dataset.txDoc, c.dataset.txKind));
    }
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { exportInventoryList, fillTxDocs, loadMasterInventoryView, sortForList });
})();
