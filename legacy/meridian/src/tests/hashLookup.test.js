import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCityGraph } from '../data/cityData.js';
import { createSimulation, activateScenario } from '../services/scenarioService.js';
import { findLocation, findRoad, findRequest, lookupById, normalizeId } from '../algorithms/hashLookup.js';

test('13. lookups return the correct location, road and request', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD');
  assert.equal(findLocation(sim.graph, 'H1').name, 'Meridian General Hospital');
  assert.equal(findRoad(sim.graph, 'RD7').from, 'N9');
  assert.equal(findRequest(sim.requests, 'FLOOD-2').locationId, 'H2');
});

test('IDs are trimmed and case-insensitive; unknown IDs give a clear message', () => {
  const sim = createSimulation();
  assert.equal(normalizeId('  rd7 '), 'RD7');
  assert.equal(lookupById(sim.graph, sim.requests, ' rs1 ').matches[0].kind, 'location');
  const miss = lookupById(sim.graph, sim.requests, 'ZZ9');
  assert.deepEqual(miss.matches, []);
  assert.match(miss.error, /No location, road or request/);
  assert.match(lookupById(sim.graph, sim.requests, '   ').error, /Enter an ID/);
});

test('location, road and request ID formats never collide in the city data', () => {
  const sim = createSimulation();
  activateScenario(sim, 'FLOOD'); activateScenario(sim, 'FIRE');
  const ids = [...sim.graph.locations.keys(), ...sim.graph.roads.keys(), ...sim.requests.list().map((r) => r.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(findLocation(buildCityGraph(), 'nope'), null);
});
