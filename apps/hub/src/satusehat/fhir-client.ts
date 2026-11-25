import type { SatusehatConfig } from '../config.js';
import type { Clock } from '../tokens.js';

/** A non-2xx platform answer. `permanentReason` tells a permanent one from a transient one. */
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what} -> HTTP ${status}`);
  }
}

/** 4xx answers that stay transient whatever their body (#8, #13): 401 after the resend, 408, 429. */
const TRANSIENT_4XX = new Set([401, 408, 429]);
/** 404/410 on a stored remote id means re-search (#13); that path is #35's, so they stay transient for now. */
const DEFERRED_4XX = new Set([404, 410]);

/**
 * The dead-letter reason for a permanent platform answer, or undefined for a
 * transient one. Permanent (#8): a 4xx with an OperationOutcome other than
 * 401/408/429: `PLATFORM_FORBIDDEN` for a 403 (#13), else `PAYLOAD_INVALID`
 * (the platform rejected what local validation let through: a hub bug, #9).
 * The OperationOutcome is not parsed for a finer code (#20).
 */
export function permanentReason(err: unknown): 'PLATFORM_FORBIDDEN' | 'PAYLOAD_INVALID' | undefined {
  if (!(err instanceof PlatformError)) return undefined;
  const { status, body } = err;
  if (status < 400 || status > 499 || TRANSIENT_4XX.has(status) || DEFERRED_4XX.has(status)) return undefined;
  if ((body as { resourceType?: unknown } | null)?.resourceType !== 'OperationOutcome') return undefined;
  return status === 403 ? 'PLATFORM_FORBIDDEN' : 'PAYLOAD_INVALID';
}

/** The fields of a FHIR resource the hub reads back. */
export interface FhirResource {
  resourceType: string;
  id: string;
  meta?: { versionId?: string };
  [field: string]: unknown;
}

/**
 * The SATUSEHAT Adapter's FHIR surface: search, create, read and update, each call with
 * the process's bearer token. One instance per process.
 */
export interface FhirClient {
  /** `GET {fhir}/{type}?{params}`; resolves to the matched resources. */
  search(type: string, params: Record<string, string>): Promise<FhirResource[]>;
  /** `POST {fhir}/{type}`; resolves to the created resource as the platform returns it. */
  create(type: string, body: Record<string, unknown>): Promise<FhirResource>;
  /** `GET {fhir}/{type}/{id}`; a 404 throws `PlatformError` like any non-2xx. */
  read(type: string, id: string): Promise<FhirResource>;
  /** `PUT {fhir}/{type}/{id}`; resolves to the stored resource (with its new `meta.versionId`). */
  update(type: string, id: string, body: Record<string, unknown>): Promise<FhirResource>;
  /**
   * The same client (same token), reporting every FHIR answer's HTTP status to
   * `onStatus`: how an attempt learns its status for the attempt log.
   */
  observe(onStatus: (status: number) => void): FhirClient;
}

/** The platform clients of one process: FHIR and KFA v2 share one token (#14). */
export interface SatusehatClients {
  fhir: FhirClient;
  kfa: KfaClient;
}

export function createSatusehatClients(config: SatusehatConfig, clock: Clock): SatusehatClients {
  const token = createTokenProvider(config, clock);
  return { fhir: createFhirClient(config, clock, token), kfa: createKfaClient(config, token) };
}

/**
 * One authenticated platform request: bearer token, one fresh token and one
 * resend on a 401 (#13), every final status to `onStatus`. A non-2xx answer
 * throws `PlatformError` unless `accept` takes it (e.g. KFA's 404).
 */
async function call(
  token: TokenProvider,
  onStatus: (status: number) => void,
  method: string,
  url: string,
  { body, accept = () => false, mediaType = 'application/fhir+json' }: { body?: unknown; accept?: (status: number) => boolean; mediaType?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const send = (bearer: string) =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: mediaType,
        ...(body === undefined ? {} : { 'content-type': mediaType }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const bearer = await token.get();
  let res = await send(bearer);
  if (res.status === 401) {
    // The token was rejected (expired or revoked): one fresh token, one resend (#13).
    token.invalidate(bearer);
    res = await send(await token.get());
  }
  onStatus(res.status);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    // not JSON: keep the text
  }
  if (!res.ok && !accept(res.status)) throw new PlatformError(res.status, parsed, `${method} ${new URL(url).pathname}`);
  return { status: res.status, body: parsed };
}

export function createFhirClient(config: SatusehatConfig, clock: Clock, token: TokenProvider = createTokenProvider(config, clock)): FhirClient {
  const fhirCall = async (onStatus: (status: number) => void, method: string, path: string, body?: unknown) =>
    (await call(token, onStatus, method, `${config.fhirUrl}${path}`, { body })).body;

  const view = (onStatus: (status: number) => void): FhirClient => ({
    async search(type, params) {
      const bundle = (await fhirCall(onStatus, 'GET', `/${type}?${new URLSearchParams(params)}`)) as {
        entry?: { resource: FhirResource }[];
      };
      return (bundle.entry ?? []).map((e) => e.resource).filter((r) => r.resourceType === type);
    },
    async create(type, body) {
      return (await fhirCall(onStatus, 'POST', `/${type}`, body)) as FhirResource;
    },
    async read(type, id) {
      return (await fhirCall(onStatus, 'GET', `/${type}/${encodeURIComponent(id)}`)) as FhirResource;
    },
    async update(type, id, body) {
      return (await fhirCall(onStatus, 'PUT', `/${type}/${encodeURIComponent(id)}`, body)) as FhirResource;
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
export interface TokenProvider {
  get(): Promise<string>;
  invalidate(token: string): void;
}

function createTokenProvider(config: SatusehatConfig, clock: Clock): TokenProvider {
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

/** A KFA product as KFA v2 describes it (#10): what the drug rules and the MedicationRequest need. */
export interface KfaDetails {
  code: string;
  /** 91 ingredient, 92 virtual product, 93 actual product (GLOSSARY): the code's first two digits (KFA's numbering). */
  level: number;
  display: string;
  /** For an actual product (93): its virtual product (92), KFA's `product_template.kfa_code`. */
  parent92: string | null;
  /** The set of active-ingredient (91) codes (`active_ingredients[].kfa_code`), sorted. */
  ingredients: string[];
  /** The dose form: the unit of a prescribed quantity (#6). */
  doseForm: { code: string; name: string } | null;
}

/** KFA v2 product detail, `{kfa}/products?identifier=kfa&code=…`, with the FHIR client's token (#14). */
export interface KfaClient {
  /** The product, or undefined when KFA does not know the code (404 or no result). Network errors and 5xx throw (transient). */
  product(code: string): Promise<KfaDetails | undefined>;
  /** The same client, reporting every answer's HTTP status to `onStatus`. */
  observe(onStatus: (status: number) => void): KfaClient;
}

interface KfaProductBody {
  result?: {
    kfa_code?: unknown;
    name?: unknown;
    dosage_form?: { code?: unknown; name?: unknown } | null;
    product_template?: { kfa_code?: unknown } | null;
    active_ingredients?: { kfa_code?: unknown }[] | null;
  } | null;
}

function createKfaClient(config: SatusehatConfig, token: TokenProvider): KfaClient {
  const view = (onStatus: (status: number) => void): KfaClient => ({
    async product(code) {
      const url = `${config.kfaUrl}/products?${new URLSearchParams({ identifier: 'kfa', code })}`;
      const res = await call(token, onStatus, 'GET', url, { accept: (s) => s === 404, mediaType: 'application/json' });
      const result = res.status === 404 ? undefined : (res.body as KfaProductBody | null)?.result;
      if (!result || result.kfa_code !== code) return undefined;
      const level = Number(code.slice(0, 2));
      const form = result.dosage_form;
      const ingredients = (result.active_ingredients ?? []).map((i) => i?.kfa_code).filter((c): c is string => typeof c === 'string');
      return {
        code,
        level,
        display: typeof result.name === 'string' ? result.name : code,
        parent92: level === 93 && typeof result.product_template?.kfa_code === 'string' ? result.product_template.kfa_code : null,
        ingredients: [...new Set(ingredients)].sort(),
        doseForm: typeof form?.code === 'string' && typeof form.name === 'string' ? { code: form.code, name: form.name } : null,
      };
    },
    observe: (next) =>
      view((status) => {
        onStatus(status);
        next(status);
      }),
  });
  return view(() => {});
}
