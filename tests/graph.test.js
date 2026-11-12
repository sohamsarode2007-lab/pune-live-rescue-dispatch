import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph, ROAD_STATUS, RISK_PENALTY_S } from '../shared/graph/Graph.js';
import { smallGraph } from './helpers.js';

test('duplicate location and road IDs are rejected; lat/lng are required', () => {
  const g = smallGraph();
  assert.throws(() => g.addLocation({ id: 'A', lat: 18.5, lng: 73.8 }));
  assert.throws(() => g.addLocation({ id: 'Z', x: 0, y: 0 }));            // old canvas coordinates no longer accepted
  assert.throws(() => g.addRoad({ id: 'r1', from: 'A', to: 'B', lengthM: 1, baseTimeS: 1 }));
  assert.throws(() => g.addRoad({ id: 'rx', from: 'A', to: 'ZZ', lengthM: 1, baseTimeS: 1 }));
  assert.throws(() => g.addRoad({ id: 'ry', from: 'A', to: 'B', lengthM: 1, baseTimeS: -1 }));
});

test('two-way roads are stored in both directions with ONE shared road object; one-way only forward', () => {
  const g = smallGraph();
  g.addRoad({ id: 'ow', from: 'B', to: 'C', lengthM: 10, baseTimeS: 1, oneWay: true });
  assert.ok(g.neighbors('A').some((e) => e.to === 'B'));
  assert.ok(g.neighbors('B').some((e) => e.to === 'A'));
  assert.ok(g.neighbors('B').some((e) => e.to === 'C' && e.roadId === 'ow'));
  assert.ok(!g.neighbors('C').some((e) => e.roadId === 'ow'));
  g.setRoadStatus('r1', ROAD_STATUS.BLOCKED);                               // one change closes both directions
  assert.ok(!g.neighbors('A').some((e) => e.roadId === 'r1'));
  assert.ok(!g.neighbors('B').some((e) => e.roadId === 'r1'));
});

test('cost = baseTimeS * trafficFactor + riskPenaltyS, with each component kept separately', () => {
  const g = smallGraph();
  const r = g.getRoad('r1');                                                // baseTimeS 5
  assert.equal(g.roadCost(r), 5);
  g.setTrafficFactor('r1', 2);
  assert.equal(g.travelTimeS(r), 10);
  g.setRoadStatus('r1', ROAD_STATUS.HIGH_RISK);
  assert.equal(r.riskPenaltyS, RISK_PENALTY_S.HIGH_RISK);
  assert.equal(g.effectiveCost(r), 10 + RISK_PENALTY_S.HIGH_RISK);
  g.setRoadStatus('r1', ROAD_STATUS.OPEN, 'MODERATE');
  assert.equal(r.riskPenaltyS, RISK_PENALTY_S.OPEN_MODERATE);
  g.setRoadStatus('r1', ROAD_STATUS.BLOCKED);
  assert.equal(g.effectiveCost(r), null);
  assert.equal(g.neighbors('A').find((e) => e.roadId === 'r1'), undefined);
});

test('traffic factor is clamped to [1, 4] (traffic never makes a road faster than free flow)', () => {
  const g = smallGraph();
  g.setTrafficFactor('r1', 0.3);
  assert.equal(g.getRoad('r1').trafficFactor, 1);
  g.setTrafficFactor('r1', 9);
  assert.equal(g.getRoad('r1').trafficFactor, 4);
  g.setTrafficFactor('r1', NaN);
  assert.equal(g.getRoad('r1').trafficFactor, 1);
});

test('reset restores statuses, risk levels, traffic factors and affected flags', () => {
  const g = smallGraph();
  g.setRoadStatus('r1', 'BLOCKED');
  g.setRoadStatus('r2', 'HIGH_RISK');
  g.setTrafficFactor('r3', 3);
  g.setLocationAffected('A', true);
  g.reset();
  assert.deepEqual(g.countRoadsByStatus(), { OPEN: 5, HIGH_RISK: 0, BLOCKED: 0 });
  assert.equal(g.getRoad('r2').riskPenaltyS, 0);
  assert.equal(g.getRoad('r3').trafficFactor, 1);
  assert.equal(g.getLocation('A').affected, false);
});

test('roadGeometry is returned in the direction of travel', () => {
  const g = new Graph();
  g.addLocation({ id: 'a', lat: 1, lng: 1 });
  g.addLocation({ id: 'b', lat: 2, lng: 2 });
  g.addRoad({ id: 'x', from: 'a', to: 'b', lengthM: 1, baseTimeS: 1, geometry: [[1, 1], [1.5, 1.2], [2, 2]] });
  assert.deepEqual(g.roadGeometry('x', 'a'), [[1, 1], [1.5, 1.2], [2, 2]]);
  assert.deepEqual(g.roadGeometry('x', 'b'), [[2, 2], [1.5, 1.2], [1, 1]]);
  g.addRoad({ id: 'y', from: 'a', to: 'b', lengthM: 1, baseTimeS: 1 });       // no geometry -> straight line
  assert.deepEqual(g.roadGeometry('y', 'b'), [[2, 2], [1, 1]]);
});
