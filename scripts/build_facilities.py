"""Real hospitals, fire stations and police stations inside the demo bbox, from OpenStreetMap tags.

Usage (after build_graph.py):
    .venv\\Scripts\\python scripts/build_facilities.py

Output: server/data/facilities.json

* Facility locations and names are REAL (OSM). Each is snapped to the nearest junction of our road
  graph with a plain brute-force haversine scan (our own code, no spatial library).
* `bedsFree` on hospitals and the vehicle fleet at stations are SIMULATED (fixed random seed) and are
  marked "simulated": true. They are not real capacity or fleet data.
"""
import json
import math
import os
import random
import sys

import osmnx as ox

from osm_common import BBOX, BBOX_TUPLE, ROOT, setup, with_overpass_fallback

GRAPH = os.path.join(ROOT, "server", "data", "pune-central.graph.json")
OUT = os.path.join(ROOT, "server", "data", "facilities.json")
SEED = 2026
TAGS = {"amenity": ["hospital", "fire_station", "police"], "healthcare": ["hospital"]}

# Simulated fleet (documented assumption):
#   fire station: 2 fire trucks + 1 rescue boat (Pune Fire Brigade also runs flood rescue)
#   police station: 1 ambulance (stands in for a quick-response vehicle)
#   hospital: the AMBULANCE_HOSPITALS hospitals with the most complete OSM data get 1 ambulance each
AMBULANCE_HOSPITALS = 14


def haversine_m(lat1, lng1, lat2, lng2):
    r = math.pi / 180
    s = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lng2 - lng1) * r / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(s)))


def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return str(v).strip() or None


def kind_of(row):
    amenity = clean(row.get("amenity"))
    if amenity == "fire_station":
        return "fire_station"
    if amenity == "police":
        return "police"
    return "hospital"


def main():
    setup()
    with open(GRAPH, encoding="utf-8") as f:
        nodes = json.load(f)["nodes"]

    gdf = with_overpass_fallback(lambda: ox.features_from_bbox(BBOX_TUPLE, tags=TAGS))
    print(f"{len(gdf)} raw OSM features", file=sys.stderr)

    raw = []
    for (elem, osmid), row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        p = geom if geom.geom_type == "Point" else geom.representative_point()
        lat, lng = p.y, p.x
        if not (BBOX["south"] <= lat <= BBOX["north"] and BBOX["west"] <= lng <= BBOX["east"]):
            continue
        name = clean(row.get("name:en")) or clean(row.get("name"))
        raw.append({
            "osm": f"{elem}/{osmid}", "kind": kind_of(row), "name": name,
            "lat": round(lat, 6), "lng": round(lng, 6),
            "emergency": clean(row.get("emergency")) == "yes",
            "tagCount": int(row.notna().sum()),
        })

    # The same facility is often mapped twice (a node and a building outline): keep one per kind
    # within 120 m with the same name (or unnamed). Prefer the record with more tags.
    raw.sort(key=lambda r: -r["tagCount"])
    kept = []
    for r in raw:
        dup = any(
            k["kind"] == r["kind"] and haversine_m(k["lat"], k["lng"], r["lat"], r["lng"]) < 120
            and (k["name"] == r["name"] or not r["name"] or not k["name"])
            for k in kept
        )
        if not dup:
            kept.append(r)

    # Snap to nearest graph junction (brute force, O(F * V)).
    for r in kept:
        best, best_d = None, float("inf")
        for n in nodes:
            d = haversine_m(r["lat"], r["lng"], n["lat"], n["lng"])
            if d < best_d:
                best, best_d = n["id"], d
        r["nodeId"], r["snapDistanceM"] = best, round(best_d, 1)

    rng = random.Random(SEED)
    prefix = {"hospital": "H", "fire_station": "F", "police": "P"}
    counters = {"hospital": 0, "fire_station": 0, "police": 0}
    kept.sort(key=lambda r: (r["kind"], r["name"] or "~", r["osm"]))
    facilities = []
    for r in kept:
        counters[r["kind"]] += 1
        fid = f"{prefix[r['kind']]}{counters[r['kind']]}"
        default = {"hospital": "Unnamed hospital", "fire_station": "Fire station", "police": "Police station"}[r["kind"]]
        fac = {
            "id": fid, "kind": r["kind"], "name": r["name"] or f"{default} ({fid})", "osm": r["osm"],
            "lat": r["lat"], "lng": r["lng"], "nodeId": r["nodeId"], "snapDistanceM": r["snapDistanceM"],
        }
        if r["kind"] == "hospital":
            fac["bedsFree"] = rng.choice([0, 0, 2, 4, 6, 8, 10, 12, 15, 20, 25, 30])
            fac["emergencyTag"] = r["emergency"]
            fac["simulated"] = ["bedsFree"]
        facilities.append(fac)

    units = []

    def add_units(fac, kinds):
        for kind in kinds:
            n = sum(1 for u in units if u["type"] == kind) + 1
            code = {"ambulance": "AMB", "fire_truck": "FT", "rescue_boat": "BOAT"}[kind]
            units.append({"id": f"{code}-{n}", "type": kind, "stationId": fac["id"], "homeNodeId": fac["nodeId"],
                          "status": "AVAILABLE", "simulated": True})

    for fac in facilities:
        if fac["kind"] == "fire_station":
            add_units(fac, ["fire_truck", "fire_truck", "rescue_boat"])
        elif fac["kind"] == "police":
            add_units(fac, ["ambulance"])
    hospitals = [f for f in facilities if f["kind"] == "hospital"]
    named = sorted(hospitals, key=lambda f: (not f.get("emergencyTag"), f["name"].startswith("Unnamed"), rng.random()))
    for fac in named[:AMBULANCE_HOSPITALS]:
        add_units(fac, ["ambulance"])

    out = {
        "meta": {
            "source": "OpenStreetMap contributors (ODbL): amenity=hospital|fire_station|police, healthcare=hospital",
            "bbox": BBOX, "seed": SEED,
            "simulatedNote": "Hospital bedsFree and every unit (fleet) are SIMULATED demo values, not real data.",
            "fleetRule": "fire station: 2 fire trucks + 1 rescue boat; police: 1 ambulance; "
                         f"{AMBULANCE_HOSPITALS} hospitals (emergency=yes / named first): 1 ambulance each",
            "counts": {k: sum(1 for f in facilities if f["kind"] == k) for k in counters} | {"units": len(units)},
        },
        "facilities": facilities,
        "units": units,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(json.dumps(out["meta"]["counts"]), file=sys.stderr)
    print(f"Wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
