import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { getSocket, emitAck, clientId } from '../socket.js';
import { trimRoute } from '../useLiveDispatch.js';
import { LANGS, T } from '../i18n.js';
import SosMap from '../components/SosMap.jsx';

const STORE_KEY = 'rescue.sos.incidentId';
const LANG_KEY = 'rescue.sos.lang';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const inBox = (b, p) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;

// Mobile-first SOS page (served at /sos). Simulation only: it never contacts a real emergency service.
export default function SOS() {
  const [lang, setLang] = useState(() => store.get(LANG_KEY) || 'en');
  const t = T[lang];
  const [bbox, setBbox] = useState(null);
  const [hospitals, setHospitals] = useState(new Map());
  const [type, setType] = useState('medical');
  const [severity, setSeverity] = useState('MEDIUM');
  const [people, setPeople] = useState(1);
  const [phase, setPhase] = useState('form');          // form | locating | pick | sending | tracking
  const [notice, setNotice] = useState(null);          // key into T
  const [me, setMe] = useState(null);                  // { lat, lng, accuracyM }
  const [incident, setIncident] = useState(null);
  const [unit, setUnit] = useState(null);
  const [connected, setConnected] = useState(true);
  const [merged, setMerged] = useState(false);
  // Phase 5: crowd "flooded road" report (separate from the SOS itself)
  const [reportMode, setReportMode] = useState(false);
  const [reportPoint, setReportPoint] = useState(null);
  const [reportMsg, setReportMsg] = useState(null);

  const startReport = () => {
    setReportMode(true); setReportMsg(null); setReportPoint(null);
    if (window.isSecureContext && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setReportPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    }
  };
  const sendReport = async () => {
    try {
      const r = await emitAck('road:report', { ...reportPoint, clientId: clientId() });
      if (r.ok) setReportMsg({ ok: true, text: r.blocked ? t.reportClosed(r.name) : t.reportSent(r.name, r.count, r.needed) });
      else setReportMsg({ ok: false, text: r.error === 'OUTSIDE_AREA' ? t.outside : r.error === 'NO_ROAD_NEARBY' ? t.reportNoRoad : r.error === 'TOO_FAST' ? t.tooFast : t.sendFailed });
    } catch { setReportMsg({ ok: false, text: t.sendFailed }); }
  };

  useEffect(() => { store.set(LANG_KEY, lang); document.documentElement.lang = lang; }, [lang]);

  useEffect(() => {
    api.summary().then((s) => setBbox(s.bbox)).catch(() => setNotice('sendFailed'));
    api.facilities().then((f) => setHospitals(new Map(f.facilities.filter((x) => x.kind === 'hospital').map((h) => [h.id, h])))).catch(() => {});
  }, []);

  // Live updates for our incident (re-joined after reloads and reconnects).
  useEffect(() => {
    const s = getSocket();
    const watch = async () => {
      setConnected(true);
      // ?incident=INC-001 re-opens the tracking view of an existing request (e.g. after switching phones)
      const fromUrl = new URLSearchParams(window.location.search).get('incident');
      if (fromUrl && /^INC-\d{1,6}$/.test(fromUrl)) store.set(STORE_KEY, fromUrl);
      const id = store.get(STORE_KEY);
      if (!id) return;
      try {
        const res = await emitAck('sos:watch', { incidentId: id });
        if (res.ok) {
          setIncident(res.incident); setUnit(res.unit);
          setMe({ lat: res.incident.lat, lng: res.incident.lng, accuracyM: res.incident.accuracyM });
          setPhase('tracking');
        } else store.set(STORE_KEY, null);    // server restarted: the old incident is gone
      } catch { /* retried on next connect */ }
    };
    const onIncident = (i) => {
      setIncident((cur) => (cur && cur.id === i.id ? i : cur));
      if (i.id === store.get(STORE_KEY) && !i.unitId) setUnit(null);   // back to PENDING: that unit is no longer coming
    };
    // Track a unit only while it works on THIS caller's incident; once it is reassigned or finished, drop it.
    const onUnit = (u) => setUnit((cur) => (u.incidentId && u.incidentId === store.get(STORE_KEY) ? u : cur && cur.id === u.id ? null : cur));
    const onPos = (p) => setUnit((cur) => {
      if (!cur) return cur;
      const m = p.units.find((x) => x.id === cur.id);
      return m ? { ...cur, lat: m.lat, lng: m.lng, status: m.status, remainingS: m.remainingS, route: trimRoute(cur.route, m) } : cur;
    });
    const onDisconnect = () => setConnected(false);
    s.on('connect', watch); s.on('disconnect', onDisconnect);
    s.on('incident:updated', onIncident); s.on('unit:updated', onUnit); s.on('unit:position', onPos);
    if (s.connected) watch();
    return () => {
      s.off('connect', watch); s.off('disconnect', onDisconnect);
      s.off('incident:updated', onIncident); s.off('unit:updated', onUnit); s.off('unit:position', onPos);
    };
  }, []);

  const send = async (p) => {
    setPhase('sending'); setNotice(null);
    try {
      const res = await emitAck('sos:new', { ...p, type, severity, people, clientId: clientId() });
      if (res.ok) {
        store.set(STORE_KEY, res.incident.id);
        setMerged(Boolean(res.merged));
        setIncident(res.incident); setUnit(res.unit); setMe(p); setPhase('tracking');
      } else if (res.error === 'OUTSIDE_AREA') { setPhase('pick'); setNotice('outside'); }
      else { setPhase(me ? 'pick' : 'form'); setNotice(res.error === 'TOO_FAST' ? 'tooFast' : 'sendFailed'); }
    } catch {
      setPhase('form'); setNotice('sendFailed');
    }
  };

  const pressDanger = () => {
    setNotice(null);
    if (!window.isSecureContext || !navigator.geolocation) { setPhase('pick'); setNotice('notSecure'); return; }
    setPhase('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy) };
        setMe(p);
        if (bbox && !inBox(bbox, p)) { setPhase('pick'); setNotice('outside'); return; }
        send(p);
      },
      () => { setPhase('pick'); setNotice('gpsFailed'); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  const newRequest = () => {
    store.set(STORE_KEY, null);
    setIncident(null); setUnit(null); setMe(null); setPhase('form'); setNotice(null); setMerged(false);
  };

  const etaText = useMemo(() => {
    const s = unit?.remainingS;
    if (s == null) return null;
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m > 0 ? `${m} ${t.min} ${sec} ${t.sec}` : `${sec} ${t.sec}`;
  }, [unit?.remainingS, t]);

  const status = incident?.status;
  const showMap = bbox && (phase === 'pick' || phase === 'tracking');

  return (
    <div className="sos">
      <div className="safety-banner" role="note">{t.banner}</div>
      <header className="sos-head">
        <h1>{t.title}</h1>
        <div className="langs" role="group" aria-label="Language">
          {LANGS.map(([code, label]) => (
            <button key={code} type="button" className={lang === code ? 'on' : ''} onClick={() => setLang(code)} lang={code}>{label}</button>
          ))}
        </div>
      </header>
      {!connected && <div className="alert sos-offline">{t.offline}</div>}

      {reportMode && bbox && (
        <div className="sos-report">
          <p className="sos-tap">{t.reportPick}</p>
          <SosMap bbox={bbox} me={reportPoint} unit={null} picking onPick={(p) => { setReportPoint(p); setReportMsg(null); }} />
          <div className="sos-actions">
            <button type="button" className="danger-btn small" disabled={!reportPoint} onClick={sendReport}>{t.reportSend}</button>
            <button type="button" onClick={() => setReportMode(false)}>{t.back}</button>
          </div>
          {reportMsg && <p className={reportMsg.ok ? 'okmsg sos-secondary' : 'alert sos-secondary'} role="status">{reportMsg.text}</p>}
        </div>
      )}

      {!reportMode && (phase === 'form' || phase === 'locating' || phase === 'sending') && (
        <main className="sos-form">
          <fieldset>
            <legend>{t.typeQ}</legend>
            <div className="seg three">
              {['medical', 'fire', 'flood'].map((k) => (
                <button key={k} type="button" className={`${k} ${type === k ? 'on' : ''}`} aria-pressed={type === k} onClick={() => setType(k)}>
                  <span className="seg-icon">{{ medical: '✚', fire: '🔥', flood: '≈' }[k]}</span>{t[k]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t.sevQ}</legend>
            <div className="seg three">
              {['LOW', 'MEDIUM', 'HIGH'].map((k) => (
                <button key={k} type="button" className={`sev-${k} ${severity === k ? 'on' : ''}`} aria-pressed={severity === k} onClick={() => setSeverity(k)}>{t[k]}</button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t.people}</legend>
            <div className="stepper">
              <button type="button" aria-label="−1" onClick={() => setPeople(Math.max(1, people - 1))} disabled={people <= 1}>−</button>
              <output aria-live="polite">{people}</output>
              <button type="button" aria-label="+1" onClick={() => setPeople(Math.min(50, people + 1))} disabled={people >= 50}>+</button>
            </div>
          </fieldset>
          <button type="button" className="danger-btn" onClick={pressDanger} disabled={phase !== 'form' || !bbox}>
            {phase === 'locating' ? t.locating : phase === 'sending' ? t.sending : t.danger}
          </button>
          {notice && <p className="alert" role="alert">{t[notice]}</p>}
          <div className="sos-secondary" style={{ margin: 0 }}>
            <button type="button" onClick={startReport} disabled={!bbox}>≈ {t.reportRoad}</button>
          </div>
        </main>
      )}

      {phase === 'pick' && (
        <div className="sos-pick">
          {notice && <p className={['outside', 'gpsFailed', 'notSecure'].includes(notice) ? 'hint' : 'alert'} role="status">{t[notice]}</p>}
          <p className="sos-tap">{t.tapMap}</p>
        </div>
      )}

      {showMap && (
        <SosMap bbox={bbox} me={me} accuracyM={me?.accuracyM} unit={phase === 'tracking' ? unit : null}
          picking={phase === 'pick'} onPick={(p) => setMe({ ...p, accuracyM: null })} />
      )}

      {phase === 'pick' && (
        <div className="sos-actions">
          <button type="button" className="danger-btn small" disabled={!me || (bbox && !inBox(bbox, me))} onClick={() => send({ lat: me.lat, lng: me.lng })}>{t.sendHere}</button>
          <button type="button" onClick={() => { setPhase('form'); setNotice(null); }}>←</button>
        </div>
      )}

      {phase === 'tracking' && incident && (
        <section className={`sos-status st-${status}`} aria-live="polite">
          <p className="muted">{t.received} · {t.incident} {incident.id}</p>
          <h2>{t[status]}</h2>
          {merged && <p className="hint">{t.merged}{incident.calls > 1 && <> ({incident.calls} {t.calls})</>}</p>}
          {status === 'PENDING' && incident.queue && <p>{t.queuePos}: <b>{incident.queue.position}</b></p>}
          {unit && status !== 'RESOLVED' && (
            <p>{t.unit}: <b>{t[unit.type]} {unit.id}</b></p>
          )}
          {status === 'EN_ROUTE' && etaText && <p className="sos-eta">{t.eta} <b>{etaText}</b></p>}
          {status === 'TRANSPORTING' && incident.hospitalId && (
            <p>{t.hospital}: <b>{hospitals.get(incident.hospitalId)?.name ?? incident.hospitalId}</b>{etaText && <> · {etaText}</>}</p>
          )}
          {me?.accuracyM > 0 && <p className="muted">{t.accuracy}: ±{me.accuracyM} m</p>}
          <p className="muted">{t.simNote}</p>
          <button type="button" className="ghost" onClick={newRequest}>{t.newRequest}</button>
        </section>
      )}
    </div>
  );
}
