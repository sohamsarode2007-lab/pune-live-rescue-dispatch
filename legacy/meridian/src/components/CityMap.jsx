import React from 'react';

const ROAD_COLOR = { OPEN: '#8b95a7', HIGH_RISK: '#f08a00', BLOCKED: '#dc2626' };
const ROUTE_COLOR = '#2563eb';

function Marker({ loc }) {
  const { x, y, type } = loc;
  switch (type) {
    case 'Hospital':
      return (<g><rect x={x - 15} y={y - 15} width="30" height="30" rx="6" fill="#fff" stroke="#0f766e" strokeWidth="2.5" />
        <path d={`M${x - 3.5} ${y - 9}h7v5.5h5.5v7h-5.5v5.5h-7v-5.5h-5.5v-7h5.5z`} fill="#0f766e" /></g>);
    case 'Shelter':
      return (<g><path d={`M${x - 16} ${y + 12}V${y - 2}L${x} ${y - 15}L${x + 16} ${y - 2}V${y + 12}z`} fill="#16a34a" stroke="#14532d" strokeWidth="1.5" />
        <rect x={x - 4} y={y + 2} width="8" height="10" fill="#fff" /></g>);
    case 'Rescue Station':
      return (<g><circle cx={x} cy={y} r="16" fill="#6d28d9" stroke="#3b0764" strokeWidth="1.5" />
        <text x={x} y={y + 5} textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff">R</text></g>);
    case 'Residential Area':
      return (<g><rect x={x - 13} y={y - 13} width="26" height="26" rx="4" fill="#fde7c3" stroke="#a16207" strokeWidth="1.5" />
        <path d={`M${x - 8} ${y + 1}L${x} ${y - 7}L${x + 8} ${y + 1}V${y + 8}h-16z`} fill="#a16207" /></g>);
    case 'Commercial Area':
      return (<g><rect x={x - 13} y={y - 13} width="26" height="26" rx="4" fill="#dbeafe" stroke="#1d4ed8" strokeWidth="1.5" />
        <text x={x} y={y + 5} textAnchor="middle" fontSize="14" fontWeight="700" fill="#1d4ed8">$</text></g>);
    case 'Disaster Site':
      return (<g><path d={`M${x} ${y - 17}L${x + 17} ${y + 13}H${x - 17}z`} fill="#dc2626" stroke="#7f1d1d" strokeWidth="1.5" />
        <text x={x} y={y + 9} textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff">!</text></g>);
    default:
      return (<g><circle cx={x} cy={y} r="12" fill="#fff" stroke="#475569" strokeWidth="1.5" />
        <text x={x} y={y + 3} textAnchor="middle" fontSize="9" fill="#334155">{loc.id}</text></g>);
  }
}

export default function CityMap({ graph, version, selected, onSelect, route, altRoute, source, destination, requestCounts = {}, traversal = null }) {
  const routeRoads = new Set(route?.reachable ? route.roadIds : []);
  const routeNodes = new Set(route?.reachable ? route.path : []);
  const orderIndex = new Map((traversal?.order ?? []).map((id, i) => [id, i + 1]));
  const altRoads = new Set(altRoute?.reachable ? altRoute.roadIds : []);
  const activate = (kind, id) => (e) => {
    if (e.type === 'click' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ kind, id }); }
  };

  return (
    <div className="map-wrap" data-version={version}>
      <svg viewBox="0 0 1000 700" role="group" aria-label="Map of the fictional city Meridian" className="city-svg">
        <rect width="1000" height="700" fill="#f4f6fa" />
        {/* roads */}
        {[...graph.roads.values()].map((road) => {
          const a = graph.getLocation(road.from), b = graph.getLocation(road.to);
          const isSel = selected?.kind === 'road' && selected.id === road.id;
          const inRoute = routeRoads.has(road.id);
          const label = `Road ${road.id}, ${a.name} to ${b.name}, ${road.distanceKm} km, ${road.status}, penalty ${road.riskPenalty}`;
          return (
            <g key={road.id} role="button" tabIndex={0} aria-label={label} className="road"
               onClick={activate('road', road.id)} onKeyDown={activate('road', road.id)}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth="18" />
              {isSel && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#facc15" strokeWidth="11" strokeLinecap="round" opacity="0.7" />}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ROAD_COLOR[road.status]}
                    strokeWidth={road.status === 'OPEN' ? 4 : 5} strokeLinecap="round"
                    strokeDasharray={road.status === 'BLOCKED' ? '2 9' : undefined} />
              {altRoads.has(road.id) && !inRoute && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#059669" strokeWidth="6" strokeLinecap="round" strokeDasharray="10 7" />}
              {inRoute && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ROUTE_COLOR} strokeWidth="8" strokeLinecap="round" opacity="0.9" />}
              {(isSel || inRoute) && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 7} textAnchor="middle" className="road-label">
                  {road.status === 'BLOCKED' ? 'BLOCKED' : `${road.distanceKm} km` + (road.riskPenalty ? ` +${road.riskPenalty}` : '')}
                </text>
              )}
            </g>
          );
        })}
        {/* locations */}
        {[...graph.locations.values()].map((loc) => {
          const isSel = selected?.kind === 'location' && selected.id === loc.id;
          const isEnd = loc.id === source || loc.id === destination;
          const reached = traversal?.reachable.has(loc.id);
          return (
            <g key={loc.id} role="button" tabIndex={0} className="loc"
               aria-label={`${loc.type}: ${loc.name}${loc.affected ? ', affected' : ''}`}
               opacity={traversal && !reached ? 0.4 : 1}
               onClick={activate('location', loc.id)} onKeyDown={activate('location', loc.id)}>
              {reached && <circle cx={loc.x} cy={loc.y} r="27" fill="none" stroke="#0d9488" strokeWidth="3" />}
              {loc.affected && <circle cx={loc.x} cy={loc.y} r="25" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeDasharray="5 4" />}
              {routeNodes.has(loc.id) && <circle cx={loc.x} cy={loc.y} r="21" fill={ROUTE_COLOR} opacity="0.25" />}
              {(isSel || isEnd) && <circle cx={loc.x} cy={loc.y} r="22" fill="none" stroke={isSel ? '#facc15' : ROUTE_COLOR} strokeWidth="3.5" />}
              <Marker loc={loc} />
              {reached && (<g aria-hidden="true"><circle cx={loc.x + 15} cy={loc.y + 17} r="9" fill="#0d9488" /><text x={loc.x + 15} y={loc.y + 21} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">{orderIndex.get(loc.id)}</text></g>)}
              {requestCounts[loc.id] > 0 && (<g aria-hidden="true"><rect x={loc.x - 23} y={loc.y - 23} width="16" height="16" rx="4" fill="#f59e0b" stroke="#fff" strokeWidth="1.5" /><text x={loc.x - 15} y={loc.y - 11} textAnchor="middle" fontSize="11" fontWeight="700" fill="#1e293b">{requestCounts[loc.id]}</text></g>)}
              {loc.affected && (<g aria-hidden="true"><circle cx={loc.x + 15} cy={loc.y - 15} r="8" fill="#dc2626" /><text x={loc.x + 15} y={loc.y - 11} textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">!</text></g>)}
              {loc.type !== 'Intersection' && (
                <text x={loc.x} y={loc.y + 32} textAnchor="middle" className="loc-label">{loc.name}</text>
              )}
            </g>
          );
        })}
      </svg>
      <Legend />
    </div>
  );
}

function Legend() {
  const line = (c, dash) => (<svg width="34" height="10" aria-hidden="true"><line x1="2" y1="5" x2="32" y2="5" stroke={c} strokeWidth="4" strokeLinecap="round" strokeDasharray={dash} /></svg>);
  return (
    <ul className="legend" aria-label="Map legend">
      <li>{line(ROAD_COLOR.OPEN)} Open road</li>
      <li>{line(ROAD_COLOR.HIGH_RISK)} High-risk road</li>
      <li>{line('#dc2626', '2 7')} Blocked road</li>
      <li>{line(ROUTE_COLOR)} Selected route</li>
      <li>{line('#059669', '6 4')} Alternative route</li>
      <li><b className="lg" style={{ color: '#0f766e' }}>✚</b> Hospital</li>
      <li><b className="lg" style={{ color: '#16a34a' }}>⌂</b> Shelter</li>
      <li><b className="lg" style={{ color: '#6d28d9' }}>Ⓡ</b> Rescue station</li>
      <li><b className="lg" style={{ color: '#a16207' }}>▣</b> Residential</li>
      <li><b className="lg" style={{ color: '#1d4ed8' }}>$</b> Commercial</li>
      <li><b className="lg" style={{ color: '#dc2626' }}>◌</b> Affected location (marked !)</li>
      <li><b className="lg" style={{ color: '#b45309' }}>▪</b> Active requests (count)</li>
      <li><b className="lg" style={{ color: '#0d9488' }}>◯</b> BFS/DFS reachable (visit order)</li>
    </ul>
  );
}
