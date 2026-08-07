# Oryx Product Selector

A technical assistant for the doors, windows and shading range. It answers product
questions and tells you whether a given opening can be built in a given system —
and what to use instead when it cannot.

Hosted on GitHub Pages, with the product data in Supabase behind a staff sign-in.

Built from two sources:

- `Copy of Slider USP.xlsx` — sash limits, glass, configurations, tracks,
  thresholds, drainage, sightlines, automation and locking, plus 170 in-cell
  technical drawings.
- The Series 1 engineering review — frame depth, visible dimensions, interlock,
  threshold appearance and the hardware reasoning.

## How it is hosted

| Layer | Where |
|---|---|
| App — HTML, CSS, JS, logo | GitHub Pages, free, from a public repository |
| Product data — specs, engineering notes, glossary | Supabase Postgres, read-only, staff sign-in required |
| 170 technical drawings | Supabase Storage, private bucket, signed URLs |
| Sign-in | Supabase Auth, email and password |

**Nothing product-related is in this repository.** The public repo holds only the
interface. Every sash limit, engineering note and drawing sits in Supabase behind
authentication, protected by Row Level Security. Someone who finds the URL sees a
sign-in screen and nothing else.

`config.js` contains the Supabase URL and the *publishable* key. That is safe to
commit — it grants only what Row Level Security allows, and every table restricts
reads to signed-in users. The `service_role` key must never go in this repo.

## Running it locally

```bash
python3 serve.py
```

Then open http://localhost:8731 and sign in. Stop the server with Ctrl-C.

It needs a server rather than opening `index.html` directly, because the browser
blocks the Supabase requests from a `file://` page.

## Staff accounts

There is no self-signup, deliberately. Create accounts in the Supabase dashboard:

**Authentication → Users → Add user** — enter the work email, set a password, and
tick *Auto Confirm User*.

To remove someone's access, delete their user in the same place.

## What it does

**Ask the bot.** Plain-language questions. Give it a size and it works out the
panel count and ranks the systems that fit:

> *"I have a 4200 x 2700 opening — what do you recommend?"*
> Series 2, Series 3 (640) and HY40 all work at 2 panels of 2,100 × 2,700 mm.

> *"Will Series 1 work for 3000 x 2600?"*
> Suitable at 2 panels of 1,500 × 2,600 mm.

It also answers specification questions — thresholds, drainage, sightlines,
glass, hardware, configurations — and cross-range questions such as
*"which systems have automation?"* or *"what is the tallest system?"*

**Opening checker.** The same engine as a form, with filters for family,
threshold, automation and maximum panel count. Shows every system that fits and
why each of the others does not.

**Systems.** Full record for each system, including the technical drawings.
Click any drawing to enlarge it.

**Comparison.** The whole range in one table.

## The rules it applies

For an opening of W × H, for each panel count the system allows:

- panel width = W ÷ panels, panel height = H
- the panel must be within the maximum (and minimum) sash width and height
- the panel must be within the maximum sash area where one is stated
- height is a hard gate — an opening cannot be split vertically

The lowest panel count that passes wins, because fewer panels means larger glass
and a cleaner elevation. Operable systems rank above fixed ones.

Panel sizes are the nominal equal division of the opening. Frame, interlock and
installation allowances are not deducted — the technical team confirms final
sizes. Casement systems are checked as a single sash; coupled and mullioned
frames are sized by the technical team.

## Accuracy

Every answer comes from the stored data. Nothing is generated. If a question is
not covered, the bot says so and points to the technical team rather than
guessing.

A blank option in the spreadsheet is reported as **not recorded**, which is not
the same as **not available**. An explicit "N/A" is reported as not available.
Drainage is currently blank for Series 1, 2, 3 and HY40 — worth filling in.

## Updating the data

Two steps: build from the spreadsheet, then push to Supabase.

```bash
python3 build_kb.py "/path/to/Copy of Slider USP.xlsx"
```

```bash
export SUPABASE_URL="https://ylhdsvwzqcshffwohhfy.supabase.co"
export SUPABASE_SERVICE_KEY="<service_role key>"
python3 push_to_supabase.py
```

The first command rewrites `data/kb.json` and re-extracts every drawing into
`data/img/` — both stay on your machine and are git-ignored. The second replaces
the Supabase tables and uploads the drawings. It is safe to run repeatedly.

