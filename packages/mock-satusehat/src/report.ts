import type { LogEntry, Report } from './log.js';

export function buildReport(_log: readonly LogEntry[], faultSeed: number | null): Report {
  return { faultSeed, duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] };
}
