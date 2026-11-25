// Public surface for consumers (hub tests, simulator, big run). The server
// itself is exported from `@integration-hub/mock-satusehat/server`.
export { MockClient } from './client.js';
export type { LogEntry, LogQuery, Report } from './log.js';
export type { World, WorldSeed, WorldPatient, WorldPractitioner, WorldLocation, KfaProduct } from './world/world.js';
export { STEP_CODE_SYSTEM, RULE_CODE_SYSTEM } from './templates/outcome.js';
