// Predefined, deterministic scenario data. Nothing here predicts real flood/fire behaviour.
// Road and location IDs refer to src/data/cityData.js (validated by tests).

export const SCENARIOS = {
  FLOOD: {
    id: 'FLOOD',
    name: 'Flood – Riverside district',
    description: 'Western and south-western roads are cut or hazardous. Riverside Colony loses both of its roads.',
    affectedLocations: ['R1', 'N9', 'N13', 'H2'],
    roadChanges: [
      { roadId: 'RD35', status: 'BLOCKED' },   // R1 - N5
      { roadId: 'RD36', status: 'BLOCKED' },   // R1 - N9
      { roadId: 'RD14', status: 'BLOCKED' },   // N5 - N9
      { roadId: 'RD15', status: 'BLOCKED' },   // N9 - N13
      { roadId: 'RD7', status: 'HIGH_RISK' },  // N9 - N10
      { roadId: 'RD10', status: 'HIGH_RISK' }, // N13 - N14
      { roadId: 'RD30', status: 'HIGH_RISK' }, // H2 - N13
    ],
    requests: [
      { id: 'FLOOD-1', locationId: 'R1', severity: 'CRITICAL', peopleAffected: 9, waitingTimeScore: 8 },
      { id: 'FLOOD-2', locationId: 'H2', severity: 'HIGH', peopleAffected: 6, waitingTimeScore: 5 },
      { id: 'FLOOD-3', locationId: 'N9', severity: 'HIGH', peopleAffected: 5, waitingTimeScore: 4 },
      { id: 'FLOOD-4', locationId: 'N13', severity: 'MEDIUM', peopleAffected: 4, waitingTimeScore: 3 },
    ],
  },
  FIRE: {
    id: 'FIRE',
    name: 'Fire – Old Market',
    description: 'Fire incident at Old Market. Nearby roads are hazardous; two are blocked.',
    affectedLocations: ['C1', 'N2', 'N5'],
    roadChanges: [
      { roadId: 'RD16', status: 'BLOCKED' },   // N2 - N6
      { roadId: 'RD28', status: 'BLOCKED' },   // H1 - N2
      { roadId: 'RD43', status: 'HIGH_RISK' }, // C1 - N2
      { roadId: 'RD44', status: 'HIGH_RISK' }, // C1 - N5
      { roadId: 'RD1', status: 'HIGH_RISK' },  // N1 - N2
      { roadId: 'RD4', status: 'HIGH_RISK' },  // N5 - N6
    ],
    requests: [
      { id: 'FIRE-1', locationId: 'C1', severity: 'CRITICAL', peopleAffected: 12, waitingTimeScore: 7 },
      { id: 'FIRE-2', locationId: 'N2', severity: 'HIGH', peopleAffected: 5, waitingTimeScore: 4 },
      { id: 'FIRE-3', locationId: 'N5', severity: 'MEDIUM', peopleAffected: 3, waitingTimeScore: 2 },
    ],
  },
};
