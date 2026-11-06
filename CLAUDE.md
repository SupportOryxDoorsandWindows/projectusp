# Notes for Claude

## Code layout (stock screens)

- The old `fp-pro.js` (6,376 lines) was split on 2026-10-14 into the
  `fp-*.js` files listed in `boot.js` `FP_FILES`, loaded in that order
  (async = false). The split was mechanical: every statement was moved
  unchanged; only names shared between files were rewired.
  `fp-core.js` (setup, PDF reading, Master Inventory matching rules),
  `fp-items-ui.js` (code pickers, item photos), `fp-checkout.js`,
  `fp-checkin-read.js` (state, OCR, currency, shipping),
  `fp-checkin-layouts.js` (fixed supplier layouts),
  `fp-checkin-fallbacks.js` (general readers + `parseCheckinDocument`),
  `fp-checkin-match.js` (remember, `buildCheckinRows`, costs, rates),
  `fp-checkin-screen.js` (Preview, Confirm, manual entry), `fp-reports.js`,
  `fp-inventory.js` (Master Inventory, Adjust, Extract), `fp-main.js`
  (`init`, starts everything).
- Sharing: each file is its own IIFE and ends with `Object.assign(FP, {...})`
  for the names other files use (`FP` = `window.ORYX_FP`). A later file
  takes them at its top (`const { a, b } = FP;`); an earlier file reads
  `FP.name` inside functions (only runs after all files loaded). A `let`
  that is reassigned must stay in one file (or become an `FP` property).
  When you add a cross-file use, add the name to the provider's
  `Object.assign` and to the user's `const {...} = FP`.
- Tests load the files through `tests/load-fp.js` (same order, without
  fp-main.js) and read `window.ORYX_FP`; a name a test needs must be in its
  file's `Object.assign`.

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
  `fp-core.js`) never auto-matches across a series-number difference
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
- 620001 IZLX Drawbar Mohair Holder, 220002 SMB1 Zip Track and 220003 SMB1
  Track Inner are each one 5100 mm bar row counted in pieces (2026-10-26).
  The job list gives them in metres ("2.63 m"), so Check-out takes off
  metres / 5.1 rounded UP to whole bars (`metresAsBars` in fp-core.js,
  `METRES_TO_BARS_CODES`). Only the codes in that list.
- Check-out bars without a usable item code (2026-10-27; they used to be
  dropped without a word). Stock team's answers, in `parseBars`:
  Smartscreen bars map by name (`SMB_BAR_CODES`: Housing 60/80 IS/OS =
  210025/210022/210031/210028, Drawbar 210016, Track Fixed - Pair 210010,
  Retainer - Pair 210007; "Pair" = the bars as printed). "310010/310013-..."
  = half IS + half OS (2 bars = 1 + 1); an odd count becomes two rows to check
  (`needsCheck`, never matched by themselves). Box Section 15x30 / 20x40
  (`BOX_SECTIONS_FROM_STOCK`) = Master code `10002-<size>`; while that item
  doesn't exist the row is unmatched with a note (`ifMissing`). Anything else
  without a code (SMB Roller Tube, other Box Section sizes) = unmatched row to
  Edit or Acknowledge. Matched rows show where they came from (`sourceNote`).
  Tests: tests/checkout-bars.test.js; browser comparison on 4 job lists.
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
- Reading is staff-only (2026-10-14, `supabase/sql/staff_only_read.sql`):
  every public table and the `drawings` bucket answer only
  `is_active_staff()`; anon gets nothing. Drawings use signed links
  (`signDrawingLinks` in boot.js, 12 h, renewed; an expired one re-signs on
  image error). A new table must get the same staff-only read policy. Not
  `department_files` / `department-files`: another Oryx app uses them
  without a sign-in.
- Testing from this sandbox: the egress proxy injects a privileged key into
  every request to *.supabase.co (even with no key), so live REST/RPC calls
  from here do NOT run as the signed-in user. Test the rules in SQL with
  `set local role authenticated` + `request.jwt.claims` (rolled back), and the
  screens against a stand-in backend (Playwright `page.route`).

## UI layout (approved "Oryx Inventory — New UI Proposal", 12 pages)

- Sidebar Stock order (2026-11-05, user's request + the Materials in Transit
  spec): Dashboard, Master Inventory, Materials in Transit, Check-in,
  Check-out, Delivery Notes, Activity, Reports (Soon).
- Shell: left sidebar (`.side`, `nav.side-nav`; Products / Stock / Admin,
  Reports is a disabled "Soon" item) and a `.page-head` band
  (title, subtitle, action) + `.page-body` per view. Tabs are still
  `nav button[data-v]` → `#v-<name>`; `window.ORYX_SHOW_VIEW(name)` switches.
  The approved-UI CSS is the block at the end of `index.html`'s `<style>`.
