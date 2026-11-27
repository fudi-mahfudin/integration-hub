import { fetch, type Dispatcher } from 'undici';
import type { Clock } from '../clock.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { stopwatch, type PlatformOperation, type PlatformStatusClass, type WorkerMetrics } from '../observability/metrics.js';
import { inSpan } from '../observability/tracing.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RateLimitedApi, RateLimiter } from './rate-limiter.js';
import { AttemptBudgetExceeded, SatusehatNetworkError, SatusehatTimeoutError } from './errors.js';
import type { AccessTokens } from './token.js';

/**
 * One in-process retry of an idempotent read (#13): which call, which try
 * failed (1 or 2), and how. A sub-entry of its attempt, never an attempt.
 */
export interface ReadRetry {
  /** Method and path, without the query, which may carry a NIK. */
  call: string;
  /** Which try failed: 1 or 2 (a third that fails ends the attempt instead). */
  try: number;
  /** How it failed: a transient status, no answer in time, or a refused, reset or cut connection. */
  failure: 'status' | 'timeout' | 'network';
  /** The status answered, for a `status` failure; null otherwise. */
  httpStatus: number | null;
}

/**
 * What every call of one attempt shares: when the attempt's budget runs out,
 * and the read retries it has made so far, which go in its attempt log row.
 */
export interface AttemptCalls {
  /** When the attempt budget runs out: no call starts with less than one call timeout left before it. */
  budgetEndsAt: Date;
  /** The attempt's read retries so far, appended as they happen. */
  readRetries: ReadRetry[];
}

/** One request to SATUSEHAT (FHIR or KFA v2), sent with the process's access token. */
export interface SatusehatRequest {
  /** Which platform API it goes to: its breaker and rate limit apply. */
  api: RateLimitedApi;
  /** A GET is an idempotent read (retried in-process); a POST or PUT is a write (sent once). */
  method: 'GET' | 'POST' | 'PUT';
  /** The full URL, query included. */
  url: URL;
  /** The `Accept` header. */
  accept: string;
  /** A JSON body, sent as `contentType`. */
  body?: { json: unknown; contentType: string };
}

/** An answer read in full. */
export interface SatusehatAnswer {
  /** The HTTP status. */
  status: number;
  /** The whole body, as text. */
  text: string;
  /** The instant the `Retry-After` header names (see `parseRetryAfter`), or null. */
  retryAfter: Date | null;
}

/** Sends requests to SATUSEHAT on behalf of one attempt. */
export interface SatusehatTransport {
  /**
   * Sends `request` and reads the whole answer. With a bearer token; an
   * answer 401 refreshes the token once and resends, without a retry or an
   * attempt (#13). A GET (every GET the hub makes is an idempotent read) that
   * fails transiently (timeout, network error, 5xx, 408, 429) is tried again
   * after 100ms, then 400ms (±20%): three tries in all, each logged in
   * `calls.readRetries`; a write is sent once. No send starts with less than
   * one call timeout left of the attempt's budget: `AttemptBudgetExceeded`;
   * none is sent while its platform API's breaker is open: `CircuitOpen`. Each
   * send waits its turn under the platform API's rate limit, and a 429 holds its calls off.
   * Throws `SatusehatTimeoutError` or `SatusehatNetworkError` for the last
   * failed try, or resolves to the last answer, whatever its status. Each send
   * is its own span (#42), `satusehat.search|create|update` or `kfa.lookup`,
   * its `read_retry` 0 for the first and the read retry's number after it.
   */
  send(calls: AttemptCalls, request: SatusehatRequest): Promise<SatusehatAnswer>;
}

/** The waits before the second and third try of a read (#13). */
const READ_RETRY_DELAYS_MS = [100, 400] as const;
const READ_RETRY_JITTER = 0.2;

/**
 * The instant a `Retry-After` header names, read when the answer arrived at
 * `receivedAt`: delta-seconds from then, or an HTTP date. Null when there is
 * none, or it is past, or it is neither form (#13: such a value counts as absent).
 */
export function parseRetryAfter(header: string | null, receivedAt: Date): Date | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return new Date(receivedAt.getTime() + Number(value) * 1000);
  // Only an HTTP date (it names a weekday) is read as one; Date.parse accepts far more.
  if (!/^[A-Za-z]{3}, /.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) || at <= receivedAt.getTime() ? null : new Date(at);
}

/** Whether an answer's status is a transient failure (#13). */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** The class of an answer's status for the upstream metric (#15): 429 apart from the other 4xx; anything below 400 counts as `2xx`. */
export function statusClassOf(status: number): PlatformStatusClass {
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return '2xx';
}

/** The class of a call that got no answer: `timeout` (the call or connect timeout) or `network`; null for any other error. */
function noAnswerClassOf(err: unknown): PlatformStatusClass | null {
  if (err instanceof SatusehatTimeoutError) return 'timeout';
  if (err instanceof SatusehatNetworkError) return 'network';
  return null;
}

/** Whether undici failed a fetch because connecting outlasted the pool's connect timeout: its own error, not the abort signal's. */
export function isConnectTimeout(err: unknown): boolean {
  return err instanceof Error && err.cause instanceof Error && 'code' in err.cause && err.cause.code === 'UND_ERR_CONNECT_TIMEOUT';
}

/** What kind of call a request is: every FHIR read is a search (the hub reads by business identifier), every KFA v2 call a lookup. */
function operationOf(request: SatusehatRequest): PlatformOperation {
  if (request.api === 'kfa') return 'lookup';
  return request.method === 'GET' ? 'search' : request.method === 'POST' ? 'create' : 'update';
}

