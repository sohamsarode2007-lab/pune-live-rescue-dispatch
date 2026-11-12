"""Elevation (m above sea level) for every graph junction and every river point, from SRTM.

Usage:  .venv\\Scripts\\python scripts/build_elevation.py      (after build_graph.py and build_river.py)
Output: server/data/elevation.json  { meta, nodes: {nodeId: m}, rivers: {name: [[m per point] per line]} }

The `srtm.py` package downloads the SRTM tile once (to ~/.cache/srtm) and works offline after that.
SRTM is a ~30-90 m grid with several metres of vertical error, and over water it measures the surface,
so river elevations are noisy; the server smooths them (non-increasing downstream). Good enough for a
simplified flood model, not for a hydrological prediction.
"""
import json
import os
import sys

import srtm

from osm_common import ROOT

DATA = os.path.join(ROOT, "server", "data")


def main():
    data = srtm.get_data()
    with open(os.path.join(DATA, "pune-central.graph.json"), encoding="utf-8") as f:
        graph = json.load(f)
    with open(os.path.join(DATA, "river.json"), encoding="utf-8") as f:
        rivers = json.load(f)["rivers"]

    nodes, missing = {}, 0
    for n in graph["nodes"]:
        e = data.get_elevation(n["lat"], n["lng"])
        if e is None:
            missing += 1
            continue
        nodes[n["id"]] = int(e)

    river_elev = {}
    for r in rivers:
        river_elev[r["name"]] = [[(lambda e: None if e is None else int(e))(data.get_elevation(lat, lng)) for lat, lng in line] for line in r["lines"]]

    vals = list(nodes.values())
    out = {
        "meta": {"source": "SRTM (NASA), via the srtm.py package; ~30-90 m grid, several m vertical error",
                 "nodes": len(nodes), "missing": missing, "minM": min(vals), "maxM": max(vals)},
        "nodes": nodes,
        "rivers": river_elev,
    }
    with open(os.path.join(DATA, "elevation.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(json.dumps(out["meta"]), file=sys.stderr)
    for name, lines in river_elev.items():
        flat = [e for l in lines for e in l if e is not None]
        print(f"{name}: first {lines[0][0]} last {lines[-1][-1]} min {min(flat)} max {max(flat)}", file=sys.stderr)


if __name__ == "__main__":
    main()
