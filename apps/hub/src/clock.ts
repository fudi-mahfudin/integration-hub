/**
 * The hub's notion of "now". Injected through the composition root, so tests
 * can move time (idempotency-key retention) without fake timers.
 */
export type Clock = () => Date;

/** The wall clock, which production uses. */
export const systemClock: Clock = () => new Date();
