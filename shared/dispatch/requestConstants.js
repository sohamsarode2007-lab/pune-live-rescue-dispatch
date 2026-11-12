export const SEVERITY = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
export const REQUEST_STATUS = Object.freeze({ PENDING: 'PENDING', ASSIGNED: 'ASSIGNED', COMPLETED: 'COMPLETED' });
export const DISASTER_TYPES = Object.freeze(['FLOOD', 'FIRE', 'OTHER']);

// Illustrative demonstration weights, NOT validated emergency triage criteria. Configurable.
export const PRIORITY_WEIGHTS = Object.freeze({
  severity: 5,       // multiplied by severity score (1-4)
  people: 2,         // multiplied by min(peopleAffected, peopleCap)
  peopleCap: 10,
  waiting: 1,        // multiplied by min(waitingTimeScore, waitingCap)
  waitingCap: 10,
});
