// ID lookup. Uses JavaScript's built-in Map (the engine's hash table): average O(1) get/has/set.
// NOTE: hashing and collision handling are done by the JavaScript engine, not implemented by us.
export const normalizeId = (raw) => String(raw ?? '').trim().toUpperCase();

export const findLocation = (graph, id) => graph.locations.get(normalizeId(id)) ?? null;
export const findRoad = (graph, id) => graph.roads.get(normalizeId(id)) ?? null;
export const findRequest = (store, id) => store.get(normalizeId(id)) ?? null;

// Looks the ID up in all three maps (ID formats differ, so at most one normally matches).
export function lookupById(graph, store, raw) {
  const id = normalizeId(raw);
  if (!id) return { id, matches: [], error: 'Enter an ID to search, e.g. H1, RD7 or FLOOD-1.' };
  const matches = [];
  const loc = graph.locations.get(id); if (loc) matches.push({ kind: 'location', record: loc });
  const road = graph.roads.get(id); if (road) matches.push({ kind: 'road', record: road });
  const req = store.get(id); if (req) matches.push({ kind: 'request', record: req });
  return { id, matches, error: matches.length ? null : `No location, road or request with ID "${id}".` };
}
