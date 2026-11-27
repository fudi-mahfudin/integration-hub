/**
 * DI tokens for what the composition root builds and hands to controllers.
 * Always inject with `@Inject(TOKEN)`: type-based injection needs decorator
 * metadata, which tsx/esbuild don't emit.
 */
export const DATABASE = Symbol('DATABASE');
export const SOURCE_SYSTEMS = Symbol('SOURCE_SYSTEMS');
export const INGEST = Symbol('INGEST');
export const ADMIN_KEY = Symbol('ADMIN_KEY');
export const CLOCK = Symbol('CLOCK');
export const CASES = Symbol('CASES');
/** The operator's reconciliation runs (#39). */
export const RECONCILIATION = Symbol('RECONCILIATION');
/** The hub service's log (#40). */
export const LOG = Symbol('LOG');
/** The process's metrics: `HubMetrics` in the hub service (#41). */
export const METRICS = Symbol('METRICS');
/** The process's readiness, behind `GET /readyz` (#43). */
export const READINESS = Symbol('READINESS');
