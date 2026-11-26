import { AttemptBudgetExceeded, SatusehatRequestError } from '../satusehat/errors.js';
import { isTransientStatus } from '../satusehat/transport.js';
import { AttemptFailed } from '../steps/step-outcome.js';

/**
 * How an attempt that threw ends (#13). Transient: the step waits and is
 * tried again, as `failed` or, when the attempt ran out of time,
 * `attempt_budget_exceeded`, with the answer's `Retry-After` if it had one.
 * Permanent: the step is dead-lettered with the code.
 */
export type FailureClass =
  | { transient: 'failed' | 'attempt_budget_exceeded'; retryAfter: Date | null }
  | { permanent: 'PLATFORM_FORBIDDEN' | 'PAYLOAD_INVALID' };

/**
 * Classifies what an attempt threw, looking through a step's `AttemptFailed`.
 * 5xx, 408, 429 and a 401 that a token refresh did not cure are transient;
 * 403 is `PLATFORM_FORBIDDEN`; any other 4xx is a request the platform will
 * never take, a hub bug, `PAYLOAD_INVALID` (a 404/410 on a stored remote id
 * never gets here: the step re-searches). Anything else (timeouts, network
 * errors, an unreadable body, no token, an unforeseen error) is transient:
 * the attempt cap bounds it.
 */
export function classifyFailure(err: unknown): FailureClass {
  const cause = err instanceof AttemptFailed ? err.cause : err;
  if (cause instanceof AttemptBudgetExceeded) return { transient: 'attempt_budget_exceeded', retryAfter: null };
  if (!(cause instanceof SatusehatRequestError)) return { transient: 'failed', retryAfter: null };
  const { status } = cause;
  if (status === 403) return { permanent: 'PLATFORM_FORBIDDEN' };
  // A 401 reaching here survived one token refresh: transient, as #13 decides.
  if (isTransientStatus(status) || status === 401) return { transient: 'failed', retryAfter: cause.retryAfter };
  return { permanent: 'PAYLOAD_INVALID' };
}