/** The span of one try of `request` (#15): FHIR calls by operation, every KFA v2 call a lookup. */
function spanNameOf(request: SatusehatRequest): string {
  return request.api === 'kfa' ? 'kfa.lookup' : `satusehat.${operationOf(request)}`;
}

/** Builds the transport over one process's tokens and connection pool. Only the composition root calls this. */
export function createSatusehatTransport(deps: {
  tokens: AccessTokens;
  /** The process's FHIR and KFA breakers; every exchange reports its health to its platform API's. */
  breakers: Record<SatusehatRequest['api'], CircuitBreaker>;
  /** The rate limit shared by the worker processes. */
  limiter: RateLimiter;
  dispatcher: Dispatcher;
  callTimeoutMs: number;
  /** The connect timeout `dispatcher` was built with, for the error it raises. */
  connectTimeoutMs: number;
  clock: Clock;
  /** Draws from [0, 1), for the read retries' jitter. */
  random: () => number;
  metrics: Pick<WorkerMetrics, 'platformRequest'>;
}): SatusehatTransport {
  const { tokens, breakers, limiter, dispatcher, callTimeoutMs, connectTimeoutMs, clock, random, metrics } = deps;

  function checkBudget(calls: AttemptCalls, request: SatusehatRequest): void {
    const remainingMs = calls.budgetEndsAt.getTime() - clock().getTime();
    if (remainingMs < callTimeoutMs) throw new AttemptBudgetExceeded(request.method, request.url, remainingMs, callTimeoutMs);
  }

  /**
   * One HTTP exchange, once the rate limit lets it go and within the budget,
   * through the platform API's breaker: a 5xx, timeout or network error is a
   * health failure. A 429 holds off the platform API's calls.
   */
  async function exchange(calls: AttemptCalls, request: SatusehatRequest, token: string): Promise<SatusehatAnswer> {
    await limiter.acquire(request.api);
    checkBudget(calls, request);
    const report = breakers[request.api].admit();
    const elapsed = stopwatch();
    const measured = (statusClass: PlatformStatusClass | null) => {
      if (statusClass !== null) metrics.platformRequest(request.api, operationOf(request), statusClass, elapsed());
    };
    let answer: SatusehatAnswer;
    try {
      answer = await exchangeOnce(request, token);
    } catch (err) {
      report(false);
      measured(noAnswerClassOf(err));
      throw err;
    }
    measured(statusClassOf(answer.status));
    report(answer.status < 500);
    if (answer.status === 429) await limiter.holdOff(request.api, answer.retryAfter);
    return answer;
  }

  /** One HTTP exchange within the call timeout, connect to last byte. */
  async function exchangeOnce(request: SatusehatRequest, token: string): Promise<SatusehatAnswer> {
    const { method, url, accept, body } = request;
    const signal = AbortSignal.timeout(callTimeoutMs);
    try {
      const res = await fetch(url, {
        method,
        dispatcher,
        signal,
        headers: { authorization: `Bearer ${token}`, accept, ...(body ? { 'content-type': body.contentType } : {}) },
        ...(body ? { body: JSON.stringify(body.json) } : {}),
      });
      return { status: res.status, text: await res.text(), retryAfter: parseRetryAfter(res.headers.get('retry-after'), clock()) };
    } catch (err) {
      if (signal.aborted) throw new SatusehatTimeoutError(method, url, callTimeoutMs, { cause: err });
      if (isConnectTimeout(err)) {
        throw new SatusehatTimeoutError(method, url, connectTimeoutMs, { cause: err });
      }
      throw new SatusehatNetworkError(method, url, { cause: err });
    }
  }

  /** One try: the exchange, and after a 401 one token refresh and resend. The token comes first, so its fetch (and the rate limit's wait) count against the budget too. */
  async function tryOnce(calls: AttemptCalls, request: SatusehatRequest): Promise<SatusehatAnswer> {
    const token = await tokens.current();
    const answer = await exchange(calls, request, token);
    if (answer.status !== 401) return answer;
    const renewed = await tokens.renew(token);
    // No new token yet (refreshed too recently): the 401 stands, and is transient.
    if (renewed === null) return answer;
    return exchange(calls, request, renewed);
  }

  return {
    async send(calls, request) {
      const tries = request.method === 'GET' ? READ_RETRY_DELAYS_MS.length + 1 : 1;
      const call = `${request.method} ${request.url.pathname}`;
      for (let n = 1; ; n++) {
        let retry: ReadRetry;
        try {
          const answer = await inSpan(spanNameOf(request), { 'http.request.method': request.method, 'url.path': request.url.pathname, read_retry: n - 1 }, async (span) => {
            const answered = await tryOnce(calls, request);
            span.setAttribute('http.response.status_code', answered.status);
            if (answered.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR, message: `answered ${answered.status}` });
            return answered;
          });
          if (n === tries || !isTransientStatus(answer.status)) return answer;
          retry = { call, try: n, failure: 'status', httpStatus: answer.status };
        } catch (err) {
          const failure = err instanceof SatusehatTimeoutError ? 'timeout' : err instanceof SatusehatNetworkError ? 'network' : null;
          if (n === tries || failure === null) throw err;
          retry = { call, try: n, failure, httpStatus: null };
        }
        calls.readRetries.push(retry);
        const delayMs = READ_RETRY_DELAYS_MS[n - 1] ?? 0;
        await sleep(delayMs * (1 - READ_RETRY_JITTER + 2 * READ_RETRY_JITTER * random()));
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
