// UI click-through check. Needs (not saved in package.json):
//   npm install --no-save jsdom @testing-library/react @testing-library/dom
// Run from the project root:  node scripts/ui-check.mjs
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'getComputedStyle'])
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const errors = [];
const origErr = console.error; console.error = (...a) => { errors.push(a.join(' ').slice(0, 200)); };

const { createServer } = await import('vite');
const React = (await import('react')).default;
const { render, screen, fireEvent, within, cleanup } = await import('@testing-library/react');
const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const App = (await server.ssrLoadModule('/src/App.jsx')).default;

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : bad++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); };
const txt = () => document.body.textContent.replace(/\s+/g, ' ');
const card = (label) => [...document.querySelectorAll('.stat')].find((s) => s.textContent.startsWith(label))?.querySelector('b').textContent;
const nav = (label) => fireEvent.click(screen.getByRole('button', { name: label }));
const btn = (name) => fireEvent.click(screen.getByRole('button', { name }));

render(React.createElement(App));
check('initial: 27 locations, 46+2 roads open', card('Total locations') === '27' && card('Open roads') === '48', card('Open roads'));
check('dashboard guide shown', txt().includes('Quick guide'));

// routing
nav('Routing');
fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'H2' } });
check('route RS1->H2 computed', txt().includes('RS1 → N5 → N9 → N13 → H2') && txt().includes('Effective cost8.2'), txt().slice(0, 0));
btn(/Save baseline/);
check('baseline saved (comparison table)', txt().includes('Baseline') && txt().includes('Higher risk on old route'));

// flood
nav('Disaster Scenarios'); btn('Activate Flood');
check('flood: 4 blocked, 3 high-risk, 4 requests', card('Blocked roads') === '4' && card('High-risk roads') === '3' && card('Active rescue requests') === '4');
check('flood: reachable affected 3 / 4', card('Reachable affected locations') === '3 / 4');
check('flood panel lists unreachable R1', txt().includes('Unreachable') && txt().includes('R1 (Riverside Colony)'));
nav('Routing');
check('route recalculated after flood', txt().includes('RS1 → N5 → N6 → N10 → N14 → H2') && !txt().includes('RS1 → N5 → N9 → N13 → H2 ') );
check('comparison names closed roads RD14, RD15', txt().includes('RD14, RD15'));
check('activate-flood button disabled while active', (nav('Disaster Scenarios'), screen.getByRole('button', { name: 'Activate Flood' }).disabled));

// requests
nav('Rescue Requests');
btn('Select next request');
check('select next = FLOOD-1', txt().includes('Next by priority: FLOOD-1 (score 46)'));
btn('Assign recommended');
check('unreachable request not assigned, clear error', txt().includes('No route is currently available from any rescue station to Riverside Colony'));
fireEvent.click(screen.getByRole('button', { name: 'FLOOD-2' }));
btn('Assign recommended');
check('FLOOD-2 assigned to a station', /FLOOD-2 assigned to recommended station RS\d/.test(txt()));
btn('Mark completed');
check('FLOOD-2 completed; stats updated', txt().includes('1 completed') && txt().includes('FLOOD-2 marked completed'));
btn('Select next request');
check('next skips completed FLOOD-2 (now FLOOD-1 still top, never FLOOD-2)', !txt().includes('Next by priority: FLOOD-2'));
// add request
fireEvent.change(screen.getByLabelText('Incident location'), { target: { value: 'S1' } });
fireEvent.change(screen.getByLabelText('People affected'), { target: { value: '15' } });
fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'CRITICAL' } });
fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
check('manual request REQ-001 added', txt().includes('Added REQ-001') && card('Active rescue requests') === '4', card('Active rescue requests'));
fireEvent.change(screen.getByLabelText('People affected'), { target: { value: '0' } });
fireEvent.change(screen.getByLabelText('Incident location'), { target: { value: 'S1' } });
fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
check('invalid request (0 people) is blocked by the form, nothing added', card('Active rescue requests') === '4' && !txt().includes('REQ-002'));

// algorithms
nav('Algorithm Demonstrations');
btn('Run BFS');
check('BFS: reached 26 of 27, R1 cut off', txt().includes('26 of 27 locations reached') && txt().includes('Not reachable (cut off): R1'), txt().match(/BFS from[^.]*\./)?.[0]);
check('map shows teal reachability rings', document.querySelectorAll('circle[stroke="#0d9488"]').length >= 26);
btn('Run DFS');
check('DFS also 26 of 27', txt().includes('DFS') && txt().includes('26 of 27 locations reached'));
check('all six algorithm sections with complexity', ['O((V + E) log V)', 'Binary min-heap', 'Emergency priority queue', 'Hash-map lookup'].every((t) => txt().includes(t)));
btn('Clear highlight');
check('highlight cleared', document.querySelectorAll('circle[stroke="#0d9488"]').length === 0);

// manual road edit via map
fireEvent.click(document.querySelector('[aria-label^="Road RD1,"]'));
check('clicking a road opens City Network with its details', txt().includes('Road RD1') && txt().includes('Effective cost2'));
btn('Block');
check('manual block updates counts (4 -> 5 blocked)', card('Blocked roads') === '5');
btn('Reopen');
check('reopen restores 4 blocked', card('Blocked roads') === '4');

// search
nav('Dashboard');
fireEvent.change(screen.getByLabelText('ID to search'), { target: { value: ' flood-2 ' } });
fireEvent.click(screen.getByRole('button', { name: 'Search' }));
check('search finds request FLOOD-2', txt().includes('Request FLOOD-2') && txt().includes('COMPLETED'));
fireEvent.change(screen.getByLabelText('ID to search'), { target: { value: 'h1' } });
fireEvent.click(screen.getByRole('button', { name: 'Search' }));
check('search finds location H1', txt().includes('Meridian General Hospital'));
fireEvent.change(screen.getByLabelText('ID to search'), { target: { value: 'zzz' } });
fireEvent.click(screen.getByRole('button', { name: 'Search' }));
check('search miss gives message', txt().includes('No location, road or request with ID "ZZZ"'));

// results
nav('Results / Statistics');
check('stats table: blocked 0 -> 4, unreachable 0 -> 1', /Blocked roads0\s*4/.test(txt()) && /Unreachable affected locations0\s*1/.test(txt()));
check('stats: saved baseline route vs now', txt().includes('RS1 → H2') && txt().includes('Effective cost8.210.7'), txt().match(/Route RS1[^]{0,200}/)?.[0]);

// reset
nav('Disaster Scenarios'); btn('Reset Scenario');
check('reset: all cards back to original', card('Blocked roads') === '0' && card('High-risk roads') === '0' && card('Active rescue requests') === '0' && card('Reachable affected locations') === '0 / 0');
nav('Routing');
fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'H2' } });
check('reset: baseline cleared', !txt().includes('Higher risk on old route'));
check('reset: route back to original after reset', txt().includes('RS1 → N5 → N9 → N13 → H2'));
const real = errors.filter((e) => !/not wrapped in act|Not implemented/.test(e));
check('no React console errors/warnings', real.length === 0, real.join(' | '));
console.log(`\n${ok} passed, ${bad} failed`);
await server.close(); process.exit(bad ? 1 : 0);
