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
  Master Inventory with that Show choice. Product lines by the description's
  first word (ZLS1, ZLS2, SMB1, ZLX/IZLX, other). "Most used" = last 30 days,
  by number of jobs. "Running out soon" = stock / daily use over min(60 days,
  time since the first recorded movement); red <= 14 days, amber <= 30.
  "Recent activity" was left out on purpose (the Activity page has it).
- First page after sign-in (2026-10-29, user's request): the Dashboard
  (`class="on"` on `#navDashboard` / `#v-dashboard` in index.html, was Ask
  the bot); dashboard.js reads it at load if it is still the open view.
- Rows that open the item panel carry `data-mi-row`, or item-timeline.js's
  outside-click rule closes the panel as soon as it opens.
- Reading in pages of 1,000 (`.range`) must order by a unique column last
  (`.order("id")`): one Check-in / Check-out shares one `created_at` (up to
  181 lines), and without the tie-break a page edge can skip or repeat rows.

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
  width incl. gaps, Spare width (mm), Stock area (m²), Panel area (m²),
  Yield, Piece IDs), Cut IDs R001...; `verifyPlan` also flags a yield over
  100%. Also reads a piece list (Piece, Level, Ref, Location, Type,
  Width, Height, File row; IDs/rows kept; duplicates = error; the
  workbook's "Piece references" with a Rule column is read once).
  Real Etihad file at 20 mm: By level 573.73 m2 / 157 cuts, By location
  598.15 / 187. "Testing mode" banner + "Start a new test".
- Rolls (2026-10-29, user's request): results show a 5th tile "Rolls"
  (`rollCount`: with rolls on hand "used of entered", per width; without,
  full 50 m rolls needed). "Each roll" lists only rolls with cuts, then
  "+ n rolls not used (50.0 m each)". The Excel Rolls sheet keeps every roll.
  Results table + Excel got a "Roll no." column after Location (user's
  request; now 15 columns): the roll of that width the cut is placed on
  (`rollUse`: the rolls on hand, else full 50 m rolls).

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
