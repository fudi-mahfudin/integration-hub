import { fetch, type Dispatcher } from 'undici';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { SatusehatConfig } from '../config.js';
import { SatusehatRequestError, SatusehatResponseError, TokenUnavailable } from './errors.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { SharedTokenBackoff } from './token-backoff.js';
import { parseRetryAfter } from './transport.js';

/** The access token of one process. */
export interface AccessTokens {
  /**
   * A bearer token: the cached one until 80% of its life, then a new one
   * (the cached one while it lasts, if a new one can't be had yet). Throws
   * `TokenUnavailable` when there is no valid token and none may be fetched.
   */
  current(): Promise<string>;
  /**
   * After SATUSEHAT answered 401 to `rejected`: a new token (or the one
   * another caller already fetched in its place), or null when the last
   * fetch was too recent to fetch again. Throws `TokenUnavailable` when the
   * token endpoint is backing off or the fetch fails.
   */
  renew(rejected: string): Promise<string | null>;
}

/** The token response fields the hub reads; `expires_in` is seconds, sent as a string (#3). */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.string().regex(/^\d+$/, 'must be whole seconds written as a string'),
});

/** A token is refreshed once this share of its life has passed (#13). */
const REFRESH_AT = 0.8;
/** How long every process leaves the token endpoint alone after a failed request: its documented 1 req/min throttle (#13). */
const BACKOFF_MS = 60_000;

/**
 * client_credentials tokens for one process (#3, #13): fetched on first use,
 * refreshed at 80% of `expires_in` or after a 401, single-flight (concurrent
 * callers share one token request), and at most once per
 * `tokenMinIntervalMs` (successful fetches), so a refresh loop can't hammer
 * the throttled endpoint. After a failed token request, the endpoint is left
 * alone for 60s: `shared` (Redis) tells the other processes, while Redis
 * holds the key, and this process also remembers on its own, in case Redis is down.
 * Token requests go through `breaker`, the auth platform API's: while it is open
 * none is sent (`CircuitOpen`), and that starts no backoff.
 */
export function createAccessTokens(deps: {
  config: Pick<SatusehatConfig, 'authUrl' | 'clientId' | 'clientSecret' | 'callTimeoutMs' | 'tokenMinIntervalMs'>;
  dispatcher: Dispatcher;
  clock: Clock;
  shared: SharedTokenBackoff;
  breaker: CircuitBreaker;
}): AccessTokens {
  const { config, dispatcher, clock, shared, breaker } = deps;
  let cached: { token: string; refreshAtMs: number; expiresAtMs: number } | undefined;
  let lastFetchedAtMs: number | undefined;
  let backoffUntilMs = 0;
  let fetching: Promise<string> | undefined;

  const now = () => clock().getTime();
  const valid = (at: number) => (cached && at < cached.expiresAtMs ? cached.token : undefined);
  const mayFetch = (at: number) => lastFetchedAtMs === undefined || at - lastFetchedAtMs >= config.tokenMinIntervalMs;

  async function request(): Promise<string> {
    const url = new URL('accesstoken?grant_type=client_credentials', config.authUrl);
    const requestedAtMs = now();
    const res = await fetch(url, {
      method: 'POST',
      dispatcher,
      signal: AbortSignal.timeout(config.callTimeoutMs),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new SatusehatRequestError('POST', url, res.status, text, parseRetryAfter(res.headers.get('retry-after'), clock()));
    const parsed = tokenResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      // The body holds the token itself, so only the problems are reported.
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new SatusehatResponseError('POST', url, `an unexpected token body; ${problems.join('; ')}`);
    }
    // Timed from the request, so the token is never thought to last longer than it does.
    const lifeMs = Number(parsed.data.expires_in) * 1000;
    cached = { token: parsed.data.access_token, refreshAtMs: requestedAtMs + lifeMs * REFRESH_AT, expiresAtMs: requestedAtMs + lifeMs };
    lastFetchedAtMs = requestedAtMs;
    return cached.token;
  }

  /** A token request, unless the endpoint is backing off; a failed one starts the backoff everywhere. */
  async function fetchToken(): Promise<string> {
    const sharedUntil = (await shared.until())?.getTime() ?? 0;
    backoffUntilMs = Math.max(backoffUntilMs, sharedUntil);
    if (now() < backoffUntilMs) {
      throw new TokenUnavailable(`the token endpoint is backing off until ${new Date(backoffUntilMs).toISOString()} after a failed request`);
    }
    const report = breaker.admit();
    try {
      const token = await request();
      report(true);
      return token;
    } catch (err) {
      report(!isHealthFailure(err));
      backoffUntilMs = now() + BACKOFF_MS;
      await shared.set(new Date(backoffUntilMs));
      throw new TokenUnavailable(`the token request failed; backing off until ${new Date(backoffUntilMs).toISOString()}`, { cause: err });
    }
  }

  const fetchShared = () =>
    (fetching ??= fetchToken().finally(() => {
      fetching = undefined;
    }));

  return {
    async current() {
      const at = now();
      if (cached && at < cached.refreshAtMs) return cached.token;
      if (!mayFetch(at)) {
        const token = valid(at);
        if (token) return token;
        throw new TokenUnavailable(`the token expired, and the last was fetched less than ${config.tokenMinIntervalMs}ms ago`);
      }
      try {
        return await fetchShared();
      } catch (err) {
        // An early refresh that failed leaves the cached token in use while it lasts.
        const token = valid(now());
        if (token) return token;
        throw err;
      }
    },
    async renew(rejected) {
      if (cached && cached.token !== rejected) return cached.token;
      if (!mayFetch(now())) return null;
      cached = undefined;
      return fetchShared();
    },
  };
}

/** A 5xx, or no answer at all (timeout, network error); an answer the hub can't read is the hub's problem, not the endpoint's health. */
function isHealthFailure(err: unknown): boolean {
  if (err instanceof SatusehatRequestError) return err.status >= 500;
  return !(err instanceof SatusehatResponseError);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema rejects it and reports why.
    return undefined;
  }
}
