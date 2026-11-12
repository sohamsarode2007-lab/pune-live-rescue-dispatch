// Geohash: a string name for a rectangular cell of the Earth, built by repeatedly halving the
// longitude and latitude ranges (interleaved bits, 5 bits per base-32 character).
// Nearby points usually share a prefix, so a Map keyed by the geohash is a spatial hash grid.
//
// Precision 7 = 35 bits (18 lng + 17 lat): cells of 360/2^18 x 180/2^17 = 0.001373 deg x 0.001373 deg,
// about 145 m (east-west) x 153 m (north-south) at Pune's latitude. Both sides exceed 100 m, so every
// point within 100 m of a query lies in the query's cell or one of its 8 neighbours.
// encode / decode O(precision); neighbour lookup O(1) cells.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const DECODE = new Map([...BASE32].map((c, i) => [c, i]));

export function encode(lat, lng, precision = 7) {
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new Error('lat/lng out of range');
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let hash = '', bits = 0, ch = 0, evenBit = true;           // even bits are longitude
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngLo = mid; } else { ch <<= 1; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
    }
    evenBit = !evenBit;
    if (++bits === 5) { hash += BASE32[ch]; bits = 0; ch = 0; }
  }
  return hash;
}

// The cell a geohash names: { minLat, maxLat, minLng, maxLng }.
export function bounds(hash) {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, evenBit = true;
  for (const c of hash) {
    const v = DECODE.get(c);
    if (v === undefined) throw new Error(`Invalid geohash character: ${c}`);
    for (let b = 4; b >= 0; b--) {
      const bit = (v >> b) & 1;
      if (evenBit) { const mid = (lngLo + lngHi) / 2; if (bit) lngLo = mid; else lngHi = mid; }
      else { const mid = (latLo + latHi) / 2; if (bit) latLo = mid; else latHi = mid; }
      evenBit = !evenBit;
    }
  }
  return { minLat: latLo, maxLat: latHi, minLng: lngLo, maxLng: lngHi };
}

export function decode(hash) {
  const b = bounds(hash);
  return { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
}

// The 8 surrounding cells (same precision), found by stepping one cell size from the centre.
// (Not valid across the poles or the 180th meridian, which is irrelevant for a city.)
export function neighbours(hash) {
  const b = bounds(hash);
  const dLat = b.maxLat - b.minLat, dLng = b.maxLng - b.minLng;
  const c = { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
  const out = [];
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    if (dx || dy) out.push(encode(c.lat + dy * dLat, c.lng + dx * dLng, hash.length));
  }
  return out;
}

// Spatial hash index: geohash cell -> set of ids. query() returns the ids in the 3x3 cell block.
export class GeohashIndex {
  constructor(precision = 7) {
    this.precision = precision;
    this.cells = new Map();   // hash -> Set(id)
    this.where = new Map();   // id -> hash
  }

  add(id, lat, lng) {
    this.remove(id);
    const h = encode(lat, lng, this.precision);
    if (!this.cells.has(h)) this.cells.set(h, new Set());
    this.cells.get(h).add(id);
    this.where.set(id, h);
    return h;
  }

  remove(id) {
    const h = this.where.get(id);
    if (h === undefined) return;
    const set = this.cells.get(h);
    set.delete(id);
    if (set.size === 0) this.cells.delete(h);
    this.where.delete(id);
  }

  query(lat, lng) {
    const h = encode(lat, lng, this.precision);
    const ids = [];
    for (const cell of [h, ...neighbours(h)]) for (const id of this.cells.get(cell) ?? []) ids.push(id);
    return { cell: h, ids };
  }

  get size() { return this.where.size; }
}
