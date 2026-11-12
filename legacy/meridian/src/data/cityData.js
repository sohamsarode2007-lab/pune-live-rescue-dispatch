// Fictional city "Meridian". Pure data, no React and no algorithms.
// Canvas for SVG rendering: 1000 x 700. Grid of 16 intersections plus 11 facilities.
import { Graph } from '../algorithms/Graph.js';

const L = (id, name, type, x, y) => ({ id, name, type, x, y, affected: false });
const R = (id, from, to, distanceKm, riskLevel = 'LOW') => ({ id, from, to, distanceKm, status: 'OPEN', riskLevel, oneWay: false });

export const LOCATION_TYPES = [
  'Intersection', 'Residential Area', 'Commercial Area',
  'Hospital', 'Shelter', 'Rescue Station', 'Disaster Site',
];

export const locations = [
  // 4x4 intersection grid
  ...[0, 1, 2, 3].flatMap((row) =>
    [0, 1, 2, 3].map((col) =>
      L(`N${row * 4 + col + 1}`, `Junction ${row * 4 + col + 1}`, 'Intersection', 200 + col * 200, 120 + row * 150))),
  L('RS1', 'North Fire & Rescue Station', 'Rescue Station', 60, 120),
  L('RS2', 'Southeast Rescue Station', 'Rescue Station', 940, 570),
  L('H1', 'Meridian General Hospital', 'Hospital', 500, 50),
  L('H2', 'Southwest Medical Centre', 'Hospital', 80, 670),
  L('S1', 'Eastgate Community Shelter', 'Shelter', 900, 195),
  L('S2', 'Southside Relief Shelter', 'Shelter', 500, 660),
  L('R1', 'Riverside Colony', 'Residential Area', 60, 345),
  L('R2', 'Central Heights', 'Residential Area', 500, 345),
  L('R3', 'Lakeview Apartments', 'Residential Area', 930, 420),
  L('C1', 'Old Market', 'Commercial Area', 300, 195),
  L('C2', 'Harbour Plaza', 'Commercial Area', 700, 495),
];

export const roads = [
  // horizontal grid roads
  R('RD1', 'N1', 'N2', 2.0), R('RD2', 'N2', 'N3', 2.5), R('RD3', 'N3', 'N4', 2.0),
  R('RD4', 'N5', 'N6', 1.5), R('RD5', 'N6', 'N7', 2.0), R('RD6', 'N7', 'N8', 2.5, 'MODERATE'),
  R('RD7', 'N9', 'N10', 2.0), R('RD8', 'N10', 'N11', 1.5, 'MODERATE'), R('RD9', 'N11', 'N12', 2.0),
  R('RD10', 'N13', 'N14', 2.5), R('RD11', 'N14', 'N15', 2.0), R('RD12', 'N15', 'N16', 1.5),
  // vertical grid roads
  R('RD13', 'N1', 'N5', 1.5), R('RD14', 'N5', 'N9', 2.0), R('RD15', 'N9', 'N13', 2.5),
  R('RD16', 'N2', 'N6', 2.0), R('RD17', 'N6', 'N10', 1.5), R('RD18', 'N10', 'N14', 2.0),
  R('RD19', 'N3', 'N7', 2.5), R('RD20', 'N7', 'N11', 2.0), R('RD21', 'N11', 'N15', 1.5),
  R('RD22', 'N4', 'N8', 2.0), R('RD23', 'N8', 'N12', 2.5), R('RD24', 'N12', 'N16', 2.0),
  // facility connectors
  R('RD25', 'RS1', 'N1', 1.0),
  R('RD26', 'RS2', 'N16', 1.0), R('RD27', 'RS2', 'N12', 2.0),
  R('RD28', 'H1', 'N2', 1.5), R('RD29', 'H1', 'N3', 1.5),
  R('RD30', 'H2', 'N13', 1.5),
  R('RD31', 'S1', 'N4', 2.0), R('RD32', 'S1', 'N8', 2.0),
  R('RD33', 'S2', 'N14', 1.8), R('RD34', 'S2', 'N15', 1.8),
  R('RD35', 'R1', 'N5', 1.8), R('RD36', 'R1', 'N9', 1.8),
  R('RD37', 'R2', 'N6', 1.5), R('RD38', 'R2', 'N7', 1.5), R('RD39', 'R2', 'N10', 1.5), R('RD40', 'R2', 'N11', 1.5),
  R('RD41', 'R3', 'N12', 1.5), R('RD42', 'R3', 'N16', 2.2),
  R('RD43', 'C1', 'N2', 1.4), R('RD44', 'C1', 'N5', 1.4),
  R('RD45', 'C2', 'N11', 1.4), R('RD46', 'C2', 'N16', 1.4),
  // second connectors so RS1 and H2 are not dependent on a single road
  R('RD47', 'RS1', 'N5', 2.2), R('RD48', 'H2', 'N14', 3.5),
];

// Builds a fresh Graph from the static data (deep-copies records so graphs never share state).
export function buildCityGraph() {
  const g = new Graph();
  locations.forEach((l) => g.addLocation({ ...l }));
  roads.forEach((r) => g.addRoad({ ...r }));
  return g;
}
