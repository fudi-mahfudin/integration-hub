import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { SatusehatConfig } from '../config.js';
import { SatusehatRequestError } from './errors.js';

/** The access token of one process. */
export interface AccessTokens {
  /** A valid bearer token: the cached one while it lasts, else a new one. */
  current(): Promise<string>;
}

/** The token response fields the hub reads; `expires_in` is seconds, sent as a string (#3). */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.string().regex(/^\d+$/, 'must be whole seconds written as a string'),
});

/**
 * client_credentials tokens for one process (#3): fetched on first use,
 * reused until `expires_in` runs out, and fetched single-flight, so
 * concurrent callers share one token request. Early refresh, 401 handling and
 * the shared backoff after a failed token request land with #35.
 */
export function createAccessTokens(deps: {
  config: Pick<SatusehatConfig, 'authUrl' | 'clientId' | 'clientSecret'>;
  clock: Clock;
}): AccessTokens {
  const { config, clock } = deps;
  let cached: { token: string; expiresAtMs: number } | undefined;
  let fetching: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const url = new URL('accesstoken?grant_type=client_credentials', config.authUrl);
    const requestedAtMs = clock().getTime();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new SatusehatRequestError('POST', url, res.status, text);
    const parsed = tokenResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      // The body holds the token itself, so only the problems are reported.
      throw new Error(`the token endpoint answered 200 with an unexpected body: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    cached = { token: parsed.data.access_token, expiresAtMs: requestedAtMs + Number(parsed.data.expires_in) * 1000 };
    return cached.token;
  }

  return {
    current() {
      if (cached && clock().getTime() < cached.expiresAtMs) return Promise.resolve(cached.token);
      fetching ??= fetchToken().finally(() => {
        fetching = undefined;
      });
      return fetching;
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema rejects it and reports why.
    return undefined;
  }
}
