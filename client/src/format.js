export const fmt = (n) => (Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString());
export const signed = (n) => (n === null ? '—' : `${n > 0 ? '+' : ''}${fmt(n)}`);

export function fmtDuration(s) {
  if (s == null) return '—';
  const total = Math.round(s);
  const m = Math.floor(total / 60), sec = total % 60;
  return m ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
}

export const fmtKm = (m) => (m == null ? '—' : `${(m / 1000).toFixed(2)} km`);
export const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
