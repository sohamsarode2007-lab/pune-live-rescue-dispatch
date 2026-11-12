"""River lines (Mutha, Mula, Mula-Mutha) inside the demo bbox from OpenStreetMap.

Usage:  .venv\\Scripts\\python scripts/build_river.py
Output: server/data/river.json  { meta, rivers: [{ name, osm: [...], lines: [[[lat, lng], ...], ...] }] }

Used for (a) identifying river crossings (road edges tagged bridge=* whose shape crosses a river line) and
(b) the Phase 5 flood model (distance of each junction from the river).

Only the river WAYS inside the bbox are requested (one small Overpass query with `out geom`). Asking for
the river relations through OSMnx downloads the whole river basin and timed out.
"""
import json
import os
import sys
import time

import requests

from osm_common import BBOX, OVERPASS_URLS, ROOT

OUT = os.path.join(ROOT, "server", "data", "river.json")
CACHE = os.path.join(ROOT, "scripts", ".osm_cache", "river-ways.json")
QUERY = (
    f'[out:json][timeout:60];way["waterway"="river"]'
    f'({BBOX["south"]},{BBOX["west"]},{BBOX["north"]},{BBOX["east"]});out tags geom;'
)


def fetch():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    last = None
    for url in dict.fromkeys(OVERPASS_URLS):
        for attempt in range(2):
            try:
                print(f"Overpass: {url} (attempt {attempt + 1})", file=sys.stderr)
                r = requests.post(f"{url}/interpreter", data={"data": QUERY}, timeout=90,
                                  headers={"User-Agent": "rescue-dispatch-course-demo"})
                r.raise_for_status()
                data = r.json()
                os.makedirs(os.path.dirname(CACHE), exist_ok=True)
                with open(CACHE, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                return data
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  failed: {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"All Overpass endpoints failed: {last}")


def main():
    data = fetch()
    rivers = {}
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        name = tags.get("name:en") or tags.get("name") or "Unnamed river"
        pts = [[round(p["lat"], 6), round(p["lon"], 6)] for p in el["geometry"]]
        if len(pts) >= 2:
            r = rivers.setdefault(name, {"name": name, "osm": [], "lines": []})
            r["osm"].append(f"way/{el['id']}")
            r["lines"].append(pts)
    out = {
        "meta": {"source": "OpenStreetMap contributors (ODbL): waterway=river ways in the bbox", "bbox": BBOX,
                 "names": sorted(rivers)},
        "rivers": sorted(rivers.values(), key=lambda r: r["name"]),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    for r in out["rivers"]:
        print(f"{r['name']}: {len(r['lines'])} ways, {sum(len(l) for l in r['lines'])} points", file=sys.stderr)
    print(f"Wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
