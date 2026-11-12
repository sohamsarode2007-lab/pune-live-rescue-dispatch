"""Evacuation shelters from OpenStreetMap: schools, colleges/universities, community halls, municipal halls.

Usage:  .venv\\Scripts\\python scripts/build_shelters.py      (after build_graph.py and build_facilities.py)
Output: adds kind="shelter" records to server/data/facilities.json (existing hospitals / stations / units
        are left exactly as they are; earlier shelter records are replaced).

OSM rarely tags flood shelters in India; in practice Pune moves flood-affected families into schools and
municipal / community halls, so those are used. Names and locations are REAL (OSM). Capacities are
SIMULATED by type (CAPACITY below) and every shelter is marked "simulated": ["capacity"].
Snapping to the nearest graph junction is a plain brute-force haversine scan (our own code).
"""
import json
import math
import os
import re
import sys
import time

import requests

from osm_common import BBOX, OVERPASS_URLS, ROOT

FAC = os.path.join(ROOT, "server", "data", "facilities.json")
GRAPH = os.path.join(ROOT, "server", "data", "pune-central.graph.json")
CACHE = os.path.join(ROOT, "scripts", ".osm_cache", "shelters.json")

TYPE_OF = {"school": "school", "college": "college", "university": "college",
           "community_centre": "community_hall", "townhall": "municipal_hall"}
# SIMULATED evacuation capacity (people) per shelter type. Illustrative: a school hall + classrooms,
# a college campus, a community hall, a ward office / municipal hall.
CAPACITY = {"school": 300, "college": 500, "community_hall": 150, "municipal_hall": 200}
MERGE_M = 150

QUERY = (
    '[out:json][timeout:90];'
    f'nwr["amenity"~"^(school|college|university|community_centre|townhall)$"]'
    f'({BBOX["south"]},{BBOX["west"]},{BBOX["north"]},{BBOX["east"]});out center tags;'
)


def haversine_m(lat1, lng1, lat2, lng2):
    r = math.pi / 180
    s = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lng2 - lng1) * r / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(s)))


def fetch():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    last = None
    for url in dict.fromkeys(OVERPASS_URLS):
        for attempt in range(2):
            try:
                print(f"Overpass: {url} (attempt {attempt + 1})", file=sys.stderr)
                r = requests.post(f"{url}/interpreter", data={"data": QUERY}, timeout=120,
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


def norm(name):
    return " ".join(re.findall(r"[a-z0-9]+", (name or "").lower()))


def main():
    with open(FAC, encoding="utf-8") as f:
        fac = json.load(f)
    with open(GRAPH, encoding="utf-8") as f:
        nodes = json.load(f)["nodes"]

    raw = []
    for el in fetch().get("elements", []):
        tags = el.get("tags", {})
        typ = TYPE_OF.get(tags.get("amenity"))
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lng = el.get("lon", el.get("center", {}).get("lon"))
        if not typ or lat is None:
            continue
        if not (BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lng <= BBOX["east"]):
            continue
        name = tags.get("name:en") or tags.get("name")
        raw.append({"osm": f"{el['type']}/{el['id']}", "type": typ, "name": name, "lat": lat, "lng": lng,
                    "area": el["type"] != "node", "tags": len(tags)})
    before = len(raw)

    # one record per place: same type, within MERGE_M, same normalised name (or one unnamed);
    # prefer building outlines (ways/relations) and records with more tags
    raw.sort(key=lambda r: (not r["area"], -r["tags"]))
    kept = []
    for r in raw:
        if any(k["type"] == r["type"] and haversine_m(k["lat"], k["lng"], r["lat"], r["lng"]) <= MERGE_M
               and (norm(k["name"]) == norm(r["name"]) or not r["name"] or not k["name"]) for k in kept):
            continue
        kept.append(r)

    for r in kept:
        best, best_d = None, float("inf")
        for n in nodes:
            d = haversine_m(r["lat"], r["lng"], n["lat"], n["lng"])
            if d < best_d:
                best, best_d = n["id"], d
        r["nodeId"], r["snap"] = best, round(best_d, 1)

    kept.sort(key=lambda r: (r["type"], r["name"] or "~", r["osm"]))
    label = {"school": "School", "college": "College", "community_hall": "Community hall", "municipal_hall": "Municipal hall"}
    shelters = []
    for i, r in enumerate(kept, 1):
        shelters.append({
            "id": f"S{i}", "kind": "shelter", "shelterType": r["type"],
            "name": r["name"] or f"{label[r['type']]} (S{i})", "osm": r["osm"],
            "lat": round(r["lat"], 6), "lng": round(r["lng"], 6), "nodeId": r["nodeId"], "snapDistanceM": r["snap"],
            "capacity": CAPACITY[r["type"]], "simulated": ["capacity"],
        })

    fac["facilities"] = [f for f in fac["facilities"] if f["kind"] != "shelter"] + shelters
    by_type = {t: sum(1 for s in shelters if s["shelterType"] == t) for t in CAPACITY}
    fac["meta"]["shelters"] = {
        "source": "OpenStreetMap contributors (ODbL): amenity=school|college|university|community_centre|townhall",
        "why": "OSM rarely tags flood shelters in India; Pune moves flood-affected families into schools and municipal halls.",
        "capacityPerType": CAPACITY, "simulatedNote": "Shelter capacities are SIMULATED by type, not real data.",
        "rawRecords": before, "afterMerge": len(shelters), "byType": by_type,
        "totalCapacity": sum(s["capacity"] for s in shelters),
    }
    fac["meta"]["counts"]["shelter"] = len(shelters)
    with open(FAC, "w", encoding="utf-8") as f:
        json.dump(fac, f, indent=1, ensure_ascii=False)
    print(json.dumps(fac["meta"]["shelters"], ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
