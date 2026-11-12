export const fmt = (n) => (Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString());
export const signed = (n) => (n === null ? '—' : `${n > 0 ? '+' : ''}${fmt(n)}`);

export function fmtDuration(s) {
  if (s == null) return '—';
  const total = Math.round(s);
  const m = Math.floor(total / 60), sec = total % 60;
  return m ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
}

// Simulated clock as hh:mm:ss.
export function fmtClock(s) {
  const t = Math.max(0, Math.floor(s ?? 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

export const fmtKm = (m) => (m == null ? '—' : `${(m / 1000).toFixed(2)} km`);
export const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
