/* Item code pickers (search box, one option per bar length) and item photos, shared by the Check-out and Check-in previews and Master Inventory; keeps unsaved edits across redraws.
 *
 * Part of the stock screens that used to be one file (fp-pro.js). Loaded by
 * boot.js in a fixed order (see FP_FILES there); names shared between the
 * files go through window.ORYX_FP -- see the note at the top of fp-core.js. */

(function () {
  const FP = (window.ORYX_FP = window.ORYX_FP || {});
  const { $, esc, pickInventoryRow } = FP;

  /* --------------------------- Master Inventory view ---------- */

  // Item photos: one picture per item code (every bar length shares it),
  // taken from the stock Excel file and kept in assets/items/ with a
  // code -> file map in index.json. Loaded once; a missing map just means
  // no photos are shown.
  let itemPhotosPromise = null;
  function loadItemPhotos() {
    if (!itemPhotosPromise) {
      itemPhotosPromise = fetch("assets/items/index.json")
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({}))
        .then((map) => {
          const byCode = new Map();
          for (const [code, file] of Object.entries(map || {})) byCode.set(code.toUpperCase(), "assets/items/" + file);
          return byCode;
        });
    }
    return itemPhotosPromise;
  }
  // The photo thumbnail itself (a button that opens the viewer), or an
  // empty box when the code has no photo yet. `extraClass` sizes it.
  function itemPhotoButton(photos, it, extraClass = "") {
    const src = photos && photos.get(String(it.item_code).toUpperCase());
    if (!src) return `<span class="fp-photo-none ${extraClass}" title="No photo yet"></span>`;
    const label = `${it.item_code} — ${it.description || ""}`;
    return `<button class="fp-photo-btn ${extraClass}" type="button" data-mi-photo="${esc(src)}" data-mi-photo-cap="${esc(label)}" aria-label="View photo of ${esc(label)}">
      <img src="${esc(src)}" alt="" loading="lazy"></button>`;
  }
  function itemPhotoCell(photos, it) {
    return `<td>${itemPhotoButton(photos, it)}</td>`;
  }
  function openItemPhoto(src, caption) {
    const box = document.getElementById("lightbox");
    if (!box) return;
    const img = $("#lbImg");
    img.src = src;
    img.alt = caption;
    img.classList.add("fp-item-photo");
    // The same viewer shows drawings, which keep their own size.
    box.addEventListener("close", () => img.classList.remove("fp-item-photo"), { once: true });
    $("#lbCap").textContent = caption;
    box.showModal();
  }
  // Renders the Master Inventory code picker for an editing row: a search
  // box plus a click-to-select results list. The committed code only ever
  // changes via a click on a real Master Inventory entry -- there is no way
  // to save free-typed text, so a Check-in edit can never point at (or
  // implicitly create) anything that isn't an existing item.
  // Shared by both Check-out's Allocation Preview and Check-in's Preview:
  // a search box plus a click-to-select results list, backed by whichever
  // itemsByCode map the caller passes in. The committed code only ever
  // changes via a click on a real Master Inventory entry -- there's no way
  // to save free-typed text -- so an edit can never point at (or implicitly
  // create) anything that isn't an existing item.
  // One option per code -- except a code with several bar lengths (e.g. a
  // ZLS1 profile with 2500 / 2900 / 5100 mm rows), which gets one option per
  // length, so the person picks the exact row instead of the system guessing.
  function codePickerOptions(itemsByCode) {
    const options = [];
    for (const code of [...itemsByCode.keys()].sort()) {
      const rows = itemsByCode.get(code);
      const lengths = new Set(rows.map((c) => c.bar_length_mm).filter((n) => typeof n === "number"));
      if (rows.length > 1 && lengths.size > 1) {
        [...rows]
          .sort((a, b) => (a.bar_length_mm ?? Infinity) - (b.bar_length_mm ?? Infinity))
          .forEach((c) => options.push({
            code, id: c.id, description: c.description || "",
            label: c.bar_length_mm != null ? `${Math.round(c.bar_length_mm)} mm` : "",
            searchText: c.description || "",
          }));
      } else {
        options.push({
          code, id: rows.length === 1 ? rows[0].id : "", description: rows[0].description || "", label: "",
          searchText: rows.map((c) => c.description || "").join(" "),
        });
      }
    }
    return options;
  }

  // Resolves a picker's choice to one Master row: the exact row picked when
  // the picker recorded one, else the usual best row for the code.
  function pickedInventoryRow(itemsByCode, code, itemId, entry) {
    const candidates = (itemsByCode && itemsByCode.get(code)) || [];
    return (itemId && candidates.find((c) => c.id === itemId)) || pickInventoryRow(entry, candidates);
  }

  // Best matches first: codes that start with what was typed, then codes
  // that contain it, then description matches -- so "3000" lists 30001R
  // before 230001. Order within each group stays alphabetical by code.
  function rankPickerMatches(options, query) {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const rank = (o) => {
      const code = o.code.toLowerCase();
      if (code.startsWith(q)) return 0;
      if (code.includes(q)) return 1;
      if (o.searchText.toLowerCase().includes(q)) return 2;
      return -1;
    };
    return options
      .map((o) => ({ o, r: rank(o) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.o);
  }

  // The results list floats over the page (position: fixed) so a table's
  // scroll box can't hide it -- it used to open below the last row and get
  // clipped out of sight. Opens upward when there's no room below, and is
  // never narrower than 340px so it reads well from a narrow Code column.
  function placePickerResults(searchEl, resultsEl) {
    if (resultsEl.hidden || !searchEl.isConnected) return;
    const r = searchEl.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const height = Math.min(220, resultsEl.scrollHeight);
    const below = window.innerHeight - r.bottom;
    const top = below < height + 8 && r.top > below ? r.top - 2 - height : r.bottom + 2;
    Object.assign(resultsEl.style, {
      position: "fixed", left: left + "px", top: top + "px", width: width + "px",
      right: "auto", marginTop: "0", zIndex: "60",
    });
  }
  // One page-wide listener keeps whichever list is open next to its box
  // while the page or a table scrolls.
  let pickerRepositionWired = false;
  function wirePickerRepositioning() {
    if (pickerRepositionWired) return;
    pickerRepositionWired = true;
    const update = () => {
      document.querySelectorAll(".fp-dropdown-results:not([hidden])").forEach((el) => {
        const search = el.parentElement && el.parentElement.querySelector("input[type=text]");
        if (search) placePickerResults(search, el);
      });
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
  }

  // Every Save/Cancel/Skip redraws the whole table, which used to throw
  // away what was typed or picked in any OTHER row still open for editing.
  // These keep those unsaved values: noted per row (not per position, so a
  // deleted row can't shift them onto the wrong one) and put back after
  // the redraw, before the pickers are wired.
  function keepOpenEdits(container, rows) {
    const kept = [];
    if (!container || !rows) return kept;
    container.querySelectorAll("tr.fp-editing input[id], tr.fp-editing select[id], tr.fp-editing textarea[id]").forEach((el) => {
      const m = /^(.*?)(\d+)$/.exec(el.id);
      if (!m || !rows[+m[2]]) return;
      kept.push({ row: rows[+m[2]], base: m[1], value: el.value, checked: el.checked });
    });
    return kept;
  }
  function restoreOpenEdits(kept, rows) {
    kept.forEach(({ row, base, value, checked }) => {
      const i = rows.indexOf(row);
      if (i < 0 || !(row.editing || row.creatingNew)) return;
      const el = document.getElementById(base + i);
      if (!el || !el.closest("tr.fp-editing")) return;
      if (el.type === "checkbox" || el.type === "radio") el.checked = checked;
      else el.value = value;
    });
  }

  function wireCodePicker(prefix, itemsByCode, i) {
    const searchEl = document.getElementById(`${prefix}CodeSearch${i}`);
    const valueEl = document.getElementById(`${prefix}CodeValue${i}`);
    const idEl = document.getElementById(`${prefix}ItemId${i}`);
    const resultsEl = document.getElementById(`${prefix}CodeResults${i}`);
    const descEl = document.getElementById(`${prefix}Desc${i}`);
    if (!searchEl) return;

    const allOptions = codePickerOptions(itemsByCode);
    const optionText = (o) => `${o.code} — ${o.description}${o.label ? ` · ${o.label}` : ""}`;
    function renderResults(query) {
      const matches = rankPickerMatches(allOptions, query).slice(0, 30);
      resultsEl.innerHTML = matches.length
        ? matches.map((o) =>
            `<div class="fp-dropdown-option" data-code="${esc(o.code)}" data-id="${esc(o.id)}"><span class="code">${esc(o.code)}</span> — ${esc(o.description)}${o.label ? ` · <b>${esc(o.label)}</b>` : ""}</div>`
          ).join("")
        : `<div class="fp-dropdown-empty">No matching Master Inventory item.</div>`;
      resultsEl.hidden = false;
      wirePickerRepositioning();
      placePickerResults(searchEl, resultsEl);
    }

    searchEl.addEventListener("focus", () => renderResults(searchEl.value));
    searchEl.addEventListener("input", () => {
      valueEl.value = "";
      if (idEl) idEl.value = "";
      renderResults(searchEl.value);
    });
    searchEl.addEventListener("blur", () => { setTimeout(() => { resultsEl.hidden = true; }, 150); });
    // mousedown (not click) so it fires before the search box's blur closes the list.
    resultsEl.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".fp-dropdown-option");
      if (!opt) return;
      const o = allOptions.find((x) => x.code === opt.dataset.code && x.id === opt.dataset.id);
      if (!o) return;
      valueEl.value = o.code;
      if (idEl) idEl.value = o.id;
      searchEl.value = optionText(o);
      descEl.value = o.description;
      resultsEl.hidden = true;
    });
  }

  // Used by the other stock-screen files.
  Object.assign(FP, { codePickerOptions, itemPhotoButton, itemPhotoCell, keepOpenEdits, loadItemPhotos,
    openItemPhoto, pickedInventoryRow, rankPickerMatches, restoreOpenEdits, wireCodePicker });
})();
