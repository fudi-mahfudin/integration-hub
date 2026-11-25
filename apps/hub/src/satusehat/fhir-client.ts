import type { SatusehatConfig } from '../config.js';
import type { Clock } from '../tokens.js';

/** A non-2xx platform answer. Classification into transient/permanent is #35's. */
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what} -> HTTP ${status}`);
  }
}

/** The fields of a FHIR resource the hub reads back. */
export interface FhirResource {
  resourceType: string;
  id: string;
  meta?: { versionId?: string };
  [field: string]: unknown;
}

/**
 * The SATUSEHAT Adapter's FHIR surface: search and create, each call with
 * the process's bearer token. One instance per process.
 */
export interface FhirClient {
  /** `GET {fhir}/{type}?{params}`; resolves to the matched resources. */
  search(type: string, params: Record<string, string>): Promise<FhirResource[]>;
  /** `POST {fhir}/{type}`; resolves to the created resource as the platform returns it. */
  create(type: string, body: Record<string, unknown>): Promise<FhirResource>;
  /**
   * The same client (same token), reporting every FHIR answer's HTTP status to
   * `onStatus`: how an attempt learns its status for the attempt log.
   */
  observe(onStatus: (status: number) => void): FhirClient;
}

export function createFhirClient(config: SatusehatConfig, clock: Clock): FhirClient {
  const token = createTokenProvider(config, clock);

  const send = async (method: string, path: string, body: unknown, bearer: string) =>
    fetch(`${config.fhirUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/fhir+json',
        ...(body === undefined ? {} : { 'content-type': 'application/fhir+json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const call = async (onStatus: (status: number) => void, method: string, path: string, body?: unknown): Promise<unknown> => {
    const bearer = await token.get();
    let res = await send(method, path, body, bearer);
    if (res.status === 401) {
      // The token was rejected (expired or revoked): one fresh token, one resend (#13).
      token.invalidate(bearer);
      res = await send(method, path, body, await token.get());
    }
    onStatus(res.status);
    const text = await res.text();
    const parsed = text === '' ? null : (JSON.parse(text) as unknown);
    if (!res.ok) throw new PlatformError(res.status, parsed, `${method} ${path.split('?')[0]}`);
    return parsed;
  };

  const view = (onStatus: (status: number) => void): FhirClient => ({
    async search(type, params) {
      const bundle = (await call(onStatus, 'GET', `/${type}?${new URLSearchParams(params)}`)) as {
        entry?: { resource: FhirResource }[];
      };
      return (bundle.entry ?? []).map((e) => e.resource).filter((r) => r.resourceType === type);
    },
    async create(type, body) {
      return (await call(onStatus, 'POST', `/${type}`, body)) as FhirResource;
    },
    observe: (next) =>
      view((status) => {
        onStatus(status);
        next(status);
      }),
  });
  return view(() => {});
}

/**
 * client_credentials token, fetched once and reused by the whole process
 * until it expires or is rejected; concurrent callers share one request.
 * Early refresh at 80%, the 10s fetch floor and the throttle backoff are #35's.
 */
function createTokenProvider(config: SatusehatConfig, clock: Clock): { get(): Promise<string>; invalidate(token: string): void } {
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const fetchToken = async (): Promise<string> => {
    const res = await fetch(`${config.authUrl}/accesstoken?grant_type=client_credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret }),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: string | number } | null;
    if (!res.ok || typeof body?.access_token !== 'string') {
      throw new PlatformError(res.status, null, 'POST /accesstoken');
    }
    // `expires_in` is seconds, sent as a string (#3).
    const seconds = Number(body.expires_in);
    cached = {
      token: body.access_token,
      expiresAt: clock().getTime() + (Number.isFinite(seconds) ? seconds : 0) * 1000,
    };
    return cached.token;
  };

  return {
    get() {
      if (cached && clock().getTime() < cached.expiresAt) return Promise.resolve(cached.token);
      inFlight ??= fetchToken().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    /** Drops `token` if it is still the cached one (concurrent 401s refetch once). */
    invalidate(token) {
      if (cached?.token === token) cached = undefined;
    },
  };
}
