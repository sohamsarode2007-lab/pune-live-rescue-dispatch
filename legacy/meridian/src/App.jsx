import React, { useMemo, useState } from 'react';
import { dijkstra } from './algorithms/dijkstra.js';
import { bfs } from './algorithms/bfs.js';
import { dfs } from './algorithms/dfs.js';
import { createSimulation, activateScenario, resetScenario, getAffectedReachability } from './services/scenarioService.js';
import { findAlternativeRoute, compareStations } from './services/routingService.js';
import { saveBaseline } from './services/comparisonService.js';
import { activeRequests } from './services/requestService.js';
import CityMap from './components/CityMap.jsx';
import RoadPanel from './components/RoadPanel.jsx';
import RoutingPanel from './components/RoutingPanel.jsx';
import ScenarioControls from './components/ScenarioControls.jsx';
import ComparisonPanel from './components/ComparisonPanel.jsx';
import RescueRequestPanel from './components/RescueRequestPanel.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import AlgorithmPanel from './components/AlgorithmPanel.jsx';
import StatisticsPanel from './components/StatisticsPanel.jsx';

const SECTIONS = [
  ['dashboard', 'Dashboard'], ['network', 'City Network'], ['scenarios', 'Disaster Scenarios'],
  ['requests', 'Rescue Requests'], ['routing', 'Routing'], ['algorithms', 'Algorithm Demonstrations'], ['results', 'Results / Statistics'],
];

const GUIDE = [
  'Routing: pick a station and a destination to see the Dijkstra route.',
  'Save a baseline, then activate Flood or Fire and compare.',
  'Block or reopen roads by clicking them on the map.',
  'Rescue Requests: select the next request and assign a station.',
  'Algorithm Demonstrations: run BFS or DFS to see reachability.',
  'Results: compare the original network with the current one.',
  'Reset Scenario restores everything.',
];

export default function App() {
  // The simulation holds mutable state; `version` is bumped after each change to re-render and re-derive results.
  const sim = useMemo(createSimulation, []);
  const graph = sim.graph;
  const [version, setVersion] = useState(0);
  const [section, setSection] = useState('dashboard');
  const [selected, setSelected] = useState(null);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [source, setSource] = useState('RS1');
  const [destination, setDestination] = useState('');
  const [run, setRun] = useState(null);           // { kind: 'BFS' | 'DFS', start }
  const bump = () => setVersion((v) => v + 1);

  // Always recomputed from the current graph, so a displayed route or traversal can never be stale.
  const { route, altRoute, stations } = useMemo(() => {
    if (!destination) return { route: null, altRoute: null, stations: null };
    const route = dijkstra(graph, source, destination);
    return { route, altRoute: findAlternativeRoute(graph, source, destination, route), stations: compareStations(graph, destination) };
  }, [graph, version, source, destination]);
  const traversal = useMemo(() => (run ? (run.kind === 'BFS' ? bfs : dfs)(graph, run.start) : null), [graph, version, run]);

  const changeStatus = (roadId, status) => { graph.setRoadStatus(roadId, status); bump(); };
  const onActivate = (id) => { activateScenario(sim, id); setSelectedRequest(null); bump(); };
  const onReset = () => { resetScenario(sim); setSelected(null); setSelectedRequest(null); setRun(null); bump(); };
  const onSaveBaseline = () => { sim.baseline = saveBaseline(graph, source, destination); bump(); };
  const onSelectRequest = (id) => {          // choosing a request also points routing at its incident location
    setSelectedRequest(id);
    const req = sim.requests.get(id);
    if (req) setDestination(req.locationId);
  };
  const onOpen = (kind, id) => {             // from the ID search
    if (kind === 'request') { onSelectRequest(id); setSection('requests'); }
    else { setSelected({ kind, id }); setSection('network'); }
  };

  const counts = graph.countRoadsByStatus();
  const active = activeRequests(sim.requests);
  const requestCounts = {};
  active.forEach((r) => { requestCounts[r.locationId] = (requestCounts[r.locationId] ?? 0) + 1; });
  const aff = getAffectedReachability(graph);
  const cards = [
    ['Total locations', graph.locations.size],
    ['Open roads', counts.OPEN],
    ['Blocked roads', counts.BLOCKED],
    ['High-risk roads', counts.HIGH_RISK],
    ['Active rescue requests', active.length],
    ['Reachable affected locations', `${aff.reachable.length} / ${aff.reachable.length + aff.unreachable.length}`],
  ];

  const panels = {
    dashboard: (
      <>
        <section className="card" aria-labelledby="gd-h">
          <h2 id="gd-h">Quick guide</h2>
          <ol className="guide">{GUIDE.map((t) => <li key={t}>{t}</li>)}</ol>
          <p className="note">Meridian is a fictional city. Disasters, closures and risk penalties are predefined simulation parameters.</p>
        </section>
        <SearchPanel sim={sim} onOpen={onOpen} />
      </>
    ),
    network: <RoadPanel graph={graph} selected={selected} onChangeStatus={changeStatus} />,
    scenarios: <ScenarioControls sim={sim} version={version} onActivate={onActivate} onReset={onReset} />,
    requests: <RescueRequestPanel sim={sim} version={version} selectedId={selectedRequest} onSelect={onSelectRequest} source={source} onChange={bump} />,
    routing: (
      <>
        <RoutingPanel graph={graph} source={source} destination={destination} setSource={setSource}
                      setDestination={setDestination} route={route} altRoute={altRoute} stations={stations} />
        <ComparisonPanel sim={sim} version={version} source={source} destination={destination} onSave={onSaveBaseline} />
      </>
    ),
    algorithms: <AlgorithmPanel sim={sim} version={version} source={source} run={run} traversal={traversal}
                                onRun={(kind, start) => setRun({ kind, start })} onClear={() => setRun(null)} />,
    results: <StatisticsPanel sim={sim} version={version} route={route} />,
  };

  return (
    <div className="app">
      <header>
        <h1>Smart Urban Disaster Rescue Network</h1>
        <p>Evacuation routing simulation – fictional city “Meridian”. Conditions and risk penalties are simulated for classroom use only.</p>
      </header>
      <div className="cards" aria-label="Summary">
        {cards.map(([label, n]) => (<div className="stat" key={label}><span>{label}</span><b>{n}</b></div>))}
      </div>
      <div className="layout">
        <nav className="sidebar" aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} onClick={() => setSection(id)} className={section === id ? 'on' : ''} aria-current={section === id ? 'page' : undefined}>{label}</button>
          ))}
        </nav>
        <CityMap graph={graph} version={version} selected={selected} onSelect={(s) => { setSelected(s); setSection('network'); }}
                 route={route} altRoute={altRoute} source={source} destination={destination}
                 requestCounts={requestCounts} traversal={traversal} />
        <aside>{panels[section]}</aside>
      </div>
    </div>
  );
}
