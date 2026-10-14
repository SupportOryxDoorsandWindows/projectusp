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
- Activity timeline (`activity.js`, tab "Activity"): who did each movement is
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

## UI layout (approved "Oryx Inventory — New UI Proposal", 12 pages)

- Shell: left sidebar (`.side`, `nav.side-nav`; Products / Stock / Admin,
  Dashboard and Reports are disabled "Soon" items) and a `.page-head` band
  (title, subtitle, action) + `.page-body` per view. Tabs are still
  `nav button[data-v]` → `#v-<name>`; `window.ORYX_SHOW_VIEW(name)` switches.
  The approved-UI CSS is the block at the end of `index.html`'s `<style>`.
- Master Inventory (pages 7 + 11): chips All / Out of stock / No cost /
  No photo / Low (hidden `#miFilter` holds the choice), 10 per page, Last
  change column (`loadLastChangeByItem`). The item panel is
  `item-timeline.js` (`window.ORYX_ITEM.open(item, {onAdjust})`): re-reads
  the item by id, then its `inventory_transactions` 6 at a time ("Show
  older"); "stock after" is worked back from the current stock
  (`withStockAfter`, tested in `tests/item-timeline.test.js`). Read-only;
  "Adjust stock" opens the same Adjust dialog.
- Check-out / Check-in: header stepper and the Check-in summary strip are a
  read-out (`updateFlowUi` in fp-pro.js, driven by a MutationObserver).
- User Management "Last active" comes from `admin_user_last_active()`
  (security definer, Admins only, reads auth.users.last_sign_in_at).
- Status badges are sentence case now ("Matched", "Unmatched", "Below zero,
  allowed"); the Check-in sweep baseline was refreshed for that (case only).

## Kanban replenishment (was "Minimum level")

- ONE rule, in `kanban.js` (`window.ORYX_KANBAN.kanbanState`, loaded from
  index.html before boot.js; tests in `tests/kanban.test.js`). Everything
  reads it: row colour, status badge, chips and Extract (fp-pro.js
  `kanbanOf`/`miStatus`/`inventoryStatus`) and the item panel
  (item-timeline.js). Never add a second copy of the rule.
- Kanban trigger level = `inventory_items.buffer_level` (same column and
  values as the old "Minimum level"; not renamed). Critical level =
  `inventory_items.critical_level` (added 2026-10-14, optional; check
  constraint: only with a trigger, > 0 and below it).
  No trigger -> "unset" (default row); stock > trigger -> "normal";
  critical set and stock <= critical -> "critical" (whole row #FEE2E2 /
  text #991B1B); else stock <= trigger -> "low" (#FEF3C7 / #92400E).
  No critical level = never critical (never invent one, e.g. "2").
  Stock = the stored `current_qty`; nothing is ordered, stock never changes.
- Badge order: Out of stock (stock <= 0) first, then Critical / Low stock,
  then No cost. So an out-of-stock item with no critical level is a yellow
  row with the "Out of stock" badge. Chips Normal / Low / Critical stock
  only appear when they have items (or are selected).
- Set in the item panel's Kanban box (Admins only):
  `set_item_kanban_levels(item_id, trigger, critical)` (security definer,
  `is_admin()`, logs each changed level to `item_minimum_log` with
  `level_kind` 'trigger' / 'critical'). Empty or 0 = none; "Remove both".
  Others see the numbers read-only. The older `set_item_minimum()` still
  exists (trigger only) but the site no longer calls it. No other way to
  write either column (no write policy on inventory_items), except a
  Check-in New item's optional trigger level. A save fires
  `oryx-item-changed`; fp-pro.js re-reads the list. The list also re-reads
  after Adjust and every time Master Inventory is opened (after Check-in /
  Check-out). It does not live-update from other people's changes.
  SQL: `supabase/sql/item_minimum_level.sql`, `supabase/sql/item_kanban_levels.sql`.

## Original PDFs kept with each transaction

- Confirm (Check-out and Check-in) sends the PDF with the lines as
  multipart/form-data: "payload" = the same JSON as before, "document" = the
  file (`confirmRequest` in fp-pro.js; no PDF / hand entry / over 25 MB =
  plain JSON as before). The Edge Function checks the file BEFORE the stock
  (PDF header, SHA-256 must equal `pdf_hash`) and keeps it only AFTER the
  stock function succeeded; failing to keep it never fails the stock -- the
  answer says `document: {saved: false, error}` and the done message offers
  "Try again" (`{action: "attach_document"}` with the same file).
- Storage: PRIVATE bucket `transaction-documents` (PDF only, 25 MB),
  `check-in/<sha256>.pdf` / `check-out/<sha256>.pdf`, never overwritten,
  never deleted automatically. Listed in table `transaction_documents`
  (document_hash = `inventory_transactions.source_document_hash`). Only the
  service_role (the two Edge Functions) writes; signed-in ACTIVE staff read
  (`is_active_staff()`), and open files through a 5-minute signed link.
  SQL: `supabase/sql/transaction_documents.sql`.
- Browser: `documents.js` (`window.ORYX_DOCS`): View PDF / Download in
  Activity, the item panel and Transaction History; "Attach the original
  PDF" on older transactions that only have the fingerprint -- the server
  accepts only the exact file (same SHA-256) a saved transaction was
  confirmed from.
- Before redeploying checkin/checkout run `node tests/edge/keep-pdf.js
  --deno <deno>` (runs the real function sources against a local stand-in).

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
- Header fields: Freedom's quotes/invoices store "Invoice No:" / "PO No:" /
  "Your Ref:" apart from their values in the text, so `parseCheckinHeader`
  first reads the value printed to the right of the label by page position
  (`headerFieldsFromPositions`, horizontal text only); the text rules are the
  fallback (OCR) and never take a date fragment, a street number or the
  label itself (Quote 47457 used to show invoice "19", PO "PO No").
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
