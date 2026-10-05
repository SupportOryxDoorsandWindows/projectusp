# Notes for Claude

## Product families (Master Inventory)

Item descriptions start with a product-family prefix. They are different
product lines — never treat one family's item as a match for another's:

| Prefix | Product |
|---|---|
| `SMB1` (also written `SMB`) | **Smartscreen** |
| `ZLS1` (also written `ZLS`) | **Flyscreen** |

- A ZLS1 part with no ZLS1 record in Master Inventory is a **new item** to be
  added (e.g. "ZLS1 Drawbar Cap 01 Right/ Black", "ZLS1 Drawbar Cap 01 Left/
  Black" from Freedom invoices) — not a match for the SMB1 or ZLX item with a
  similar name.
- The Check-in description matcher (`findUniqueDescriptionItem` in
  `fp-pro.js`) never auto-matches across a series-number difference
  ("ZLS" vs "ZLS1"). Such a match is only offered as a "Possible match —
  Use this item" suggestion (`findSeriesSuggestion`), because deciding that
  two names are the same part is the stock team's call, not the system's.
  It never suggests across families or across different series numbers.
- A second suggestion pass (`findCloseSuggestion`) covers supplier names
  that use a different product word, e.g. Freedom's "ZLS1-Infinity
  60mm-IS( 2.9m)Mill" for Master's "ZLS1 Housing 60 IS 01 MILL" (2900 mm).
  Family, size, side/colour/finish and the stated bar length must all agree;
  only one product word may differ, and a tie suggests nothing. It is never
  auto-applied. Known family words live in `PRODUCT_FAMILIES`.
- ZLS1 profiles have one Master row per bar length (2500 / 2900 / 5100 mm)
  under the same code, so anything that resolves a Check-in row must pick the
  exact length row by id, not just the code.

## Currency (Check-in)

- `detectDocumentCurrencyInfo` in `fp-pro.js`: a written code or code-marked
  symbol (USD, AUD, US$, A$…) wins; a bare "$" uses Australia-only markers
  (ABN, Pty Ltd, Australia, .com.au — not GST, which India also uses) or US
  markers; a bare "$" with no markers is **AUD** automatically — verified on
  real files: Freedom Screens of Australia's "$"-only Zipline/ZL2 order forms
  carry the same prices as their AUD quotes (never AED). The screen says so
  and keeps a preselected USD/AUD switch for the rare correction.
- The AED rate comes from the fawazahmed0 currency-api on jsDelivr, for the
  invoice date first, then latest, then the last rate on file.

## Supplier layouts & matching rules (Check-in)

- Freedom Screens of Australia sends two layouts: invoice/quote/proforma
  (`parseQtyDescPriceTotal`: QTY · DESCRIPTION · UNIT PRICE · TOTAL, no item
  codes) and component order forms titled "Zipline…" or "ZL2 Components"
  (`parseZiplineOrderForm`, one cell per line). Real samples are in
  `tests/checkin-parser.test.js`; a line is only read when qty × price
  reconciles to its total.
- Colour splits ("75 White 75 Black", "50 white /25 black") become one row
  per colour. Detached notes are re-attached by page position
  (`pages.items` from `extractPdfTextPerPage`); without positions (OCR) they
  are never guessed.
- Matching normalises supplier spellings to Master's (`normaliseForMatch`):
  White/Black → WHT/BLK, (L)/(R) → LEFT/RIGHT, "60A" → "60 A". MILL (default
  finish) and AB (both-sides marker) are never required. When several items
  fully fit, the one matching the most of the line's words wins; a tie (e.g.
  BLK vs WHT with no colour on the line) matches nothing. A shared part
  ("ZLS1 ZLS2 Magnet") accepts either family.

## Teach once, remember (Check-in)

- Table `supplier_item_aliases` (Supabase): a person's confirmed link from a
  supplier's own code (`match_kind = 'code'`, e.g. ZIP49) or wording
  (`'description'`, normalised by `aliasDescriptionKey`) to a Master item.
  Read by the site; written only by the `checkin` Edge Function, which calls
  `remember_supplier_aliases(jsonb)` (service_role only) AFTER
  `checkin_transaction` succeeds, so the stock logic is untouched. Forget =
  `{action: "forget_alias", id}` to the same Edge Function.
- The Edge Function source is kept in `supabase/functions/checkin/index.ts`;
  redeploy it from there (verify_jwt stays true).
- Lookup order in `buildCheckinRows`: exact Master code → remembered link
  (code, then wording; the current supplier decides when suppliers disagree)
  → matching rules → suggestions. Only person-resolved rows (`personResolved`)
  or re-confirmed remembered rows send `remember` at Confirm.
- `checkin_transaction` is executable by service_role only (locked
  2026-10-05). Two old unused overloads still exist (also locked); the
  Supabase connector times out on DROP, so remove them from the SQL editor.
