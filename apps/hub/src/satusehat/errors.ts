import { z } from 'zod';
import type { PlatformApi } from './circuit-breaker.js';

const outcomeCodesSchema = z.object({
  issue: z.array(
    z.object({
      code: z.string().optional(),
      details: z.object({ coding: z.array(z.object({ code: z.string().optional() })).optional() }).optional(),
    }),
  ),
});

/** The issue codes of an OperationOutcome body (e.g. ` (invalid: PAYLOAD_INVALID)`), never its text; empty for any other body. */
function describeOutcome(body: string): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return '';
  }
  const parsed = outcomeCodesSchema.safeParse(value);
  if (!parsed.success || parsed.data.issue.length === 0) return '';
  const issues = parsed.data.issue.map((issue) => {
    const detailCodes = (issue.details?.coding ?? []).flatMap((c) => (c.code === undefined ? [] : [c.code]));
    return [issue.code ?? 'unknown', ...detailCodes].join(': ');
  });
  return ` (${issues.join(', ')})`;
}

/** SATUSEHAT answered a request with a status the adapter did not expect. */
export class SatusehatRequestError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    readonly status: number,
    body: string,
    /** The instant the answer's `Retry-After` named (see `parseRetryAfter`), or null when it had none. */
    readonly retryAfter: Date | null,
  ) {
    // Path only: the query may carry a NIK. Of the body, only the OperationOutcome's codes:
    // its text may echo personal data, and is never logged verbatim (#40).
    super(`SATUSEHAT ${method} ${url.pathname} answered ${status}${describeOutcome(body)}`);
    this.name = 'SatusehatRequestError';
  }
}

/** SATUSEHAT answered with the expected status, but its body is not what the adapter can read. */
export class SatusehatResponseError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    problem: string,
    options?: { cause: unknown },
  ) {
    super(`SATUSEHAT ${method} ${url.pathname} answered with ${problem}`, options);
    this.name = 'SatusehatResponseError';
  }
}

/** SATUSEHAT did not answer a request within its time limit. Transient, like a 5xx. */
export class SatusehatTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    readonly timeoutMs: number,
    options: { cause: unknown },
  ) {
    // Path only: the query may carry identifiers.
    super(`SATUSEHAT ${method} ${url.pathname} did not answer within ${timeoutMs}ms`, options);
    this.name = 'SatusehatTimeoutError';
  }
}

/** A request to SATUSEHAT failed below HTTP: refused, reset or cut. Transient, like a 5xx. */
export class SatusehatNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    options: { cause: unknown },
  ) {
    const cause = options.cause instanceof Error ? (options.cause.cause instanceof Error ? options.cause.cause : options.cause).message : String(options.cause);
    // Path only: the query may carry identifiers.
    super(`SATUSEHAT ${method} ${url.pathname} failed before an answer: ${cause}`, options);
    this.name = 'SatusehatNetworkError';
  }
}

/**
 * The attempt has less time left than one call may take, so the call was not
 * started (#13). Ends the attempt transient, as `attempt_budget_exceeded`.
 */
export class AttemptBudgetExceeded extends Error {
  constructor(
    readonly method: string,
    readonly url: URL,
    readonly remainingMs: number,
    readonly callTimeoutMs: number,
  ) {
    super(`SATUSEHAT ${method} ${url.pathname} not sent: the attempt has ${remainingMs}ms left, less than one call's ${callTimeoutMs}ms`);
    this.name = 'AttemptBudgetExceeded';
  }
}

/** No access token can be had right now: the token endpoint is backing off, or a refresh came too soon. Transient. */
export class TokenUnavailable extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`no SATUSEHAT access token: ${reason}`, options);
    this.name = 'TokenUnavailable';
  }
}

/**
 * The circuit breaker of the platform API a call was for is open, so the call was
 * not sent (#13). Transient: a worker whose breaker opens mid-attempt ends
 * the attempt as failed, and claims nothing more until it closes.
 */
export class CircuitOpen extends Error {
  constructor(readonly api: PlatformApi) {
    super(`SATUSEHAT ${api} call not sent: its circuit breaker is open`);
    this.name = 'CircuitOpen';
  }
}

/**
 * The worker shut down and aborted the attempt's calls at its drain deadline
 * (#43): a call in progress was cut, or a call was not sent. Neither a health
 * failure nor a failure of the step: the worker releases the step as
 * `worker_shutdown`. A write cut this way may have been applied; the next
 * attempt finds it through search-then-create (ADR 0005).
 */
export class AttemptAborted extends Error {
  constructor(method: string, url: URL, options?: { cause: unknown }) {
    super(`SATUSEHAT ${method} ${url.pathname} aborted: the worker is shutting down`, options);
    this.name = 'AttemptAborted';
  }
}
