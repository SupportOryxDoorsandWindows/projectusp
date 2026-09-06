#!/usr/bin/env python3
"""
One-time migration: populate Supabase `inventory_items` (Master Inventory,
Freedom classification only — see the Phase 1 plan) from the source
spreadsheets, then verify against `inventory_transactions`.

Sources
-------
  FREEDOM ITEM LIST CATEGORIZED.xlsx  -- item_code, description, bar length,
                                          category, opening qty, unit cost,
                                          opening value. Already one row per
                                          code+length variant (no dedup needed).
  FLYSCREEN STOCK AUG 18.xlsx         -- buffer level per variant, matched by
                                          (code, length) the same way
                                          fp-pro.js's codeFromPartName() does.
                                          Deliberately the ORIGINAL file, not
                                          the dated Downloads copy — that copy
                                          carries a "082426-test" job column
                                          from earlier demo testing and would
                                          double-count against the sample PDF.

What this does NOT set (left null/default, per the Phase 1 plan's
"still to confirm" list — do not guess these):
  system_type   -- the blueprint's own examples (F44/R62/R50) do not appear
                   anywhere in the source files. STOCK's "Product" column
                   (e.g. SMB 60/SMB 80, INF60/70/80/100) is a different naming
                   scheme and is NOT assumed to be the same field.
  unit_of_measure -- left as 'pcs' by default. Some codes are genuinely
                   ambiguous: e.g. 620001 is a single ACCESSORY row here but
                   is consumed as a bar (by length) in the sample PDF's Bars
                   Optimization Report. fp-pro.js already handles this at the
                   transaction level (unit is decided per PDF line, not per
                   master item) -- this script does not try to resolve it at
                   the master-item level.

Usage
-----
    export SUPABASE_URL="https://ylhdsvwzqcshffwohhfy.supabase.co"
    export SUPABASE_SERVICE_KEY="<service_role key from the Supabase dashboard>"
    python3 migrate_inventory.py \\
        "/Users/businesssupport/Documents/FREEDOM ITEM LIST CATEGORIZED.xlsx" \\
        "/Users/businesssupport/Documents/FLYSCREEN  STOCK AUG 18.xlsx"

Safe to re-run: wipes and reloads `inventory_items` each time (same pattern as
push_to_supabase.py). Never run this after Check-out transactions exist for
real jobs -- it would reset current_qty back to the opening balance and lose
whatever those transactions deducted. Check `inventory_transactions` first.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

import openpyxl

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def die(msg):
    sys.exit("Error: " + msg)


def request(method, path, body=None, extra=None):
    headers = {
        "apikey": KEY,
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw and raw[:1] in b"[{" else raw
    except urllib.error.HTTPError as e:
        die("%s %s -> %s %s" % (method, path, e.code, e.read().decode(errors="replace")[:400]))


def insert(table, rows):
    if not rows:
        return
    for i in range(0, len(rows), 200):
        request("POST", "/rest/v1/" + table, rows[i:i + 200],
                extra={"Prefer": "return=minimal"})
    print("  %-20s %d rows" % (table, len(rows)))


def check_no_existing_transactions():
    result = request("GET", "/rest/v1/inventory_transactions?select=id&limit=1")
    if result:
        die("inventory_transactions already has rows. Re-running this migration "
            "would reset current_qty and lose those deductions. Stop and confirm "
            "with the user before proceeding.")


CODE_RE = re.compile(r"^\s*(\d+[A-Z]?)")


def code_from_part_name(part_name):
    if not part_name:
        return ""
    m = CODE_RE.match(str(part_name))
    return m.group(1) if m else ""


def load_freedom_items(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Sheet1"]
    items = []
    for r in range(2, ws.max_row + 1):
        code = ws.cell(row=r, column=1).value
        if code is None:
            continue
        description = ws.cell(row=r, column=2).value
        length_m = ws.cell(row=r, column=3).value
        category = ws.cell(row=r, column=4).value
        opening_qty = ws.cell(row=r, column=5).value or 0
        unit_cost = ws.cell(row=r, column=6).value or 0
        opening_value = ws.cell(row=r, column=7).value or 0
        items.append({
            "item_code": str(code),
            "description": description,
            "bar_length_mm": round(length_m * 1000, 1) if isinstance(length_m, (int, float)) else None,
            "category": category,
            "opening_qty": opening_qty,
            "unit_cost": unit_cost,
            "opening_value": opening_value,
        })
    return items


def load_buffer_levels(path):
    """(code, length_m) -> buffer level, from the STOCK sheet."""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["STOCK"]
    headers = {c: ws.cell(row=2, column=c).value for c in range(1, ws.max_column + 1)}
    part_col = length_col = buffer_col = None
    for c, h in headers.items():
        hh = str(h or "").strip().upper()
        if part_col is None and "PART CODE" in hh:
            part_col = c
        if length_col is None and hh == "LENGTH":
            length_col = c
        if buffer_col is None and hh == "BUFFER LEVEL":
            buffer_col = c
    if not (part_col and buffer_col):
        die('Could not find "Part code" / "Buffer level" columns in the STOCK sheet.')

    lookup = {}
    for r in range(3, ws.max_row + 1):
        part_name = ws.cell(row=r, column=part_col).value
        code = code_from_part_name(part_name)
        if not code:
            continue
        length_m = ws.cell(row=r, column=length_col).value if length_col else None
        buffer = ws.cell(row=r, column=buffer_col).value
        key = (code, round(length_m, 2) if isinstance(length_m, (int, float)) else None)
        if isinstance(buffer, (int, float)):
            lookup[key] = buffer
    return lookup


def wipe():
    request("DELETE", "/rest/v1/inventory_items?id=not.is.null",
            extra={"Prefer": "return=minimal"})


def main():
    if not URL or not KEY:
        die("set SUPABASE_URL and SUPABASE_SERVICE_KEY first (see the docstring)")
    if len(sys.argv) != 3:
        die("usage: migrate_inventory.py <FREEDOM ITEM LIST.xlsx> <FLYSCREEN STOCK.xlsx>")
    freedom_path, stock_path = sys.argv[1], sys.argv[2]

    print("Checking inventory_transactions is empty...")
    check_no_existing_transactions()

    print("Reading %s..." % freedom_path)
    items = load_freedom_items(freedom_path)
    print("  %d item rows" % len(items))

    print("Reading buffer levels from %s..." % stock_path)
    buffers = load_buffer_levels(stock_path)
    print("  %d (code, length) buffer entries" % len(buffers))

    matched_buffers = 0
    for it in items:
        length_m = round(it["bar_length_mm"] / 1000, 2) if it["bar_length_mm"] else None
        key = (it["item_code"], length_m)
        buf = buffers.get(key)
        if buf is None and length_m is None:
            buf = buffers.get((it["item_code"], None))
        if buf is not None:
            it["buffer_level"] = buf
            matched_buffers += 1
        else:
            it["buffer_level"] = None
        it["classification"] = "freedom"
        it["system_type"] = None
        it["unit_of_measure"] = "pcs"
        it["current_qty"] = it["opening_qty"]
        it["current_value"] = it["opening_value"]
        it["status"] = "active"
    print("  matched buffer level for %d/%d items" % (matched_buffers, len(items)))

    print("Wiping existing inventory_items (safe: no transactions exist yet)...")
    wipe()

    print("Loading Master Inventory...")
    insert("inventory_items", items)
    print("Done.")


if __name__ == "__main__":
    main()
