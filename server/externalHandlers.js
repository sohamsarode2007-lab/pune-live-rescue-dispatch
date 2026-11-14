// Socket / HTTP handlers that call an external service (TomTom, Open-Meteo, OSRM). They never reject: any
// error is logged, the dashboard is told "Refresh failed — keeping last data", and the server keeps
// running (an unhandled rejection in an async socket handler would otherwise exit the process).
export const REFRESH_FAILED = 'Refresh failed — keeping last data.';

const describe = (e) => (e instanceof Error ? e.message : String(e));

// Runs fn; on a throw/rejection logs it and returns onError(e) instead. Never rejects.
export async function guarded(name, fn, { log = console, onError = () => undefined } = {}) {
  try {
    return await fn();
  } catch (e) {
    try { log.error(`${name} failed:`, e); } catch { /* logging must not throw either */ }
    return onError(e);
  }
}

// A failed refresh result for the dashboard: always starts with REFRESH_FAILED, then the reason if known.
const failed = (reason, detail) => ({ ok: false, reason, message: detail ? `${REFRESH_FAILED} ${detail}` : REFRESH_FAILED });

// socket "traffic:refresh" (TomTom). Resolves to the ack payload.
export async function trafficRefresh({ traffic, toDispatch, log = console }, msg) {
  const r = await guarded('traffic:refresh', async () => {
    toDispatch('traffic:updated', { ...traffic.status(), refreshing: true });
    const res = await traffic.refresh({ reason: 'manual', force: msg?.force === true });
    // TOO_SOON is a question for the dispatcher, not a failure
    return res.ok || res.reason === 'TOO_SOON' ? res : { ...res, ...failed(res.reason, res.message) };
  }, { log, onError: () => failed('ERROR') });
  await guarded('traffic:updated broadcast', () => toDispatch('traffic:updated', traffic.status()), { log });
  return r;
}

// socket "flood:glofas" (Open-Meteo Flood API). Resolves to the ack payload.
export async function glofasRefresh({ flood, now, floodChanged, log = console }, msg) {
  const r = await guarded('flood:glofas', async () => {
    const g = await flood.refreshGlofas({ force: true });
    if (!g?.ok) return { ...g, ...failed('FETCH_FAILED', g?.error), error: g?.error ? `${REFRESH_FAILED} ${g.error}` : REFRESH_FAILED };
    if (msg?.apply) flood.applyGlofasSuggestion(now());
    return g;
  }, { log, onError: () => ({ ...failed('ERROR'), error: REFRESH_FAILED }) });
  await guarded('flood:updated broadcast', () => floodChanged(), { log });
  return r;
}

// GET /api/compare (OSRM): ours vs OSRM. Resolves to [httpStatus, body]. (OsrmService already reports an
// unreachable OSRM as { available: false }; what throws here is mostly a bad request, hence 400.)
export async function compareRoutes({ compare, log = console }, from, to) {
  return guarded('compare (OSRM)', async () => [200, await compare.compare(from, to)], {
    log, onError: (e) => [400, { error: describe(e) }],
  });
}
