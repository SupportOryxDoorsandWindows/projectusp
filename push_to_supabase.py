#!/usr/bin/env python3
"""
Push the built knowledge base into Supabase.

Loads data/kb.json into the Postgres tables and uploads data/img/*.png into the
private `drawings` storage bucket. Safe to run repeatedly — it replaces the data
each time rather than appending.

Usage
-----
    export SUPABASE_URL="https://ylhdsvwzqcshffwohhfy.supabase.co"
    export SUPABASE_SERVICE_KEY="<service_role key from the Supabase dashboard>"
    python3 push_to_supabase.py

Find the service role key at:
  Supabase dashboard → Project Settings → API keys → service_role

Keep that key out of the repository and out of the browser. It bypasses Row
Level Security, so it belongs only on the machine running this script.

Typical refresh after the spreadsheet changes:
    python3 build_kb.py "/path/to/Copy of Slider USP.xlsx"
    python3 push_to_supabase.py
"""

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KB_PATH = os.path.join(HERE, "data", "kb.json")
IMG_DIR = os.path.join(HERE, "data", "img")
BUCKET = "drawings"

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def die(msg):
    sys.exit("Error: " + msg)


def request(method, path, body=None, content_type="application/json", extra=None):
    headers = {
        "apikey": KEY,
        "Authorization": "Bearer " + KEY,
        "Content-Type": content_type,
    }
    if extra:
        headers.update(extra)
    data = body
    if content_type == "application/json" and body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw and raw[:1] in b"[{" else raw
    except urllib.error.HTTPError as e:
        die("%s %s -> %s %s" % (method, path, e.code, e.read().decode(errors="replace")[:400]))


def insert(table, rows):
    """Insert in batches. PostgREST handles a few hundred rows happily."""
    if not rows:
        return
    for i in range(0, len(rows), 200):
        request("POST", "/rest/v1/" + table, rows[i:i + 200],
                extra={"Prefer": "return=minimal"})
    print("  %-20s %d rows" % (table, len(rows)))


def wipe():
    """Clear in dependency order. Cascades would work, but be explicit."""
    for table in ("drawings", "engineering_notes", "system_options",
                  "configurations", "systems", "glossary", "kb_meta"):
        # neq on the primary key matches every row
        col = {"glossary": "term", "kb_meta": "id", "systems": "id"}.get(table, "id")
        sentinel = "0" if col == "id" and table in ("kb_meta",) else "__none__"
        request("DELETE", "/rest/v1/%s?%s=neq.%s" % (table, col, sentinel),
                extra={"Prefer": "return=minimal"})


def push_data(kb):
    print("Loading tables…")
    wipe()

    systems, configs, options, drawings, notes = [], [], [], [], []
    for i, s in enumerate(kb["systems"]):
        systems.append(dict(
            id=s["id"], name=s["name"], family=s["family"],
            sash_w_min=s["sash_w_min"], sash_w_max=s["sash_w_max"],
            sash_h_min=s["sash_h_min"], sash_h_max=s["sash_h_max"],
            sash_sqm_max=s["sash_sqm_max"], glass=s["glass"],
            automation=s["automation"], locking=s["locking"],
            any_config=s["any_config"], tracks=s["tracks"], sort_order=i))

        for j, c in enumerate(s["configs"]):
            configs.append(dict(system_id=s["id"], label=c["label"], leaves=c["leaves"],
                                operable=c["operable"], tracks=c["tracks"], sort_order=j))

        for kind, key in (("threshold", "thresholds"), ("drainage", "drainage"),
                          ("sightline", "sightlines")):
            for label, supported in (s[key] or {}).items():
                options.append(dict(system_id=s["id"], kind=kind,
                                    label=label, supported=supported))

        for j, d in enumerate(s["drawings"]):
            drawings.append(dict(system_id=s["id"], kind=d["kind"], label=d["label"],
                                 cell=d["cell"], storage_path=d["file"], sort_order=j))

    for sys_id, pairs in (kb.get("engineering") or {}).items():
        for j, (k, v) in enumerate(pairs.items()):
            notes.append(dict(system_id=sys_id, key=k, value=v, sort_order=j))

    insert("systems", systems)
    insert("configurations", configs)
    insert("system_options", options)
    insert("drawings", drawings)
    insert("engineering_notes", notes)
    insert("glossary", [dict(term=t, meaning=m) for t, m in (kb.get("glossary") or {}).items()])
    insert("kb_meta", [dict(id=1, source=kb.get("source"))])


def push_images():
    if not os.path.isdir(IMG_DIR):
        die("no data/img directory — run build_kb.py first")
    files = sorted(f for f in os.listdir(IMG_DIR) if not f.startswith("."))
    print("Uploading %d drawings to the private '%s' bucket…" % (len(files), BUCKET))
    for n, f in enumerate(files, 1):
        with open(os.path.join(IMG_DIR, f), "rb") as fh:
            blob = fh.read()
        mime = mimetypes.guess_type(f)[0] or "application/octet-stream"
        # x-upsert lets the script be re-run without deleting the bucket first
        request("POST", "/storage/v1/object/%s/%s" % (BUCKET, f), blob,
                content_type=mime, extra={"x-upsert": "true"})
        if n % 25 == 0 or n == len(files):
            print("  %d/%d" % (n, len(files)))


if __name__ == "__main__":
    if not URL or not KEY:
        die("set SUPABASE_URL and SUPABASE_SERVICE_KEY first (see the docstring)")
    if not os.path.exists(KB_PATH):
        die("data/kb.json is missing — run build_kb.py first")
    with open(KB_PATH) as f:
        kb = json.load(f)

    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if only in ("all", "data"):
        push_data(kb)
    if only in ("all", "images"):
        push_images()
    print("Done.")
