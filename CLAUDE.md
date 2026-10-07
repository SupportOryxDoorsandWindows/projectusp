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
- A third suggestion pass (`findSizeSuggestion`) covers the same product
  with sizes written differently: feet → metres ("9' x 100'" = 2.74 m wide,
  30.48 m roll) or a different roll size (25 m roll vs Master's 200 m). It
  needs every Master product word on the line OR size evidence (same width ±
  0.1 m, or roll lengths stated on both); "mm" sizes must be equal; no family,
  series, colour or side conflict; single best candidate. Never auto-applied.
- Roll conversion uses the invoice's OWN stated roll length when it has one
  (`invoiceRollLengthM`, also read from `row.source` on Edit): 8 × "25mtrs
  roll" = 200 m, never 8 × Master's 200 m roll. Master counts these in metres.
  Edit and "Use this item" start from the invoice's own roll count and
  per-roll price (`ciInvoiceQty`, `packageInfo.rollUnitCost`), so editing a
  converted row never converts it twice (250 m must not become 250 rolls).
- "3m wide" is a width, never a roll length (`withoutWidths`). A roll line
  with no stated length that becomes a **New item** gets a "Metres per roll"
  box (prefilled from `KNOWN_ROLL_LENGTHS_M`: Paw Lite = 30 m, per the stock
  team; Paw Lite is NOT the same item as PET MESH). Filled in, the stock is
  kept in metres (2 rolls × 30 m = 60 m, price ÷ 30 per metre) and "(30M)"
  is added to the new item's name so later invoices convert by themselves.
  An UNMATCHED roll line whose length is known (stated, or in
  `KNOWN_ROLL_LENGTHS_M`) is already shown in metres when the file is read
  (still unmatched; Edit / Use this item / New item restart from the kept
  roll count and per-roll price).
- Master sometimes keeps two supplier parts as one item, with the second
  code inside the name: 230031 "SMB1 Slide Bolt BLK-230033-SMB1 Slide Lock
  BLK", 230032 "…WHT-230034-…". An invoice line coded 230033/230034 is only
  offered that item as a "Possible match" (`findEmbeddedCodeSuggestion`),
  never auto-matched: whether a lock line adds to the bolt's count is the
  stock team's call.
- ZLS1 profiles have one Master row per bar length (2500 / 2900 / 5100 mm)
  under the same code, so anything that resolves a Check-in row must pick the
  exact length row by id, not just the code. The manual-entry and Edit
  pickers (`codePickerOptions`) list one option per length for such codes.
- Negative stock is allowed on Check-out (corrected by a later Check-in);
  the preview only has to show it. `applyCombinedStock` totals every line of
  the same Master row so duplicates still show the shortage.

## User permissions (sign-in, Delete)

- Everyone signs in (`boot.js` → `window.ORYX_AUTH`: shared Supabase client,
  `profile`, `canDelete()`, `isAdmin()`, `fnHeaders()` = the person's own token
  for Edge Functions, `requestDelete()` = dialog + server check). Admin screen:
  `admin.js` (tab "User Management"). Tables `user_profiles`,
  `delete_audit_log`, `admin_bootstrap_tokens`; functions `is_admin()`,
  `record_line_delete()` (authenticated; the ONLY way a line Delete happens),
  `admin_set_user_access()` (service_role; self/last-Admin guards). Edge
  Functions: `user-admin` (new), and `checkin`/`checkout` require an active
  staff account (`requireStaff`); sources in `supabase/functions/`.
- Invite/reset links (`?invite=` / `?reset=`) sign the browser in BEFORE a
  password exists: boot.js marks that (`oryx_password_pending` in
  localStorage) and only shows "Set your password" until it's saved, and
  asks first ("It's for me — continue" / "Stay signed in as me") when someone
  else is already signed in on that browser. Admins can Remove a person
  (`user-admin` `remove_user`: never yourself, never the last Admin).
- Activity timeline (`activity.js`, tab "Activity"; the user didn't want a
  per-item "Last change"/Timeline in Master Inventory): who did each movement is
  `inventory_transactions.performed_by(_name/_email)`, stamped by trigger
  `stamp_transaction_actor` from a transaction-local setting that the
  `checkin_transaction_by` / `checkout_transaction_by` wrappers (service_role)
  set before calling the UNCHANGED stock functions; the Edge Functions call
  the wrappers with the signed-in person. Rows before 2026-10-07 have no name
  ("Not recorded"). Account changes go to `account_activity_log` (written by
  `user-admin`, Admin-only read); deleted lines come from `delete_audit_log`.
- Every Delete on Check-in/Check-out lines goes through `requestDelete`; never
  remove a line without it. Restore is open to all and only logged.
- Testing from this sandbox: the egress proxy injects a privileged key into
  every request to *.supabase.co (even with no key), so live REST/RPC calls
  from here do NOT run as the signed-in user. Test the rules in SQL with
  `set local role authenticated` + `request.jwt.claims` (rolled back), and the
  screens against a stand-in backend (Playwright `page.route`).

## Checking a Check-in change (every time)

- A fix made for one invoice must behave the same on ALL sample invoices.
  After any Check-in change, run `tests/*.test.js` AND the browser sweep
  `tests/browser/checkin-sweep.js --pdfs <folder> --libs <folder> --baseline
  <file>` (usage at the top of the script). It reads every PDF, presses
  "Use this item" on every Possible match, and captures what Confirm would
  save (nothing is saved). Run it on the code before the change first
  (`--update`), then after: every difference must be one the change meant
  to make; explain each one to the user.
- The supplier PDFs are NOT committed (public repo); they are the user's
  uploads (Freedom AU quotes/PIs/order forms, Freedom India proforma).

## Item photos (Master Inventory)

- One photo per item code (all bar lengths share it), in `assets/items/`
  with a code → file map in `assets/items/index.json`. The first 178 came
  from the pictures placed in column F of the STOCK sheet of Renato's Sep 29
  stock file. Most are small (~80 px), so the viewer shows them at a fixed
  size. Codes without a photo show an empty box. The Check-out preview shows
  the same photos (`itemPhotoCell`); the Check-in preview shows them beside
  the matched item's name and on a "Possible match" (`itemPhotoButton`).

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
- Freedom Screens **India** sends a third layout, a proforma
  (`parseSlNoParticulars`: Sl No · Particulars · Rolls · Rate $USD · Per ·
  Amount; rates often without decimals; sizes in feet, e.g. 9' x 100'). Its
  packing charge is a bare "Packing 120", picked up by the last-resort rule
  at the end of `detectShippingCharge`.
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