- Master Inventory (pages 7 + 11): a "Show" dropdown beside the search
  (`#miFilter`, filled by `drawFilter` with counts: All items; Stock:
  Normal / Low / Critical / Out of stock; Missing details: No cost / No
  photo; was a row of chips until 2026-10-14), 10 per page, Last
  change column (`loadLastChangeByItem`).
  List order: by item code, except L Angle / Box Section / Box / Flat Trim
  items, which go last (`sortForList`, user's request 2026-10-22;
  `tests/inventory-order.test.js`). The item panel is
  `item-timeline.js` (`window.ORYX_ITEM.open(item, {onAdjust})`): re-reads
  the item by id, then its `inventory_transactions` 6 at a time ("Show
  older"); "stock after" is worked back from the current stock
  (`withStockAfter`, tested in `tests/item-timeline.test.js`). Read-only;
  "Adjust stock" opens the same Adjust dialog.
- Sidebar hide/unhide (desktop only, 2026-10-15): the « button `#sideToggle`
  in `.side-brand` toggles `.shell.side-collapsed` (72px icon strip; names
  become hover tooltips, set from each button's text in app.js). Remembered
  per browser in localStorage `oryx_side_collapsed`. Phones keep the old
  menu (toggle hidden at <=900px). `#signOut` children have
  `pointer-events:none` because boot.js checks `e.target.id`.
- Check-out / Check-in: header stepper and the Check-in summary strip are a
  read-out (`updateFlowUi` in fp-main.js, driven by a MutationObserver).
- Both previews redraw the whole table (`ciRender` / Check-out render) on
  Edit, Save, Skip, Use this item, price look-ups...; the table's own scroll
  box (`.fp-scroll`) keeps its position across redraws (`keepListScroll` /
  `restoreListScroll` in fp-items-ui.js, 2026-10-23: it used to jump back
  to the top, so the row being edited went out of view).
- Check-in preview, USD / AUD document (2026-10-26, user's request: "the
  invoice is in USD"): a "Value (USD)" column after Landed unit cost
  (qty x landed unit cost, the invoice's own currency) and the invoice-currency
  total on the bottom bar. Not shown for an AED document. The table then has
  12 columns: CSS `.fp-checkin-table.has-orig` sets the widths/alignment, and
  the sweep reads Status as the cell before Action.
- User Management "Last active" comes from `admin_user_last_active()`
  (security definer, Admins only, reads auth.users.last_sign_in_at).
- Status badges are sentence case now ("Matched", "Unmatched", "Below zero,
  allowed"); the Check-in sweep baseline was refreshed for that (case only).

## Dashboard (2026-10-23, from the approved mock-up)

- `dashboard.js` (loaded by boot.js; view `#v-dashboard`, sidebar
  `#navDashboard`, no longer "Soon"). Read-only; re-reads every time it is
  opened. Figures come from `summarise()` (`window.ORYX_DASH_CORE`, tested in
  `tests/dashboard.test.js`): "Manual correction" lines (stock counts,
  Adjust) are never usage or deliveries. Tiles: stock value, out of stock,
  checked out / in in the last 30 days. Needs attention: Reorder (out of stock
  AND used), Kanban Critical / Low (same counts as Master Inventory's Show
  choices, via kanban.js), other out of stock, no cost, no photo; links open
  Master Inventory with that Show choice. "Stock value by inventory"
  (2026-11-03, user: "remove this and change it by Freedom and then Renson";
  was "by product line", `productLine` / `families` are still computed but
  no longer shown): `inventoryLines()` = one row per inventory -- Freedom
  for everyone; Renson only when renson.js set `window.ORYX_RENSON_DASH`
  (Admins + pilot; row labelled "pilot · Admins only"); total = rows shown.
  The top "Stock value" tile = Freedom + Renson total (2026-11-04, user's request; `#dbTotalTile`, sub-line "Freedom AED x · Renson AED y"; Freedom only when Renson is off). Dashboard re-reads on
  `oryx-renson-ready`. "Most used" = last 30 days,
  by number of jobs. "Running out soon" = stock / daily use over min(60 days,
  time since the first recorded movement); red <= 14 days, amber <= 30.
  "Recent activity" was left out on purpose (the Activity page has it).
- First page after sign-in (2026-10-29, user's request): the Dashboard
  (`class="on"` on `#navDashboard` / `#v-dashboard` in index.html, was Ask
  the bot); dashboard.js reads it at load if it is still the open view.
- Reload keeps the page (2026-10-29, user's request): app.js `showView`
  stores the page per tab in sessionStorage `oryx_view`; boot.js waits for
  every page script it added, then clicks that page's menu button (never a
  hidden/disabled one, so no Admin page for staff). Nothing stored = the
  Dashboard. Work in progress on a page (an uploaded file, a preview) is
  not kept. Test: `tests/browser/reload-keeps-page.js`.
- CACHE: index.html loads `boot.js?v=N`, `kanban.js?v=N`, `price-history.js?v=N`,
  `config.js?v=N` with a FIXED version (everything boot.js adds gets
  `?v=<Date.now()>`). After changing one of those four, bump its N in
  index.html, or browsers keep the old copy (the reload fix first reached
  nobody: boot.js stayed v=14, bumped to 15 on 2026-10-29).
- Rows that open the item panel carry `data-mi-row`, or item-timeline.js's
  outside-click rule closes the panel as soon as it opens.
- Reading in pages of 1,000 (`.range`) must order by a unique column last
  (`.order("id")`): one Check-in / Check-out shares one `created_at` (up to
  181 lines), and without the tie-break a page edge can skip or repeat rows.

## Check-out dates corrected (2026-11-03)

- A Check-out's date is `inventory_transactions.created_at` = when it was
  ENTERED (there is no production / completion date field). 10 job lists
  entered by Paulo Averil on 2 Nov 2026 (419 lines) were completed in
  October; at the owner's request their `created_at` was set to the
  completion date from the team's list (time of day kept, Dubai):
  26294 9 Oct, 26273 13 Oct, 26371 19 Oct, 25313 26 Oct, 26256 27 Oct,
  26397 29 Oct (last of 24/26/29), 26052 F1-5 + F1-7 29 Oct; no completion
  date -> printout date of the job list: 26399 22 Oct, 26391 7 Oct.
  `supabase/sql/checkout_dates_2026_11_03.sql` (applied live; undo at its
  end), every old/new time in table `transaction_date_corrections`
  (staff-only read). Freedom items md5 / value / transactions-without-date
  md5 / all other dates identical before and after. Test:
  `tests/sql/checkout-dates.test.sql` (local Postgres). The "FLYSCREEN
  STOCK OCT 14 (3).xlsx" sent first had NO dates (only 5 job columns).

## Monthly stock report, emailed on the 1st (2026-11-04)

- User's request ("automate the reports to be sent on the 1st of each
  month"; answers: transactions + summary, email, test recipient first =
  the owner's own Gmail, kept only in the live report_recipients table; Meena to be added later).
- Edge Function `supabase/functions/monthly-report` (deployed, verify_jwt
  OFF -- it checks every caller): `report.js` = pure part (period in Dubai
  time, `freedomLine` / `rensonLine`, `summarise`, `buildWorkbook` with
  xlsx-js-style: Summary / Freedom transactions / Renson transactions,
  `emailHtml`), tested by `tests/monthly-report.test.js` (XLSX_PATH for the
  workbook checks). `index.ts` reads the month's inventory_transactions +
  renson_transactions (not opening_import), keeps the file in PRIVATE bucket
  `monthly-reports` (staff read), logs every run in `monthly_reports`,
  emails active `report_recipients` (Admin-only read) through MICROSOFT 365
  (2026-11-04, user: "we are using outlook"; Resend was dropped): Microsoft
  Graph `POST /users/{sender}/sendMail` (`graphMessage` in report.js; kept
  in that mailbox's Sent Items), app-only token (client credentials,
  application permission Mail.Send, admin consent; restrict the app to the
  one mailbox with an Exchange ApplicationAccessPolicy). Secrets
  `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`; sender mailbox =
  `report_settings` key 'sender' (data, Admin-only read; not in this public
  repo). Without the secrets a "send" builds + keeps the file and logs
  "Microsoft 365 sending is not set up yet". Never writes stock.
- Callers: the scheduler (pg_cron job `monthly-stock-report`, `0 2 1 * *` =
  06:00 Dubai on the 1st, pg_net POST with header `x-report-token` = Vault
  secret `monthly_report_token`, checked by `monthly_report_token_ok()`,
  service_role only). Action "monthly" = previous month + records
  month-end values in `stock_value_snapshots` (next month's start value).
  The same token can ask "preview" (file only) / "send" + month -- used for
  tests from SQL (`select net.http_post(...)`, result in
  `net._http_response`). An active Admin's own token can do "preview" /
  "send" (never "monthly"). Wrong token = 403 (checked).
- SQL: `supabase/sql/monthly_report.sql` (applied live 2026-11-04: pg_cron +
  pg_net enabled, 4 tables incl. `report_settings`, bucket, Vault token, schedule, recipient, sender).
  Switch off: `select cron.unschedule('monthly-stock-report');`.
- First live preview (October 2026): 1,003 Freedom lines, 0 Renson, same
  figures as the hand-made October report. Start/end-of-month values say
  "not recorded" until the first scheduled run (1 Dec 2026 records
  November's end).

## Materials in Transit (2026-11-05, tab "Materials in Transit")

- From the owner's spec "Feature Development: Materials in Transit" + answers:
  cost of received goods = the supplier invoice through the NORMAL Check-in
  (unchanged); "Pending QC" = a status LABEL only (received goods are in
  stock at Check-in as before); POs live on this page (no separate Purchase
  Orders page); the owner's 3 sample PDFs were NOT loaded (staff enter POs).
- NEVER stock: transit quantities are not stock and nothing here writes
  inventory_* / renson_*. Pending = ordered - received - cancelled
  (generated column `qty_pending`).
- SQL `supabase/sql/materials_in_transit.sql` (no DROP; re-run safe): tables
  `transit_orders` (PO number unique by `po_key` = letters+digits upper, so
  "PO26-2106" = "po 26/2106"; supplier, `supplier_group` Freedom / Renson /
  Fusion / Other (from the name), `inventory` freedom|renson (Renson group ->
  renson), currency + `rate_to_aed`, expected date, payment tbc / unpaid /
  partially_paid / paid, delivery status ordered / in_transit /
  partially_received / pending_qc / completed / cancelled), `transit_lines`
  (code, description, optional link `freedom_item_id` (chosen: one code can
  be several bar lengths) / `renson_item_id` (by code), qty ordered /
  received / cancelled, unit price; received + cancelled <= ordered; same
  code+wording once per PO), `transit_receipts` + `transit_receipt_lines`
  (one delivery = one Check-in: `receive_key` unique, DN no. / date,
  `checkin_tx_ids` = that Check-in's own stock line ids), `transit_documents`
  (PRIVATE bucket `transit-documents`, `<order id>/<sha256>.<pdf|xlsx|xls>`,
  no update/delete), `transit_log` (audit, no FK: kept after a delete).
  Staff-only read (`transit_access()` = `is_active_staff()`); writes only via
  `transit_create_order` / `transit_update_order` (staff: dates, payment,
  status with rules: Completed only when nothing pending, Cancelled only via
  Admin, no going back to Ordered after a delivery) / `transit_receive`
  (staff) / `transit_add_document`, and Admin-only `transit_admin_change`
  (add / edit qty or price / remove a line without deliveries, reason
  required; an over-delivery = raise the ordered qty first) /
  `transit_cancel` / `transit_delete_order` (nothing received). Status after
  quantity changes: `transit_refresh_status`. Tested on local Postgres:
  `tests/sql/materials-in-transit.test.sql` (load order in its header).
- `transit_receive` checks the Check-in really happened: every id must be a
  `check_in` line of the PO's inventory entered by the same person (Admins:
  anyone's), not already linked to another delivery of this PO; qty <=
  pending; a retry with the same `receive_key` returns the first result and
  changes nothing.
- Browser `transit.js` (loaded by boot.js, v=18; pure part
  `window.ORYX_TRANSIT_CORE`, tests `tests/transit.test.js`): cards (value in
  transit AED = open POs' pending x price x rate, ordered / received /
  pending qty, open POs), supplier cards Freedom / Renson / Fusion / Other
  (click = filter), filters (supplier, PO, material, delivery / payment
  status, expected from-to, show completed), search, table with ONE ROW
  PER PO (2026-11-05, user: the line list was too long; `groupByPo`:
  quotation, materials pending of total, pending qty / value AED, payment,
  status, expected, last updated; sortable): a click opens its materials
  underneath, 10 per page (`pageOf`, Previous / Next); a search or Material
  filter shows only the POs with a matching line, already opened, with only
  those lines; "Open PO details" or a material row = the PO window (details, edit, materials,
  delivery history, documents, change history, Admin box). Its 3 dialogs
  are moved to <body> (they open from the Check-in page too).
- + New PO: typed, or "Read PO / quotation PDF" (pdf.js text via
  `FP.extractPdfText`; `parseHeader` / `parseLines` / `combineDocuments`:
  header from the PO, lines from the quote; a line is read only when qty x
  price = amount; layouts: Freedom Global "[code] desc ... qty Units USD
  price 0% USD amount", Freedom AU quote (pdf.js gives it right to left),
  left-to-right generic; lines total vs document total and PO quote ref vs
  quote number are checked; PDFs read earlier on the same form are read
  again with a new pick, so the PO and then its quotation can be chosen one
  after the other -- a PO that lists no materials says to add the quotation,
  2026-11-05 after the owner uploaded only PO26-2106), or "Import Excel list" (`parseSheetRows`:
  heading row with PO Number / Supplier / Material Code / Description / Qty
  / Unit / Unit Price / Currency / Expected delivery...; one PO at a time,
  POs already here left out). Always a preview; Save = `transit_create_order`,
  then the read files are kept as documents. USD/AUD/EUR rate fetched for
  the PO date (`FP.fetchCheckinExchangeRate`), editable. Real files: PO26-2107
  + SQ-00000388 = 12 lines, PO26-2106 + S00231 = 66 lines, both = the
  document total (`TRANSIT_DOCS_JSON` for the unit test; not committed;
  test figures are made up -- no supplier prices in this public repo).
- RECEIVE FROM TRANSIT: choose the PO, type what arrived (<= pending) + DN
  no. / date -> "Continue to Check-in" opens the normal Check-in page with a
  banner (`#trCiBanner`). After THAT Check-in is confirmed,
  fp-checkin-screen.js `ciConfirm` (Freedom) / renson.js (Renson) call
  `ORYX_TRANSIT.afterCheckin()` (only after the stock was saved; never
  throws; Check-in logic unchanged): it finds the Check-in's own stock lines
  (by document SHA-256, or typed by hand = the person's newest Check-in
  batch, one `created_at`) and calls `transit_receive`; failure = "Try
  again" (same key). No Receive waiting but the document's PO no. is an open
  PO = offered ("Update the PO from this Check-in"), never automatic. No PO
  involved = silent (Check-in screen exactly as before:
  `checkin/checkout-same-freedom.js` IDENTICAL old vs new).
- Monthly report (`monthly-report`): Summary gets "Materials in transit"
  (per open PO: supplier, PO / quotation highlighted, status, lines
  outstanding, value in transit AED; per supplier group; total; Pending QC
  note) + "Closing stock value (excluding materials in transit)", and a
  sheet "Materials in transit" (every line); the email states the total.
  `transitSummary` in report.js (tested in tests/monthly-report.test.js).
- Browser test: `tests/browser/transit-flow.js --node-modules <dir>
  [--docs <dir with the PO / quote PDFs>]` (stand-in backend; staff + Admin).

## Hidden items (not on the official stock list, 2026-10-30)

- `inventory_items.status = 'inactive'` AND `current_qty = 0` = hidden from
  Master Inventory (list, Show counts, Stock Value, Extract), the Dashboard and
  the Check-in/Check-out code pickers (`codePickerOptions`). Rows and history
  are kept (never deleted: 26 had movements; the FK forbids it). Check-in /
  Check-out matching still knows them (the unique code+length key would refuse
  a "New item" with the same code); one that gets stock shows up again.
- 21 hidden on 2026-10-30 from "FLYSCREEN STOCK OCT 14.xlsx" (user: "Hide
  them", "Keep the 21 newer items" -- the L Angle / Box Section / Flat Trim
  items added 21-27 Oct stay). Later the same day all 13 Box Section items
  were hidden too (user: "has no box section"), then the L Angle and 7 Flat
  Trim items ("also remove the flat trim and L angle"): 42 hidden in all.
  List + undo: `supabase/sql/hide_unlisted_items_2026_10_30.sql`.

## Renson inventory (pilot 2026-11-02, RELEASED to all staff 2026-11-03)

- RELEASED 2026-11-03 (owner's personal approval: "for renson make it live
  now"): `supabase/sql/renson_release.sql` (applied live; Freedom items /
  value / transactions / profiles / policies md5 identical before and
  after; undo `renson_release_rollback.sql`) sets `renson_access()` =
  `is_active_staff()` AND the flag, and adds `AND is_admin()` to the access
  check of `renson_set_levels` / `renson_import_stock` / `renson_reset_pilot`
  (taken from the live definitions, only that line changed). So, like
  Freedom: every active staff sees Renson and does Check-in / Check-out /
  Adjust; Kanban levels (read-only for staff, `#rnLvRead`), opening import
  and reset stay Admin-only. boot.js loads renson.js for everyone (boot.js
  v=17); "pilot / Admins only" labels removed; Activity and the Dashboard
  Renson row are shown to all staff. The flag still switches Renson off for
  everyone. Tested: `tests/sql/renson-release.test.sql` (after the workflow
  test), browser test sections 1 / 2b (regular user), Freedom Check-in /
  Check-out IDENTICAL old vs new. Notes below that say "Admins only" describe
  the pilot.
- User's rules (pilot): never change Freedom stock, codes, history,
  Check-in/Check-out or permissions.
- Data is kept APART from Freedom: tables `renson_items` (one row per code,
  `current_value` = stock x unit cost, generated), `renson_imports`,
  `renson_transactions` ('opening_import', 'check_out', 'check_in', 'adjustment'). SQL:
  `supabase/sql/renson_pilot.sql` (applied live 2026-11-02; Freedom
  fingerprint -- items md5, value, transactions, profiles, functions,
  policies -- identical before/after), undo `renson_pilot_rollback.sql`.
- ONE rule `renson_access()` = `is_admin()` AND feature flag
  `app_feature_flags.renson_pilot` on; it guards the read policies and the
  functions `renson_import_stock(jsonb)` (opening import, once; validates
  everything first) and `renson_reset_pilot('RESET RENSON')` (clears Renson
  tables only). No write policies. Switch OFF: `update app_feature_flags set
  enabled=false where key='renson_pilot'` (SQL Editor) -- everything Renson
  disappears and is refused; Freedom is not touched.
- Browser: `renson.js` (boot.js loads it ONLY for Admins; it shows nothing
  unless `renson_access()` is true). Master Inventory gets an "Inventory:
  Freedom / Renson (pilot)" dropdown (user: "add it to the master
  inventory"); Renson is drawn in `#rnBody` and the Freedom list is only
  hidden (`.rn-on`), never changed. Choice kept per tab
  (sessionStorage `oryx_mi_inventory`). Inventory (value, search) and Import
  (reads the STOCK sheet, review: totals vs the file's INVENTORY VALUE,
  warnings, then Confirm).
- Stock file "RENSON STOCK OCT 27.xlsx": 100 items (rows 3-102; the rest of
  the 10,881 rows are empty), 41 with stock, AED 161,171.60 = its own
  INVENTORY VALUE. Code = text before the first "-" (second code in
  brackets or after it, e.g. "1465-G6020837-..."), stock = dated column
  before "OPENING COST PER PROFILE". Blank count = 0 stock (user: import
  all 100).
- Renson CHECK-OUT (2026-11-02, from "24222-Paolo OPT LIST Rev. 02.pdf",
  same FP Pro layout as Freedom job lists): tab "Check-out" in the Renson
  box (NOT the Freedom Check-out page, which is untouched). Reads the PDF
  with fp-core's `extractPdfText` / `pdfFingerprint` (read-only reuse) and
  its own `readJobList` / `buildRensonCheckout` (ORYX_RENSON_CORE). User's
  answers: Renson bars have no code -> `RENSON_BARS` by description
  (100 IS = 25089, 100 OS = 24295, Fabric tube 68 = 26562, Drawbar = 14102,
  Side channel fixed - Pair = 11583, removable - Pair = 24282); a "Pair" bar
  = 2 stock bars; 2450 metres / 6 rounded UP = bars (`METRES_TO_BARS`);
  anything not a Renson item (910010 Patio Mesh = Freedom item, Box Sections,
  an unknown bar such as a 150 head box) is LEFT OUT and listed with the
  reason, never guessed; stock MAY go below zero (constraint dropped).
  Lines can be unticked. Server: `renson_checkout(jsonb)`
  (`supabase/sql/renson_checkout.sql`, applied live 2026-11-02, Freedom
  fingerprint identical): all or nothing, every code must be a Renson item,
  one Check-out per job list (SHA-256). Listed on the Activity page.
  Real file: 35 lines (22 fittings + 7 gaskets + 6 bar items), 8 left out,
  AED 10,664.86 at the opening costs.
- OPENING STOCK LIVE (2026-11-02, user: "use the stock data I provided"):
  the 100 items of RENSON STOCK OCT 27.xlsx were written directly (same
  values as the page's import; recorded as "Setup import (Claude, at the
  owner's request)", performed_by null). Checksum of code/alt/description/
  unit/qty/cost per row = the file's (md5 7b15e4be...). 41 with stock,
  AED 161,171.60. The workbook's CHECK IN / CHECK OUT / FREEDOM sheets are
  Freedom data copied into it -- NOT Renson; only STOCK is used.
- FULL WORKFLOW (2026-11-02, user: "the same workflow as Freedom ...
  operate separately"; `supabase/sql/renson_workflow.sql`, applied live,
  Freedom fingerprint identical; tested with
  `tests/sql/renson-workflow.test.sql`):
  - ONE "Inventory" dropdown (Freedom / Renson (pilot)) BESIDE THE SEARCH
    (2026-11-03, user: "just merge so it will be under Master Inventory as
    long as there is a dropdown beside search for Freedom, Renson, etc.").
    The sidebar submenu (`nav .rn-sub`) and the page-head dropdown are gone.
    The same `#rnInventory` element is moved by `placePick()`: first in
    Freedom's `.mi-toolbar` (before Show), or first in the Renson
    `.rn-tools` (top of `#rnBody` while loading / importing). Its listener
    is attached via `pick.querySelector("select")` (it is not in the page
    yet when mount() wires it). A new category = one more <option>.
  - Inventory: headline = Freedom's (`.mi-kpis`: "AED x stock value" + "n items in n codes"; the 5 tiles + import line were replaced 2026-11-02 at the user's request), Show filter (All / Normal / Low / Critical / Out of stock /
    No cost), Kanban row colours + badges via kanban.js (`rensonStatus`),
    Extract (.xlsx of the rows shown), row -> item panel (`#rnItemDlg`:
    stock / average cost / last bought, Adjust, Kanban levels, history).
  - Check-in: ONE shared Check-in page since 2026-11-02 (the Renson
    Check-in tab is gone). fp-checkin-screen.js `ciAnalyse`, right after the
    text is read: a Renson NV document (`isRensonDocument`: "Renson NV" /
    renson.be|eu / "Renson Logistics", spaces ignored -- the macOS-printed
    sample spaces out its footer) goes to `window.ORYX_RENSON_CHECKIN.open()`
    (renson.js, Admins + pilot) and Freedom's reading is skipped; without it
    (regular user / pilot off) the document is refused (fallback regex in
    fp-checkin-screen.js), nothing changed. Reader `readRensonDocument`
    (samples SUP_1 quotation 20120358, SUP_3 20159420, SUP_03 order conf.
    167012, SUP_04 179636, SUP_05 179607 -- all 5 read, every total = the
    document's "Total before VAT"): header values BEFORE labels, Overview
    (pos, code, [desc], qty, unit, net; a line split in two is joined),
    Detail (gross, "Product|Net price P EUR / 1 PC|ROL|M"); "Price service"
    / Pickup Fee lines = charges -> shipping. Stock qty `rensonStockQty`
    (user's answers): PC as is; CAR/ROL priced per PC = gross / price
    pieces (3 CAR 22034 = 3000 pcs); priced per ROL/CAR with "- N M" in the
    name = rolls x N m (2399 2 CAR = 4 rolls x 150 = 600 m); priced per M =
    metres; fabric "M" lines and rolls without a length are ASKED (typed),
    never guessed. Unit price = line NET (after discounts) / stock qty, in
    the document currency; rate fetched for the document date (editable);
    `renson_checkin` with document name + SHA-256 (once per document), a
    code not yet a Renson item = NEW item (description prefilled from the
    document, e.g. 20315 in SUP_1). Inputs drawn once, sums updated in place.
    Note: on SUP_3 code 1118 is "SITUO 5" but the stock file calls 1118
    "Situo 1" (and 1117 the other way) -- matched by code; told the user.
  - Adjust (`renson_adjust`): stock count / add (optional cost, averaged) /
    take out; reason required; type 'adjustment', quantity = signed change.
  - Kanban levels (`renson_set_levels`): same rule as Freedom (critical only
    with a trigger, below it); checked in the browser with KANBAN.parseLevels.
  - Check-out: ONE shared Check-out page for every stock category since
    2026-11-02 (user: "one Check-In module and one Check-Out module"; the
    Renson Check-out tab is gone). fp-checkout.js `analyse`: no
    `window.ORYX_RENSON_CHECKOUT` (regular user / pilot off) and
    `isRensonJobList(text)` (RENSON word or RENSON_/RENS_ bar codes) = the
    whole file is refused, nothing taken off. With it (Admin, pilot on):
    `split()` reads the Renson lines (buildRensonCheckout) and removes them
    from Freedom's rows (`splitRensonRows`: rows with a Renson code -- no code
    is in both inventories, checked 2026-11-02 -- and code-less bars whose
    description is in RENSON_BARS); the rest (e.g. 910010 Patio Mesh, Box
    Sections) stays Freedom exactly as Freedom handles it (user: "each line
    to its own stock"). Renson lines are drawn in `#fpRenson` (tick boxes).
    Confirm: Freedom part first (unchanged Edge Function call, skipped only
    when there are no Freedom lines), THEN `renson_checkout`; a Renson
    failure after a saved Freedom part says so with "Try again" (the Renson
    part is once per job list, so never taken twice). No Renson lines = the
    exact old path: `tests/browser/checkout-same-freedom.js` (made-up Freedom
    job list, Admin + regular user) gives IDENTICAL output on the old and new
    code. Delivery notes still follow a saved Freedom part as before.
    `renson_checkout` still accepts a Check-out without a document.
  - Check-in / hand Check-out boxes are drawn ONCE; typing only updates the
    worked-out cells (`updateCheckin` / `updateManualOut`). A full redraw on
    "change" replaced the box someone was clicking into and lost what they
    typed (found by the browser test).
- NO TABS (2026-11-02, user: "remove this and use the activity for the
  movement"): the Renson box is just the list; the import step shows only
  while there are no Renson items (opening stock is imported once; "Clear
  the Renson pilot data" went with the Import tab -- SQL `renson_reset_pilot`
  still exists). Renson movements are on the ACTIVITY page: renson.js sets
  `window.ORYX_RENSON_ACTIVITY.rows()` in `mount()` (Admin + pilot only) and
  fires `oryx-renson-ready`; activity.js `rensonEvents` turns them into
  "Renson check-in / check-out / adjustment" events (same kinds in/out/adj,
  so filters + today's counts include them; grouped by document_hash; no
  hash given to the event = no PDF links; opening import not listed).
  Regular users: no hook, no request, nothing shown.
- PHOTOS (2026-11-02, user: "add the picture to renson"): the in-cell
  pictures of column D "Picture" on the STOCK sheet (Excel richData:
  cell vm -> metadata -> rdrichvalue -> richValueRel -> xl/media) for 60
  codes, resized to <= 400 px, in `assets/renson/<code>.png` + `index.json`
  (apart from Freedom's assets/items/). renson.js `photoBtn` / `withPhoto`
  (Freedom's thumbnail classes + FP.openItemPhoto viewer, own
  `data-rn-photo` click listener in capture so a photo never opens the
  row): list, item panel, Check-out and Check-in Renson boxes. The file
  itself gives 2405 Spline and 22874 Steel bar the SAME picture.
- Freedom Check-in unchanged: `tests/browser/checkin-same-freedom.js`
  (made-up Freedom quote, Admin + regular user) gives IDENTICAL output on the
  old and new code. Dashboard: only the "Stock value by inventory" Renson row (Admins); Activity: Renson movements (Admins). Freedom's
  own Check-in/Check-out never read Renson tables.
- Tests: `tests/renson.test.js` (RENSON_XLSX + XLSX_PATH to include the
  real file), `tests/sql/renson-pilot.test.sql` (local Postgres),
  `tests/sql/renson-checkout.test.sql` (after the pilot test),
  `tests/sql/renson-workflow.test.sql` (after the Check-out test),
  `tests/browser/renson-pilot.js` (stand-in backend: regular user gets no
  script / no request, Admin import, `--job-pdf` Check-out, flag off, no
  Freedom writes; `--renson-docs <dir>` = shared Check-in with SUP_1 +
  SUP_03). Real files for the unit test: RENSON_JOB_TXT, RENSON_DOCS_TXT
  (pdf.js text, same joining as extractPdfText).

## Kanban replenishment (was "Minimum level")

- ONE rule, in `kanban.js` (`window.ORYX_KANBAN.kanbanState`, loaded from
  index.html before boot.js; tests in `tests/kanban.test.js`). Everything
  reads it: row colour, status badge, Show filter and Extract (fp-inventory.js
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
  row with the "Out of stock" badge. The Normal / Low / Critical stock
  options only appear when they have items (or are selected).
- Set in the item panel's Kanban box (Admins only):
  `set_item_kanban_levels(item_id, trigger, critical)` (security definer,
  `is_admin()`, logs each changed level to `item_minimum_log` with
  `level_kind` 'trigger' / 'critical'). Empty or 0 = none; "Remove both".
  Others see the numbers read-only. The older `set_item_minimum()` still
  exists (trigger only) but the site no longer calls it. No other way to
  write either column (no write policy on inventory_items), except a
  Check-in New item's optional trigger level. A save fires
  `oryx-item-changed`; fp-inventory.js re-reads the list. The list also re-reads
  after Adjust and every time Master Inventory is opened (after Check-in /
  Check-out). It does not live-update from other people's changes.
  SQL: `supabase/sql/item_minimum_level.sql`, `supabase/sql/item_kanban_levels.sql`.
- KANBAN EDITORS (2026-11-06, owner: "give anshad permission to edit the
  kanban"; answers "Kanban only", "Freedom and Renson"):
  `supabase/sql/kanban_editors.sql` adds `user_profiles.can_edit_kanban` and
  `can_edit_kanban()` (= active AND (Admin OR the flag)); the access check of
  `set_item_kanban_levels` and `renson_set_levels` is now `can_edit_kanban()`
  (only that line changed from the live definitions). Admins switch it per
  person in User Management (column "Kanban levels", `admin.js`) through
  `admin_set_kanban_editor(user, on)` (Admins only; logged to
  `account_activity_log` as 'kanban_access', shown on Activity). Browser:
  `ORYX_AUTH.canEditKanban()` (boot.js v=19) in item-timeline.js and
  renson.js. No other Admin power. Anshad Ellikkal switched on. Tests:
  `tests/sql/kanban-editors.test.sql` (after renson-release.test.sql; header
  says the stand-in columns to add), `tests/browser/kanban-editor.js`.

## What's New & Updates (bell, panel, history page, publishing)

- `updates.js` (loaded by boot.js after app.js; `window.ORYX_UPDATES`, pure
  helpers in `window.ORYX_UPDATES_CORE`, tested in `tests/updates.test.js`).
  The bell is created inside `.side-user` (fixed top-right on desktop, beside
  the avatar on mobile; `.page-head` got right padding for it), the panel is
  `#updPanel`, the history page is the view `#v-updates` (opened from "View
  all updates", no sidebar item), details and the Admin form are dialogs.
- It announces changes to the SYSTEM. It never reads or writes the Activity /
  audit tables, and those stay the record of what people did.
- Tables (`supabase/sql/system_updates.sql`): `system_updates` (Admins
  `is_admin()` create / edit / delete; active staff read only `published`;
  drafts are Admin-only) and `system_update_reads` (one row per person per
  update, unique; each person inserts / updates only their own rows, only
  for published updates). Trigger `system_updates_stamp` sets created_by /
  publisher / published_at / updated_at -- the browser never sends them; an
  edit keeps the publish date; back to draft clears it.
- Instant bell: `system_updates` is in the `supabase_realtime` publication
  (2026-10-14); updates.js `live()` subscribes to its postgres_changes with
  the person's own token (Realtime applies the SELECT policy per person;
  a DELETE only sends the row id) and re-reads the list. Back-up: re-read
  on tab focus (>1 min) and every 5 minutes. The sandbox blocks real
  websockets, so browser tests stub `realtime/v1/websocket`
  (`page.routeWebSocket`) -- otherwise the console logs a failed connection.
- Publishing needs the "This change is already live for everyone" tick
  (`validateForm`): announce only what is deployed. The publisher's own new
  update is marked read for them.
- Database rules are tested on a LOCAL Postgres (never the live project):
  `tests/sql/supabase-base.sql` + the SQL file + `tests/sql/system-updates.test.sql`.
  The Supabase connector times out on SQL that catches errors (exception
  blocks), so don't test refusals through it.
- Details are FORMATTED (2026-11-05, owner: "put a proper design for the
  writing"): `formatDetails` turns the plain text into headings (short line
  before a list, ALL CAPS line, "Step N – title (note)" = step badge),
  numbered steps ("1. "), bullets ("• " / "- "), indented notes under a
  step (✔ / ✘ coloured), "quoted words" = screen labels. Escaped first.
- POP-UP when the app is opened (2026-11-05, owner: "once they open the
  application the new update ... will pop"): after the FIRST load only,
  `popNew` opens the published, unread updates of the last 14 days
  (`popupQueue`, oldest first; "1 of 2", Next update / Got it; each shown
  one is marked read as it opens). Never while another dialog is open; never
  twice in the same tab (sessionStorage `oryx_updates_popped`); a realtime
  publish does not pop it for people already working. Test:
  `tests/browser/updates-popup.js`.
- The 4 sample updates from the request are TEST DATA (stand-in tests only);
  never insert them into the live table without the user's say-so.

## Original PDFs kept with each transaction

- Confirm (Check-out and Check-in) sends the PDF with the lines as
  multipart/form-data: "payload" = the same JSON as before, "document" = the
  file (`confirmRequest` in fp-core.js; no PDF / hand entry / over 25 MB =
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

## Delivery notes (2026-10-27, tab "Delivery Notes")

- `delivery-notes.js` (loaded by boot.js; view `#v-delivery-notes`, sidebar
  `#navDeliveryNotes`; pure parts `window.ORYX_DN_CORE`, tested in
  `tests/delivery-notes.test.js`). SQL: `supabase/sql/delivery_notes.sql`
  (tables `delivery_notes`, `delivery_note_history`,
  `delivery_note_correctors`; staff-only read; written ONLY through
  `prepare_delivery_notes` / `save_delivery_note` / `confirm_delivery_note` /
  `correct_delivery_note` / `set_delivery_note_corrector`), tested on local
  Postgres with `tests/sql/delivery-notes.test.sql`.
- Never touches the stock: fp-checkout.js calls `ORYX_DN.afterCheckout()`
  only after its Check-out was saved (PDF Check-outs only); the server only
  accepts a job list whose SHA-256 is on a saved Check-out, one note of each
  kind per job list. A failure shows "Try again"; "Prepare from a job list"
  on the page does the same for older Check-outs.
- Powder coating note = one line per part type from FP Pro's own bar "Code:"
  (`barGroup`: 60-IS/ZLX_80-OS/SMB_60-IS/"70" = HOUSING, RECIEVER, DRAWBAR,
  TOP/BOTTOM_TRACK + SMB track pairs = TRACK, RECESS_CHANNEL, TRACK_FILLER
  (630148), 15X30... = BOX SECTION; MAGNET/ROLLER/MOHAIR not coated; anything
  else "not recognised" = flagged, never guessed) + COMPONENTS = pieces of the
  accessories on Freedom's coating list (`COAT_PCS`). Job lists carry no RAL
  code: it is typed, and the note stays "Needs review" without it.
  Finished goods = one line per "Items list" screen (Location + product +
  size, qty), Box Section sizes in Comments (like DN-5470).
- Confirm checks RAL (coating) / address / driver / date / lines and gives the
  DN number from its OWN series `DN-SF-0001` (the current program's DN numbers
  are still in use; Renato to decide on one series). Confirmed = locked;
  only Admins + `delivery_note_correctors` correct (reason required, the
  version before kept in `delivery_note_history.before`).
- Browser test: `tests/browser/delivery-notes-flow.js` (stand-in backend; also
  prints the Check-out payload so a run on the old code proves the stock lines
  are identical).
- Admin TEST mode (2026-10-28, `supabase/sql/delivery_notes_test_mode.sql`,
  run after delivery_notes.sql; it replaces prepare/save/confirm/correct):
  "Test with a job list" (`#dnTestFile`, Admins only) calls
  `prepare_delivery_test_notes` -- ANY job list, no Check-out, no stock.
  `is_test` notes: TEST-0001 series (`delivery_note_test_number_seq`), read
  policy hides them (and their history) from non-Admins, only Admins act on
  them (`dn_check_access`), `delete_test_delivery_note` deletes ONLY test
  notes. A test note is filed under SHA-256 of "test:" + the job list's
  fingerprint (`dn_insert_notes`; the page computes the same to find it), so
  testing a job list never blocks its real notes and nothing in
  delivery_notes.sql is dropped (a DROP makes the Supabase connector ask a
  confirmation question that did not reach the user, 2026-10-28). They show only under the "Test notes" filter and the
  printed note says "TEST – NOT A REAL DELIVERY NOTE". Tests:
  `tests/sql/delivery-notes-test-mode.test.sql` (after the real-notes SQL test),
  `tests/browser/delivery-notes-test-mode.js`.

## Film Cutting (2026-10-28, tab "Film Cutting"; ALL active staff since 2026-10-29)

- OPEN TO ALL STAFF (2026-10-29, user's choice "Open to all staff"):
  `supabase/sql/film_cutting_open_to_staff.sql` sets the one rule
  `film_cut_access()` = `is_active_staff()` (was `is_admin()`; the file
  says how to go back); the page shows the menu item to every active
  account (`canUse`), "Admins only" badge and "Testing mode" banner removed.
  Tested: `tests/sql/film-cutting-open-to-staff.test.sql` (after the
  Admin-only SQL test), browser flow (staff sees + calculates). Older
  notes below that say "Admins only" describe the first version.
- ORIGINAL EXCEL KEPT (2026-10-29, user's request): `supabase/sql/film_cutting_files.sql`
  (run after the two above): PRIVATE bucket `film-cut-files` (Excel only,
  10 MB), file = `<sha256>.<xlsx|xlsm|xls>` (= `source_file_hash`); storage
  policies: read + insert for `film_cut_access()`, insert only under that
  name pattern, NO update/delete (never replaced, never deleted from the
  site). Column `film_cut_plans.source_file_path`, set by the replaced
  `approve_film_cut_plan()` only if the object exists and matches the hash
  (else `file_not_stored`). Browser (`keepFile`): uploads the File before
  Approve (already there = kept); a failed upload never blocks the approval
  (message says the file was not kept). "Approved plans" has an "Original
  file" Download (5-minute signed link, `downloadOriginal`). Tests:
  `tests/sql/storage-base.sql` (stand-in storage schema) +
  `tests/sql/film-cutting-files.test.sql`; browser flow (Playwright can't
  see upload bytes, so it checks the form headers instead).

- `film-cutting.js` (loaded by boot.js; view `#v-film-cutting`, sidebar
  `#navFilmCutting` under its own sidebar heading "Optimization" above
  Stock (2026-10-29; heading hidden with the button), hidden unless `isAdmin()`; a
  non-Admin who opens the view gets "Admins only" and no requests). Pure
  parts `window.ORYX_CUT_CORE`, tested in `tests/film-cutting.test.js`
  (calculation tests need `HIGHS_PATH=<node_modules/highs>`, else skipped).
  Smart film (not mesh): job list = Excel like "SSF2026-225 ER AUH1.xlsx"
  (Ref #, Location, unlabeled type column, Width, Height, Qty, LEVEL rows;
  rows above the first LEVEL row are named after the level before it, with a
  CHECK). Never touches stock; the upload is never changed.
- Rules confirmed by the team 2026-10-28: 1 mm blade between panels, no edge
  trim, rolls 1000/1200/1500/1800 x 50 m, only the same height shares a cut,
  panels never turned, least film then fewest cuts, default By level,
  production order 1000 -> 1200 -> 1800 -> 1500, heights as in the file
  (2680), stay within the rolls on hand; a cut never runs across two rolls
  (still to confirm: are short roll ends used / kept?).
- Maths: exact integer programming with HiGHS (highs-js 1.15.3, MIT, from
  jsDelivr, run in a Web Worker; script + wasm fetched by the page and
  handed over via `instantiateWasm`). Per (scope group, height): "full"
  patterns + covering. Rolls on hand: if the free plan doesn't go on the
  rolls, one model for all groups with per-roll capacity (y = cuts of one
  height on one roll), film only, 60 s limit; not proven -> says so with the
  LP floor ("at most x m2 above the best possible"). `verifyPlan` re-checks
  every plan before it is shown. Real file: By level 566.762 m2 / 154 cuts,
  Whole job 557.180 / 138 (~25 s), By location 591.717 / 187, Level 5
  218.933 / 64; both order blocks (4x1000, 2x1200, 2x1500, 2x1800 rolls)
  589.84 m2, not proven, <= 2.22 m2 above best; one block = not enough film.
  GLPK was tried first and was far weaker on the rolls-on-hand case.
- SQL `supabase/sql/film_cutting.sql` (+ `film_cutting_rollback.sql`):
  `film_cut_plans` (approved plans, version per job), `film_cut_log`
  (imported / calculated / approved / exported). ONE access rule
  `film_cut_access()` (= `is_admin()`) for both read policies and the
  functions `approve_film_cut_plan(jsonb)` / `log_film_cut(...)`; no write
  policies. Tested on local Postgres: `tests/sql/film-cutting.test.sql`.
- Excel export (new file, xlsx-js-style): Summary (status, settings,
  formulas, checks), Cut list, Piece references (every panel once, with its
  cut), Production batches, Rolls. Draft exports say DRAFT / NOT APPROVED.
- Phase 2 (production sequence, installation release) not built: only once
  those rules are agreed.
- Browser test: `tests/browser/film-cutting-flow.js --libs <folder>` (stand-in
  backend; writes a made-up job list unless `--xlsx`).
- WIDTH ALLOWANCE (2026-10-29, "Feature_Development_Prompt.docx" + the
  user's answers): used width = sum of panel widths + ONE allowance per cut
  (default 30 mm since 2026-10-29 -- "for each film 30mm", confirmed per
  CUT, not per panel; was 20 mm; editable, `checkAllowance`: >= 0, whole mm or one
  decimal, <= 500). It REPLACES the 1 mm blade (no gap added) and applies
  to every cut, also a single panel (1000 + 20 -> 1200 roll). Roll widths
  fixed `ROLLS` = 1000/1200/1500/1800; smallest that fits; a panel with
  width + allowance > 1800 is listed as not cut. Cut length stays the
  height in the file (2680; the prompt's 2660 sample row is layout only).
  Each cut keeps `allowance` / `used` / `spare` (per-cut allowance possible
  later). Results = the 14 columns in order (Cut ID, Level, Ref #,
  Location, Stock width (mm), Cut length (mm), Pieces, Pattern (mm), Used
  width incl. gaps, Offcut width (mm) (was "Spare width", renamed 2026-10-29), Stock area (m²), Panel area (m²),
  Utilization (was "Yield", renamed 2026-10-29), Piece IDs), Cut IDs R001...; `verifyPlan` also flags a yield over
  100%. Also reads a piece list (Piece, Level, Ref, Location, Type,
  Width, Height, File row; IDs/rows kept; duplicates = error; the
  workbook's "Piece references" with a Rule column is read once).
  Real Etihad file at 20 mm: By level 573.73 m2 / 157 cuts, By location
  598.15 / 187. "Testing mode" banner + "Start a new test".
- WORK KEPT ACROSS A RELOAD (2026-10-29, user's request): the unfinished
  work (the uploaded File itself, step, settings, rolls on hand, note, last
  result + approval) is saved in IndexedDB `oryx-film-cut` / store `work` /
  key `current` after every render and input (`saveWorkSoon`), with the
  signed-in user's id; `restoreWork` at start reloads it only for the same
  person and within 14 days, re-reads the file and shows a kept result only
  if `verifyPlan` still passes. "Start a new test" clears it. Browser only
  (nothing sent to the server). Test: `tests/browser/reload-keeps-page.js`.
- Rolls (2026-10-29, user's request): results show a 5th tile "Rolls"
  (`rollCount`: with rolls on hand "used of entered", per width; without,
  full 50 m rolls needed). "Each roll" lists only rolls with cuts, then
  "+ n rolls not used (50.0 m each)". The Excel Rolls sheet keeps every roll.
  Results table + Excel got a "Roll no." column after Location (user's
  request; now 15 columns): the roll of that width the cut is placed on
  (`rollUse`: the rolls on hand, else full 50 m rolls).
  "Allowance (mm)" column after "Pattern (mm)" (2026-10-29, user's request;
  now 16 columns): Pattern shows only the panel widths ("950 + 830").
- LEVEL BATCHES (2026-10-29, user's answers): `levelBatches(result, 10)` =
  cuts grouped by level (a cut's level; several = "Mixed levels", last),
  then ONE roll width per batch in production order, at most 10 CUTS per
  batch (15 -> 10 + 5); numbering restarts per level ("Level 5 · B1").
  Shown as a "Level batch" column after Level (now 17 columns) and a
  "Level batches" table; Excel: same column, a "Level batches" sheet, and
  "Level batch" in Piece references. The roll-width "Production batches"
  table/column stays (user: keep both). Cut order/IDs unchanged.

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

- `detectDocumentCurrencyInfo` in `fp-checkin-read.js`: a written code or code-marked
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
- "Shipping Crate" line = the shipment's crate charge (2026-11-03, owner's
  decision after S00155 went in without its USD 900 crate): a CODE-LESS line
  that STARTS with "Shipping Crate" / "Crate" / "Crating" is taken as the
  shipping amount even though it has a tax column (`CRATE_CHARGE_RE` in
  fp-checkin-read.js, `crate: true` on the result) and its goods row is
  removed (`isCrateChargeEntry`, fp-checkin-screen.js), so it is spread over
  the lines like freight. Before, it was an unmatched row to skip and the
  cost was lost. Compared old vs new on S00155 (real PDF, live Master list via
  `checkin-same-freedom.js --items`): only difference = USD 900 shipping on
  the same 29 lines; a made-up Freedom quote IDENTICAL.
- S00155 crate cost added afterwards (2026-11-03, owner: "Add it to current
  cost"): `supabase/sql/s00155_crate_cost_2026_11_03.sql` (applied live)
  raised the average cost of the 29 items by share / (stock before + qty
  received), share = USD 900 / 29 lines x 3.6725 = AED 113.97 per line,
  "stock before" by ENTRY time (`transaction_date_corrections`), which
  reproduces every stored average exactly. Stock value +AED 3,197.85
  (782,325.52 -> 785,523.37); the rest (~AED 107) belonged to stock already
  checked out, whose values stay. S00155 lines / all transactions / quantities
  unchanged. Log + undo: table `item_cost_corrections` (staff-only read).
  Test: `tests/sql/s00155-crate-cost.test.sql`.
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

## Purchase price history (Check-in, item panel)

- The price paid is kept per line in `inventory_transactions`
  (`unit_cost_used` = stored AED incl. shipping, `original_unit_cost` +
  `original_currency` = supplier price). No extra table.
- Weighted average cost (`supabase/sql/checkin_weighted_average.sql`, user's
  request 2026-10-19): a Check-in of an existing item sets `unit_cost` =
  (stock x old cost + received x price paid) / (stock + received);
  `current_value` follows; Check-out already uses `unit_cost`. No stock (<= 0)
  or no cost on file = the price paid. No document price = the item's own
  cost (average unchanged); a stock count books at the item's own cost, so it
  never moves it. Each line keeps `unit_cost_before` / `unit_cost_after`
  (null on older lines). Tested on local Postgres:
  `tests/sql/inventory-base.sql` + the SQL file +
  `tests/sql/checkin-weighted-average.test.sql`. Approved by Mousa and
  applied 2026-10-20 (before that a Check-in left `unit_cost` unchanged).
  GO BACK: `supabase/sql/checkin_weighted_average_rollback.sql` = the exact
  previous live function (same md5 as live before the change); it does not
  undo costs already averaged (`unit_cost_before` on each line has them).
- `price-history.js` (`window.ORYX_PRICES`, loaded from index.html before
  boot.js; tests in `tests/price-history.test.js`) reads those lines as a
  history. A purchase = `check_in`, document price present, supplier not
  "Manual correction". Compared in the supplier's currency when it matches
  last time (exact), else in AED (changes under 0.5% count as the same).
  Different units are never compared.
- Check-in preview: under each matched line, "Last bought at …" with a
  "Price up / down n%" badge (`ciPriceNote` in fp-checkin-screen.js); no
  earlier purchase = compared with the Master cost. Kept in the description
  cell so the sweep's captured columns don't change. Item panel: "Purchase
  prices" list (last 50) above the timeline. Display only; nothing is written.
- Item panel top box (2026-10-19, asked for "here", under the Unit cost box):
  `costBox` in item-timeline.js labels it "Average cost" once any line has
  `unit_cost_after` (else "Unit cost") and adds "Last bought AED x · date".
  Reset at the start of `loadPrices`, not in `setKpis` (that also runs when
  the item is re-read and would race the price lookup).
- Export (2026-10-19): `price-export.js` (`window.ORYX_PRICE_EXPORT`, loaded
  by boot.js). Master Inventory → Transaction History "💲 Purchase prices"
  (`#miPriceBtn`) opens a window (item / from / to / supplier / Excel or PDF);
  the item panel's list has "⬇ Excel" / "🖨 PDF" for one item. Rows come from
  `purchaseReport` / `latestPerItem` in price-history.js (same purchase rule;
  the change is worked out over the item's whole history BEFORE the filters).
  Dates (window filter, "Checked in" column) are the CHECK-IN day
  (`purchaseDay` = created_at), not the invoice date (`invoiceDay`, its own
  column): the one real purchase is a 2024 India proforma checked in on
  28 Sep 2026, and a "from 2026" filter found nothing (fixed 2026-10-20).
  Excel = 2 sheets ("All purchases", "Latest price per item"); PDF = a page
  printed from a hidden iframe (the browser's "Save as PDF"; a new window
  would be blocked because the data arrives after the click). All staff;
  read-only. Prices before this system (e.g. the Zoho Check-In report) are NOT
  loaded -- only with the user's say-so.

## Monthly opening / closing stock (Freedom, 2026-11-04)

- Owner's rule: November 2026 opening = "Opening Count" / "Total opening
  cost" of FLYSCREEN STOCK OCT 14.xlsx (unit cost = "OPENING COST PER
  PROFILE"); closing = opening + check-ins - check-outs (= `current_qty`),
  closing value = closing qty x unit cost (check-ins still re-average);
  every later month opens with last month's closing.
- Set live 2026-11-04: movement history cleared to the 11 documents of the
  owner's "Transaction_Summary_.xlsx" (10 job-list Check-outs, AED 29,657.01
  + Check-in S00155, AED 162,782.93; 448 lines kept, 744 deleted), then each
  of the 249 file lines' item got opening = file, and stock/cost replayed
  through the kept lines with the live averaging rule: opening AED
  649,199.86, stock AED 783,163.88, none below zero. Items not in the file
  (42 hidden, all 0) kept their figures. File 310022 Drawbar 5.8 m = the
  5100 mm row (no 5800 row); "630063 ZLX" = 630063, "PET MESH" = Pet Mesh.
  Saved PDFs (11) and the 20 real delivery notes all belong to kept
  documents; the 419 date corrections too. Full copies before:
  `backup.inventory_transactions_2026_11_04`, `backup.inventory_items_2026_11_04`
  (schema `backup`, not exposed to the API).
- `supabase/sql/monthly_opening_closing.sql`: `stock_month_balances` (one row
  per item per month, staff-only read, no write policy) and
  `roll_stock_month(date)` (service only): closes last month (closing qty /
  value / cost), opens the month with them and copies them into
  `inventory_items.opening_qty/opening_value`; runs once per month (a month
  already open is left alone). pg_cron `roll-stock-month` daily 20:05 UTC
  (00:05 Dubai), acts only on the 1st. Check-in / Check-out unchanged.
  Checked with a rolled-back run for 1 Dec: Nov closing = Dec opening =
  AED 783,163.88. No screen shows the month table yet.
