"""Real hospitals, fire stations and police stations inside the demo bbox, from OpenStreetMap tags.

Usage (after build_graph.py):
    .venv\\Scripts\\python scripts/build_facilities.py

Output: server/data/facilities.json

* Facility locations and names are REAL (OSM). Each is snapped to the nearest junction of our road
  graph with a plain brute-force haversine scan (our own code, no spatial library).
* The same place is often mapped several times (a point + a building outline, or near-duplicate names).
  Records of the same kind are merged (union-find, so merging is transitive) when:
    a) one record's point lies inside another record's building outline, or
    b) they are within MERGE_RADIUS_M and their names are the same or similar
       (normalised token sets: equal, one contained in the other, or Jaccard >= 0.6), or
    c) they are within MERGE_RADIUS_M and one of them has no name.
* "major" hospitals: the MAJOR_COUNT best-scoring hospitals, scored from OSM evidence
  (beds, emergency=yes, healthcare:speciality, building footprint area) and well-known names.
  Phase 3 two-leg routing prefers major hospitals for severe incidents.
* `bedsFree` on hospitals and the vehicle fleet at stations are SIMULATED (fixed random seed) and are
  marked "simulated". They are not real capacity or fleet data.
"""
import json
import math
import os
import random
import re
import sys

import osmnx as ox

from osm_common import BBOX, BBOX_TUPLE, ROOT, setup, with_overpass_fallback

GRAPH = os.path.join(ROOT, "server", "data", "pune-central.graph.json")
OUT = os.path.join(ROOT, "server", "data", "facilities.json")
SEED = 2026
TAGS = {"amenity": ["hospital", "fire_station", "police"], "healthcare": ["hospital"]}
MERGE_RADIUS_M = 150
MAJOR_COUNT = 12
UTM_43N = 32643  # metric CRS for footprint areas

# Well-known large hospitals in/near central Pune (name evidence for "major").
MAJOR_NAME_HINTS = [
    "sassoon", "ruby hall", "jehangir", "kem", "deenanath", "mangeshkar", "sahyadri", "poona hospital",
    "command hospital", "inlaks", "budhrani", "kamla nehru", "sancheti",
    "medical college", "military hospital", "cantonment general",
]

# Manual same-place rules for campuses whose OSM records have unrelated names.
# (kind, keyword in name, max distance in m). Sassoon General Hospital is mapped both as
# "B.J. Medical College and Sassoon Hospital" and "David Sassoon Hospital" on one campus.
SAME_PLACE_RULES = [("hospital", "sassoon", 500)]

# Words that do not identify a hospital (removed before comparing names).
NAME_STOPWORDS = {
    "hospital", "hospitals", "the", "pvt", "ltd", "private", "limited", "and", "multispeciality",
    "multispecialty", "multi", "speciality", "specialty", "super", "clinic", "nursing", "home", "centre",
    "center", "medical", "dr", "research", "institute", "of", "&", "pune", "hosp", "s",
}

# Simulated fleet (documented assumption):
#   fire station: 2 fire trucks + 1 rescue boat (Pune Fire Brigade also runs flood rescue)
#   police station: 1 ambulance (stands in for a quick-response vehicle)
#   each major hospital: 1 ambulance


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


def name_tokens(name):
    if not name:
        return frozenset()
    words = re.findall(r"[a-z0-9]+", name.lower())
    return frozenset(w for w in words if w not in NAME_STOPWORDS)


def similar_names(a, b):
    ta, tb = a["tokens"], b["tokens"]
    if not ta or not tb:
        return a["name"] is not None and a["name"] == b["name"]
    if ta == tb or ta <= tb or tb <= ta:
        return True
    return len(ta & tb) / len(ta | tb) >= 0.6


class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]  # path halving
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra
            return True
        return False


def parse_beds(v):
    m = re.search(r"\d+", clean(v) or "")
    return int(m.group()) if m else None


