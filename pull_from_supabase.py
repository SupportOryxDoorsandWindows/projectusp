#!/usr/bin/env python3
"""
Rebuild data/kb.json (and data/kb.js) from the live Supabase tables.

The normal flow is spreadsheet -> build_kb.py -> data/kb.json -> push_to_supabase.py
-> Supabase. This script runs that mapping in reverse, using the same
read-only publishable key already in config.js (see push_to_supabase.py for
the table schema this mirrors). It never writes to Supabase.

Use it to recover a local data/kb.json that has been lost or corrupted,
without needing the source spreadsheet - Supabase is the deployed source of
truth for the live app.

Usage
-----
    python3 pull_from_supabase.py
"""

import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.js")
OUT_DATA = os.path.join(HERE, "data")


def read_config():
    with open(CONFIG_PATH) as f:
        text = f.read()
    url = re.search(r'supabaseUrl:\s*"([^"]+)"', text).group(1).rstrip("/")
    key = re.search(r'supabaseKey:\s*"([^"]+)"', text).group(1)
    return url, key


def fetch(url, key, table, query=""):
    req = urllib.request.Request(
        "%s/rest/v1/%s?%s" % (url, table, query),
        headers={"apikey": key, "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def group_by(rows, key):
    grouped = {}
    for r in rows:
        grouped.setdefault(r[key], []).append(r)
    return grouped


def build_kb(url, key):
    systems = fetch(url, key, "systems", "order=sort_order")
    configs = group_by(fetch(url, key, "configurations", "order=system_id,sort_order"), "system_id")
    options = group_by(fetch(url, key, "system_options", "order=system_id"), "system_id")
    drawings = group_by(fetch(url, key, "drawings", "order=system_id,sort_order"), "system_id")
    notes = group_by(fetch(url, key, "engineering_notes", "order=system_id,sort_order"), "system_id")
    glossary_rows = fetch(url, key, "glossary")
    kb_meta = fetch(url, key, "kb_meta", "id=eq.1")

    out_systems = []
    for s in systems:
        sid = s["id"]
        opts = {"threshold": {}, "drainage": {}, "sightline": {}}
        for o in options.get(sid, []):
            opts[o["kind"]][o["label"]] = o["supported"]
        out_systems.append(dict(
            id=sid, name=s["name"], family=s["family"],
            sash_w_min=s["sash_w_min"], sash_w_max=s["sash_w_max"],
            sash_h_min=s["sash_h_min"], sash_h_max=s["sash_h_max"],
            sash_sqm_max=s["sash_sqm_max"], glass=s["glass"],
            automation=s["automation"], locking=s["locking"],
            configs=[dict(label=c["label"], leaves=c["leaves"], operable=c["operable"],
                          tracks=c["tracks"]) for c in configs.get(sid, [])],
            any_config=s["any_config"], tracks=s["tracks"],
            thresholds=opts["threshold"], drainage=opts["drainage"], sightlines=opts["sightline"],
            drawings=[dict(kind=d["kind"], label=d["label"], file=d["storage_path"], cell=d["cell"])
                      for d in drawings.get(sid, [])],
        ))

    engineering = {sid: {n["key"]: n["value"] for n in rows} for sid, rows in notes.items()}
    glossary = {g["term"]: g["meaning"] for g in glossary_rows}
    source = kb_meta[0]["source"] if kb_meta else None

    return dict(source=source, systems=out_systems, engineering=engineering, glossary=glossary)


def main():
    url, key = read_config()
    print("Pulling from %s (read-only key) ..." % url)
    kb = build_kb(url, key)
    os.makedirs(OUT_DATA, exist_ok=True)

    with open(os.path.join(OUT_DATA, "kb.json"), "w") as f:
        json.dump(kb, f, indent=1)
    with open(os.path.join(OUT_DATA, "kb.js"), "w") as f:
        f.write("window.ORYX_KB = ")
        json.dump(kb, f, indent=1)
        f.write(";\n")

    print("Restored data/kb.json and data/kb.js: %d systems." % len(kb["systems"]))
    if not kb["systems"]:
        print("Warning: 0 systems returned - check the Supabase read-access policy is still open.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
