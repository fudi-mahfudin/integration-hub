/**
 * DI tokens for infrastructure the composition root builds and shares with
 * every module. Always inject with `@Inject(TOKEN)`: tsx/esbuild emit no
 * decorator metadata, so type-based injection would break outside SWC/tsc.
 */
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');
export const CONFIG = Symbol('CONFIG');
export const CLOCK = Symbol('CLOCK');
export const SOURCE_SYSTEMS = Symbol('SOURCE_SYSTEMS');
export const INGEST = Symbol('INGEST');

/** The hub's notion of "now". Injectable so retention can be tested without fake timers. */
export type Clock = () => Date;