def major_score(c):
    score, reasons = 0, []
    if c["beds"]:
        pts = 4 if c["beds"] >= 200 else 3 if c["beds"] >= 100 else 1 if c["beds"] >= 50 else 0
        if pts:
            score += pts
            reasons.append(f"beds={c['beds']}")
    if c["emergency"]:
        score += 2
        reasons.append("emergency=yes")
    if c["specialities"] >= 3:
        score += 1
        reasons.append(f"{c['specialities']} specialities")
    area = c["areaM2"]
    pts = 3 if area >= 20000 else 2 if area >= 8000 else 1 if area >= 3000 else 0
    if pts:
        score += pts
        reasons.append(f"footprint {round(area):,} m²")
    lname = (c["name"] or "").lower()
    if any(h in lname for h in MAJOR_NAME_HINTS):
        score += 3
        reasons.append("well-known large hospital (name)")
    return score, reasons


def main():
    setup()
    with open(GRAPH, encoding="utf-8") as f:
        nodes = json.load(f)["nodes"]

    gdf = with_overpass_fallback(lambda: ox.features_from_bbox(BBOX_TUPLE, tags=TAGS))
    areas = gdf.geometry.to_crs(UTM_43N).area

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
        spec = clean(row.get("healthcare:speciality")) or ""
        raw.append({
            "osm": f"{elem}/{osmid}", "kind": kind_of(row), "name": name, "tokens": name_tokens(name),
            "lat": lat, "lng": lng, "geom": geom,
            "polygon": geom if geom.geom_type in ("Polygon", "MultiPolygon") else None,
            "areaM2": float(areas.loc[(elem, osmid)]) if geom.geom_type in ("Polygon", "MultiPolygon") else 0.0,
            "emergency": clean(row.get("emergency")) == "yes",
            "beds": parse_beds(row.get("beds")),
            "specialities": len([s for s in spec.split(";") if s.strip()]),
            "tagCount": int(row.notna().sum()),
        })
    before = {k: sum(1 for r in raw if r["kind"] == k) for k in ("hospital", "fire_station", "police")}

    # ---- merge duplicates (union-find over all pairs of the same kind) ----
    uf = UnionFind(len(raw))
    reasons = {"insideOutline": 0, "similarName": 0, "unnamedNearby": 0, "samePlaceRule": 0}
    for i in range(len(raw)):
        for j in range(i + 1, len(raw)):
            a, b = raw[i], raw[j]
            if a["kind"] != b["kind"]:
                continue
            why = None
            pa, pb = a["polygon"], b["polygon"]
            if (pa is not None and pa.covers(b["geom"].representative_point())) or \
               (pb is not None and pb.covers(a["geom"].representative_point())):
                why = "insideOutline"
            elif haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]) <= MERGE_RADIUS_M:
                if a["name"] and b["name"]:
                    if similar_names(a, b):
                        why = "similarName"
                else:
                    why = "unnamedNearby"
            if not why:
                for kind, keyword, max_m in SAME_PLACE_RULES:
                    if a["kind"] == kind and keyword in (a["name"] or "").lower() and keyword in (b["name"] or "").lower() \
                            and haversine_m(a["lat"], a["lng"], b["lat"], b["lng"]) <= max_m:
                        why = "samePlaceRule"
            if why and uf.union(i, j):
                reasons[why] += 1

    clusters = {}
    for i, r in enumerate(raw):
        clusters.setdefault(uf.find(i), []).append(r)

    merged = []
    for members in clusters.values():
        # Representative: named, most tags. Location: a building outline if there is one (snaps better).
        rep = sorted(members, key=lambda r: (r["name"] is None, -r["tagCount"]))[0]
        loc = next((m for m in members if m["polygon"] is not None), rep)
        merged.append({
            "kind": rep["kind"], "name": rep["name"], "osm": rep["osm"],
            "mergedFrom": sorted(m["osm"] for m in members) if len(members) > 1 else None,
            "lat": round(loc["lat"], 6), "lng": round(loc["lng"], 6),
            "emergency": any(m["emergency"] for m in members),
            "beds": max((m["beds"] or 0 for m in members), default=0) or None,
            "specialities": max(m["specialities"] for m in members),
            "areaM2": max(m["areaM2"] for m in members),
        })
    after = {k: sum(1 for r in merged if r["kind"] == k) for k in before}
    print(f"before merge: {before}  after merge: {after}  merges: {reasons}", file=sys.stderr)

    # ---- snap to nearest graph junction (brute force, O(F * V)) ----
    for r in merged:
        best, best_d = None, float("inf")
        for n in nodes:
            d = haversine_m(r["lat"], r["lng"], n["lat"], n["lng"])
            if d < best_d:
                best, best_d = n["id"], d
        r["nodeId"], r["snapDistanceM"] = best, round(best_d, 1)

    # ---- major hospitals ----
    hospitals = [r for r in merged if r["kind"] == "hospital"]
    for h in hospitals:
        h["score"], h["reasons"] = major_score(h)
    ranked = sorted([h for h in hospitals if h["score"] >= 3], key=lambda h: (-h["score"], -h["areaM2"], h["name"] or ""))
    major_osm = {h["osm"] for h in ranked[:MAJOR_COUNT]}

    rng = random.Random(SEED)
    prefix = {"hospital": "H", "fire_station": "F", "police": "P"}
    counters = {"hospital": 0, "fire_station": 0, "police": 0}
    merged.sort(key=lambda r: (r["kind"], r["osm"] not in major_osm, r["name"] or "~", r["osm"]))
    facilities = []
    for r in merged:
        counters[r["kind"]] += 1
        fid = f"{prefix[r['kind']]}{counters[r['kind']]}"
        default = {"hospital": "Unnamed hospital", "fire_station": "Fire station", "police": "Police station"}[r["kind"]]
        fac = {
            "id": fid, "kind": r["kind"], "name": r["name"] or f"{default} ({fid})", "osm": r["osm"],
            "lat": r["lat"], "lng": r["lng"], "nodeId": r["nodeId"], "snapDistanceM": r["snapDistanceM"],
        }
        if r["mergedFrom"]:
            fac["mergedFrom"] = r["mergedFrom"]
        if r["kind"] == "hospital":
            major = r["osm"] in major_osm
            fac["major"] = major
            if major:
                fac["majorReasons"] = r["reasons"]
            fac["bedsFree"] = rng.choice([4, 8, 12, 20, 30, 40]) if major else rng.choice([0, 0, 1, 2, 3, 5, 8])
            fac["simulated"] = ["bedsFree"]
        facilities.append(fac)

    units = []

    def add_units(fac, kinds):
        for kind in kinds:
            n = sum(1 for u in units if u["type"] == kind) + 1
            code = {"ambulance": "AMB", "fire_truck": "FT", "rescue_boat": "BOAT"}[kind]
            units.append({"id": f"{code}-{n}", "type": kind, "stationId": fac["id"], "homeNodeId": fac["nodeId"],
                          "simulated": True})

    for fac in facilities:
        if fac["kind"] == "fire_station":
            add_units(fac, ["fire_truck", "fire_truck", "rescue_boat"])
        elif fac["kind"] == "police":
            add_units(fac, ["ambulance"])
        elif fac.get("major"):
            add_units(fac, ["ambulance"])

    out = {
        "meta": {
            "source": "OpenStreetMap contributors (ODbL): amenity=hospital|fire_station|police, healthcare=hospital",
            "bbox": BBOX, "seed": SEED,
            "simulatedNote": "Hospital bedsFree and every unit (fleet) are SIMULATED demo values, not real data.",
            "fleetRule": "fire station: 2 fire trucks + 1 rescue boat; police station: 1 ambulance; "
                         "major hospital: 1 ambulance",
            "mergeRule": f"same kind and (point inside the other's building outline, or within {MERGE_RADIUS_M} m "
                         "with the same/similar name, or within that distance and unnamed, or a manual same-place "
                         f"rule: {SAME_PLACE_RULES})",
            "majorRule": f"top {MAJOR_COUNT} hospitals by score: beds, emergency=yes, healthcare:speciality, "
                         "building footprint area, well-known name",
            "rawCounts": before,
            "mergeCounts": reasons,
            "counts": after | {"majorHospitals": len(major_osm), "units": len(units)},
        },
        "facilities": facilities,
        "units": units,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print("major:", [f"{h['name']} ({h['score']}: {', '.join(h['reasons'])})" for h in ranked[:MAJOR_COUNT]], file=sys.stderr)
    print(json.dumps(out["meta"]["counts"]), file=sys.stderr)
    print(f"Wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
