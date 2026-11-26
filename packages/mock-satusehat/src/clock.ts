/**
 * The mock's notion of "now". Injected through the composition root, so tests
 * can cross token expiry and the token throttle window without sleeping.
 */
export type Clock = () => Date;

/** The wall clock, which a standalone mock uses. */
export const systemClock: Clock = () => new Date();
