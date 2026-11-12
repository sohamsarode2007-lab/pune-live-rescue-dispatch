"""Download the drivable road network of central Pune from OpenStreetMap and export it as JSON.

Usage (from the project root):
    .venv\\Scripts\\python scripts/build_graph.py            # Windows
    .venv/bin/python scripts/build_graph.py                   # macOS / Linux

Output: server/data/pune-central.graph.json
    nodes: {id, lat, lng}
    edges: {id, from, to, lengthM, highway, maxspeedKmh, speedSource, oneway, name, geometry:[[lat,lng],...]}

OSMnx is used ONLY to download and clean OSM data (parse ways, split at junctions, merge degree-2
chains). It does no routing. All routing / search is our own JavaScript in shared/.

Graph decisions:
* network_type="drive", simplified (junctions + dead ends only; curve shape kept in `geometry`).
* Only the largest STRONGLY connected component is kept, so with one-way streets every junction can
  reach every other junction. Tiny disconnected fragments at the bbox edge are dropped.
* A two-way street appears in OSMnx as two directed edges u->v and v->u. We merge each such pair into
  ONE road with oneway=false (the JS Graph stores one shared road object for both directions).
  One-way streets stay directed (oneway=true, from -> to is the legal direction).
* Speed: the OSM `maxspeed` tag if present and sane (5..120 km/h), otherwise DEFAULT_SPEED_KMH by
  highway type (documented in README). These are free-flow assumptions, not measured speeds.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

import osmnx as ox

from osm_common import BBOX, BBOX_TUPLE, ROOT, setup, with_overpass_fallback

OUT = os.path.join(ROOT, "server", "data", "pune-central.graph.json")

# Free-flow speed (km/h) used when a road has no usable maxspeed tag. Urban Indian assumption.
DEFAULT_SPEED_KMH = {
    "motorway": 80, "motorway_link": 50,
    "trunk": 60, "trunk_link": 40,
    "primary": 50, "primary_link": 35,
    "secondary": 40, "secondary_link": 30,
    "tertiary": 35, "tertiary_link": 25,
    "unclassified": 30, "residential": 25, "road": 25,
    "living_street": 15, "service": 15,
}
FALLBACK_SPEED_KMH = 25

# Most important first; used when simplification merged ways with different highway tags.
HIGHWAY_RANK = list(DEFAULT_SPEED_KMH.keys())


def first(v):
    return v[0] if isinstance(v, list) else v


BRIDGE_WORDS = ("bridge", "pul", "setu", "flyover")


def pick_name(v):
    """Deterministic name when simplification merged ways with different names (OSMnx list order varies
    between runs): prefer a bridge-like name, otherwise the alphabetically first."""
    if not isinstance(v, list):
        return v if isinstance(v, str) else None
    names = sorted(str(x) for x in v if isinstance(x, str))
    bridgey = [n for n in names if any(w in n.lower() for w in BRIDGE_WORDS)]
    return (bridgey or names or [None])[0]


def pick_highway(v):
    vals = v if isinstance(v, list) else [v]
    ranked = sorted(vals, key=lambda h: HIGHWAY_RANK.index(h) if h in HIGHWAY_RANK else len(HIGHWAY_RANK))
    return ranked[0]


def parse_maxspeed(v):
    """Return km/h from an OSM maxspeed value ('50', '30 mph', ['40','50']) or None."""
    if v is None:
        return None
    vals = v if isinstance(v, list) else [v]
    speeds = []
    for s in vals:
        m = re.match(r"\s*(\d+(?:\.\d+)?)\s*(mph)?", str(s))
        if m:
            kmh = float(m.group(1)) * (1.609344 if m.group(2) else 1.0)
            if 5 <= kmh <= 120:
                speeds.append(kmh)
    return min(speeds) if speeds else None  # conservative when ways disagree


def osmid_key(v):
    vals = v if isinstance(v, list) else [v]
    return tuple(sorted(str(x) for x in vals))


def main():
    setup()
    print("Downloading drive network for", BBOX, file=sys.stderr)
    G = with_overpass_fallback(lambda: ox.graph_from_bbox(BBOX_TUPLE, network_type="drive", simplify=True))
    raw_nodes, raw_edges = G.number_of_nodes(), G.number_of_edges()
    G = ox.truncate.largest_component(G, strongly=True)
    print(f"Raw {raw_nodes} nodes / {raw_edges} directed edges; "
          f"largest SCC {G.number_of_nodes()} / {G.number_of_edges()}", file=sys.stderr)

    nodes = [{"id": str(n), "lat": round(d["y"], 6), "lng": round(d["x"], 6)} for n, d in G.nodes(data=True)]
    coord = {str(n): (d["y"], d["x"]) for n, d in G.nodes(data=True)}

    edges = []
    waiting_reverse = {}  # (from, to, osmid, length) of a two-way edge whose reverse we still expect
    merged = selfloops = 0
    for u, v, data in G.edges(data=True):
        u, v = str(u), str(v)
        if u == v:
            selfloops += 1
            continue
        oneway = bool(data.get("oneway", False))
        length = round(float(data["length"]), 1)
        key = (u, v, osmid_key(data.get("osmid")), length)
        if not oneway and waiting_reverse.get(key, 0) > 0:
            waiting_reverse[key] -= 1  # this is the reverse direction of a road already emitted
            merged += 1
            continue

        highway = pick_highway(data.get("highway", "unclassified"))
        tagged = parse_maxspeed(data.get("maxspeed"))
        speed = tagged if tagged is not None else DEFAULT_SPEED_KMH.get(highway, FALLBACK_SPEED_KMH)
        if "geometry" in data:
            geom = [[round(y, 6), round(x, 6)] for x, y in data["geometry"].coords]
        else:
            geom = [[round(coord[u][0], 6), round(coord[u][1], 6)], [round(coord[v][0], 6), round(coord[v][1], 6)]]
        name = pick_name(data.get("name")) or pick_name(data.get("ref")) or ""
        edge = {
            "id": f"e{len(edges)}", "from": u, "to": v, "lengthM": length,
            "highway": highway, "maxspeedKmh": round(speed, 1),
            "speedSource": "tag" if tagged is not None else "default",
            "oneway": oneway, "name": str(name), "geometry": geom,
        }
        # OSM bridge=* (yes / viaduct / ...). After simplification one edge can mix bridge and non-bridge
        # ways; it is marked if any part is a bridge (river crossings are then confirmed geometrically).
        bridge_vals = data.get("bridge")
        bridge_vals = bridge_vals if isinstance(bridge_vals, list) else [bridge_vals]
        if any(isinstance(b, str) and b not in ("no", "") for b in bridge_vals):
            edge["bridge"] = True
        edges.append(edge)
        if not oneway:
            rkey = (v, u, key[2], length)
            waiting_reverse[rkey] = waiting_reverse.get(rkey, 0) + 1

    unmatched = sum(waiting_reverse.values())
    out = {
        "meta": {
            "area": "Central Pune (Kothrud, Deccan, Shivajinagar, Swargate, Camp)",
            "bbox": BBOX,
            "source": "OpenStreetMap contributors (ODbL), downloaded with OSMnx " + ox.__version__,
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "networkType": "drive",
            "component": "largest strongly connected component",
            "defaultSpeedKmh": DEFAULT_SPEED_KMH,
            "fallbackSpeedKmh": FALLBACK_SPEED_KMH,
            "counts": {
                "nodes": len(nodes), "roads": len(edges),
                "oneWayRoads": sum(1 for e in edges if e["oneway"]),
                "twoWayRoads": sum(1 for e in edges if not e["oneway"]),
                "mergedReversePairs": merged, "unmatchedTwoWay": unmatched, "selfLoopsDropped": selfloops,
            },
        },
        "nodes": nodes,
        "edges": edges,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(json.dumps(out["meta"]["counts"]), file=sys.stderr)
    print(f"Wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
