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
export const RECONCILIATION = Symbol('RECONCILIATION');
