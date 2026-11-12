"""Shared helpers for the OSMnx data scripts: cache folder and Overpass mirror fallback."""
import os
import sys
import time

import osmnx as ox

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Must match server/config.js DEMO_BBOX.
BBOX = {"north": 18.56, "south": 18.49, "east": 73.88, "west": 73.80}
BBOX_TUPLE = (BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])  # OSMnx 2.x: (left, bottom, right, top)

# Public Overpass endpoints. The main one is often at capacity; mirrors are tried in order.
OVERPASS_URLS = [
    os.environ.get("OVERPASS_URL", "https://overpass-api.de/api"),
    "https://overpass.kumi.systems/api",
    "https://maps.mail.ru/osm/tools/overpass/api",
    "https://overpass.private.coffee/api",
]


def setup():
    ox.settings.use_cache = True  # responses cached on disk: re-running does not hit the servers again
    ox.settings.cache_folder = os.path.join(ROOT, "scripts", ".osm_cache")
    ox.settings.log_console = False
    ox.settings.requests_timeout = 300


def with_overpass_fallback(fn, attempts_per_url=2):
    """Call fn() with each Overpass mirror until one succeeds (light use: a handful of requests)."""
    last = None
    for url in dict.fromkeys(OVERPASS_URLS):
        ox.settings.overpass_url = url
        for i in range(attempts_per_url):
            try:
                print(f"Overpass: {url} (attempt {i + 1})", file=sys.stderr)
                return fn()
            except Exception as e:  # noqa: BLE001 - network errors come in many types
                last = e
                print(f"  failed: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
                time.sleep(5 * (i + 1))
    raise RuntimeError(f"All Overpass endpoints failed; last error: {last}")
