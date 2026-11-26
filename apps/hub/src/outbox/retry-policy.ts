/**
 * When a step whose attempt failed transiently is tried again (#13): full
 * jitter backoff, `Retry-After` honoured and clamped, and a cap on attempts.
 */
export interface RetryPolicy {
  /** The attempt cap: a transient failure of this attempt dead-letters the step with `RETRIES_EXHAUSTED`. */
  maxAttempts: number;
  /** The backoff after attempt n is drawn from [0, min(cap, base·2ⁿ⁻¹)): this is the base. */
  backoffBaseMs: number;
  /** The most any backoff window reaches. */
  backoffCapMs: number;
  /** A `Retry-After` longer than this is clamped to it, never a dead-letter. */
  retryAfterCapMs: number;
}

/**
 * When the step may be claimed again after attempt `attempt` ended
 * transiently at `endedAt`: `max(random(0, min(cap, base·2ⁿ⁻¹)), Retry-After)`,
 * the hint clamped to `retryAfterCapMs`; or `'exhausted'` when `attempt` was
 * the last one allowed. `retryAfter` is the instant the answer's
 * `Retry-After` named (see `parseRetryAfter`); one not after `endedAt` counts
 * as absent. `random` draws from [0, 1).
 */
export function nextAttemptAt(
  policy: RetryPolicy,
  failed: { attempt: number; endedAt: Date; retryAfter: Date | null },
  random: () => number,
): Date | 'exhausted' {
  if (failed.attempt >= policy.maxAttempts) return 'exhausted';
  const window = Math.min(policy.backoffCapMs, policy.backoffBaseMs * 2 ** (failed.attempt - 1));
  const backoffMs = Math.floor(random() * window);
  const hintMs = Math.min(Math.max((failed.retryAfter?.getTime() ?? 0) - failed.endedAt.getTime(), 0), policy.retryAfterCapMs);
  return new Date(failed.endedAt.getTime() + Math.max(backoffMs, hintMs));
}