Pass `data` or `images` as an argument to push only one half:
`python3 push_to_supabase.py images`.

Get the `service_role` key from **Project Settings → API keys**. Keep it out of
the repository — it bypasses Row Level Security.

To add engineering detail for another system, edit the `ENGINEERING` block near
the bottom of `build_kb.py` — key it on the system id (`series-2`, `hy40`, …)
and rebuild. Series 1 is there as the worked example. New terms go in
`GLOSSARY` in the same file.

## Branding

The interface follows the Oryx AI Knowledge Hub design system
(`AI Knowledge Hub/docs/design-system.md`):

- **Fonts** — Archivo for anything structural or clickable, Inter for sentences,
  loaded from Google Fonts exactly as the Hub loads them.
- **Tokens** — the recommended set from §3, so no raw hexes are scattered
  through the CSS. The spacing scale §9 asks for (`--space-1` … `--space-8`) is
  defined up front.
- **Shadows** — every one is tinted with brand blue `rgba(2,42,58,…)`, never
  plain black.
- **Light ground only.** No dark mode, per §9 — the brand blue is used as an
  accent on the header, not as an alternative theme.
- **Logo** — `assets/logos/oryx-logo-white.png` at 52px in the header, on the
  brand blue ground, matching the Hub. The favicon comes from the same folder.

Three decisions worth knowing about:

1. **Gold is used sparingly.** The palette reserves `--accent` gold for AI
   features and highlighted figures, so it appears on the **Ask** button (the
   bot is the AI feature) and on the panel-count badge (the figure that matters
   most in a result). Family labels use a neutral pill instead.
2. **There is no green in the palette.** "Suitable" therefore uses brand blue
   rather than an invented success colour; "not suitable" uses the existing
   danger tokens.
3. **Fonts need internet** on first load, as in the Hub. Offline, the page falls
   back to the system sans-serif and everything else still works. Self-host the
   two families if the tool needs to run on a disconnected machine.

## Files

| File | Purpose |
|---|---|
| `index.html` | Interface, sign-in gate, and the full design-system token block |
| `config.js` | Supabase URL and publishable key |
| `boot.js` | Sign-in, loads the knowledge base from Supabase, then starts the app |
| `app.js` | Sizing engine, knowledge retrieval, UI |
| `assets/logos/` | Oryx logo and favicon |
| `build_kb.py` | Spreadsheet → `data/`; also holds the engineering notes and glossary |
| `push_to_supabase.py` | `data/` → Supabase tables and storage |
| `serve.py` | Local preview server |
| `data/` | Built output — git-ignored, never published |

## Database

Seven tables, all read-only to signed-in staff:

| Table | Holds |
|---|---|
| `systems` | One row per system: sash limits, glass, locking, automation, tracks |
| `configurations` | Panel layouts, with leaf and operable counts the engine uses |
| `system_options` | Threshold, drainage and sightline support — three-state |
| `drawings` | 170 drawing records pointing at the private storage bucket |
| `engineering_notes` | Confirmed engineering detail, keyed by system |
| `glossary` | Term definitions |
| `kb_meta` | Source filename and last update time |

`system_options.supported` is deliberately three-state: `true` offered, `false`
an explicit N/A in the spreadsheet, `null` a blank cell meaning not recorded.
The app shows those three differently, so a gap in the data never reads as a no.

## Deploying a change

GitHub Pages serves the `main` branch directly, so a push is a deploy:

```bash
git add -A && git commit -m "Describe the change" && git push
```

The site updates within a minute or so. No build step and no GitHub Actions
workflow are involved.

## Where this could go next

1. **An editor screen.** Admin users could edit specs, engineering notes and
   glossary terms in the browser instead of going via the spreadsheet. It needs a
   role column on the user record and write policies restricted to that role.
2. **Question logging.** A table recording what people ask would show which
   questions the knowledge base cannot yet answer — the best guide to what the
   technical team should fill in next.
3. **A language model for phrasing only.** Keep Supabase as the single source of
   truth and use a model purely to interpret how a question is worded. The stored
   answer is still what gets returned, so specifications cannot be invented.
4. **Move the database closer.** The Supabase project sits in Seoul
   (`ap-northeast-2`). Mumbai (`ap-south-1`) would cut latency noticeably from
   the UAE. It means creating a new project and re-running the push script.
