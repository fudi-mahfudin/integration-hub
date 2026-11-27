import { z } from 'zod';
import type { RetryPolicy } from './outbox/retry-policy.js';

/** One registered source system and its static API key (#25). */
export interface SourceSystemConfig {
  /** Stable id; part of every case and idempotency key. */
  id: string;
  /** SATUSEHAT Organization id: the `{org}` in identifier systems. */
  organizationId: string;
  /** The static API key the source system sends as `Authorization: Bearer <key>`. */
  apiKey: string;
}

/**
 * Which idempotency store backs ingest. `naive-redis` is deliberately broken
 * and exists only to show the race of ADR 0003.
 */
export type IdempotencyStoreKind = 'postgres' | 'naive-redis';

/**
 * The platform the SATUSEHAT adapter talks to (`SATUSEHAT_PROFILE`): `mock`
 * (the default, as the URLs' defaults are the mock's) or `live-sandbox`. It
 * picks per-profile defaults: the call timeout's and the rate limits (#13).
 */
export type SatusehatProfile = 'mock' | 'live-sandbox';

/**
 * Where and as whom the SATUSEHAT adapter connects. The defaults point at a
 * mock SATUSEHAT on localhost:3001 with its public development credentials.
 */
export interface SatusehatConfig {
  /** OAuth2 base, e.g. `https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1/`; the token is `accesstoken` under it. */
  authUrl: URL;
  /** FHIR R4 base, e.g. `https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1/`. */
  fhirUrl: URL;
  /**
   * KFA v2 base, configured apart from the FHIR base because the sandbox
   * documents two different hosts for it (#14). Used from the prescription step on.
   */
  kfaUrl: URL;
  /**
   * How long one FHIR, KFA or token call may take in all, connect to last
   * byte, before it is a timeout, which is transient: 10s live, 2s against the
   * mock so the `timeout` fault doesn't stretch the big run (#13).
   */
  callTimeoutMs: number;
  /** How long connecting may take within a call (3s, #13). */
  connectTimeoutMs: number;
  /**
   * The least time between two successful token fetches of one process
   * (10s, #13), so a refresh loop can't hammer the throttled token endpoint.
   */
  tokenMinIntervalMs: number;
  /**
   * How long a platform API's circuit breaker stays open before it admits a
   * probe (30s, #13); configurable so a test can wait less.
   */
  breakerOpenMs: number;
  /**
   * The hub's own request rate to FHIR and KFA v2, shared by all worker
   * processes (#13), with a burst of one second's worth: 100 and 50 rps
   * against the mock, 5 and 2 against the live sandbox, whose limits are
   * undocumented and which is a shared platform.
   */
  rateLimitRps: { fhir: number; kfa: number };
  /** client_credentials pair; one client belongs to one organization. */
  clientId: string;
  clientSecret: string;
}

/** Everything the hub reads from its environment, validated once at startup. */
export interface HubConfig {
  /** Interface the HTTP server binds to. */
  host: string;
  /** TCP port the hub service's HTTP server listens on; `0` picks a free port. */
  port: number;
  /**
   * TCP port a worker serves `/metrics` on (`WORKER_PORT`, default 3002); `0`
   * picks a free port. Two workers on one host each need their own.
   */
  workerPort: number;
  /** Postgres connection URL (`postgres://` or `postgresql://`). */
  databaseUrl: string;
  /** Redis connection URL (`redis://` or `rediss://`). */
  redisUrl: string;
  /** The source systems allowed to post events, one static API key each. */
  sources: SourceSystemConfig[];
  /**
   * The operator's API key (`HUB_ADMIN_API_KEY`): mapping administration,
   * replay and abandonment, and reading any source system's case. No user
   * model (ADR 0001). The default is public: production must set it.
   */
  adminApiKey: string;
  /** How long a case may wait before the case view flags it `stalled` (`STALLED_AFTER_MS`, default 24h, ADR 0007). */
  stalledAfterMs: number;
  /** Which idempotency store backs ingest (`IDEMPOTENCY_STORE`). */
  idempotencyStore: IdempotencyStoreKind;
  /** Idempotency keys are kept at least this many hours; never below 24 (API contract). */
  idempotencyRetentionHours: number;
  /** How often the hub service purges expired keys; `0` turns the timer off (tests trigger the purge). */
  idempotencyPurgeIntervalMs: number;
  /** The SATUSEHAT the worker delivers to. */
  satusehat: SatusehatConfig;
  /** How long a worker's claim on a step lasts before another worker may take it (default 90s, #13). */
  workerLeaseMs: number;
  /**
   * How many worker processes are deployed (`WORKER_PROCESSES`, default 2, as
   * in the big run): while Redis is down, each keeps to this share of the
   * shared rate limit on its own (#13).
   */
  workerProcesses: number;
  /** How long an idle worker waits before it looks for a claimable step again. */
  workerPollIntervalMs: number;
  /**
   * How long one attempt may go on making calls (default 60s, #13): no call
   * starts with less than one call timeout left, and the attempt ends
   * `attempt_budget_exceeded`.
   */
  attemptBudgetMs: number;
  /**
   * Retries of steps whose attempt failed transiently (#13): a cap of 15
   * attempts, the smallest that keeps the big run's expected number of
   * exhausted steps under 0.01 at 30% faults; derivation:
   * https://github.com/fudi-mahfudin/integration-hub/issues/13#issuecomment-7120238873
   * Full-jitter backoff base 1s, cap 60s; `Retry-After` clamped to 300s.
   */
  retry: RetryPolicy;
  /** Reconciliation (#39), executed by the worker processes. */
  reconciliation: ReconciliationConfig;
}

/** When reconciliation runs and which cases it checks by default (#39). */
export interface ReconciliationConfig {
  /**
   * A scheduled run is requested once the last run started longer ago than
   * this (`RECONCILIATION_INTERVAL_MS`, default 15 min); `0` turns the schedule off.
   */
  intervalMs: number;
  /** A run checks the cases whose last change is within this long before it starts (`RECONCILIATION_LOOKBACK_MS`, default 7 days). */
  lookbackMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * The source system a clean clone runs with. Its key is public: production
 * must set `HUB_SOURCES`.
 */
const DEV_SOURCES: SourceSystemConfig[] = [{ id: 'simulator', organizationId: '99000001', apiKey: 'dev-source-key' }];

/** The operator key a clean clone runs with; public, like `DEV_SOURCES`. */
const DEV_ADMIN_API_KEY = 'dev-admin-key';

const sourcesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      organizationId: z.string().min(1),
      apiKey: z.string().min(1),
    }),
  )
  .min(1)
  .refine((sources) => new Set(sources.map((s) => s.id)).size === sources.length, 'duplicate "id"')
  .refine((sources) => new Set(sources.map((s) => s.apiKey)).size === sources.length, 'duplicate "apiKey"');

/**
 * Reads and validates the hub's configuration. Defaults match compose.yaml,
 * so a clean clone needs no .env. Throws on the first invalid variable,
 * naming it.
 */
export function loadConfig(env: Env): HubConfig {
  const profile = parseProfile(env.SATUSEHAT_PROFILE ?? 'mock');
  const sources = env.HUB_SOURCES === undefined ? DEV_SOURCES : parseSources(env.HUB_SOURCES);
  return {
    host: parseHost(env.HOST ?? '0.0.0.0'),
    port: parsePort('PORT', env.PORT ?? '3000'),
    workerPort: parsePort('WORKER_PORT', env.WORKER_PORT ?? '3002'),
    databaseUrl: parseUrl('DATABASE_URL', env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub', [
      'postgres:',
      'postgresql:',
    ]),
    redisUrl: parseUrl('REDIS_URL', env.REDIS_URL ?? 'redis://localhost:6379', ['redis:', 'rediss:']),
    sources,
    adminApiKey: parseAdminApiKey(env.HUB_ADMIN_API_KEY ?? DEV_ADMIN_API_KEY, sources),
    stalledAfterMs: parsePositiveInt('STALLED_AFTER_MS', env.STALLED_AFTER_MS ?? '86400000'),
    idempotencyStore: parseStore(env.IDEMPOTENCY_STORE ?? 'postgres'),
    idempotencyRetentionHours: parseRetention(env.IDEMPOTENCY_RETENTION_HOURS ?? '24'),
    idempotencyPurgeIntervalMs: parseNonNegativeInt(
      'IDEMPOTENCY_PURGE_INTERVAL_MS',
      env.IDEMPOTENCY_PURGE_INTERVAL_MS ?? '3600000',
    ),
    satusehat: {
      authUrl: parseBaseUrl('SATUSEHAT_AUTH_URL', env.SATUSEHAT_AUTH_URL ?? 'http://localhost:3001/oauth2/v1/'),
      fhirUrl: parseBaseUrl('SATUSEHAT_FHIR_URL', env.SATUSEHAT_FHIR_URL ?? 'http://localhost:3001/fhir-r4/v1/'),
      kfaUrl: parseBaseUrl('SATUSEHAT_KFA_URL', env.SATUSEHAT_KFA_URL ?? 'http://localhost:3001/kfa-v2/'),
      callTimeoutMs: parsePositiveInt('SATUSEHAT_CALL_TIMEOUT_MS', env.SATUSEHAT_CALL_TIMEOUT_MS ?? (profile === 'mock' ? '2000' : '10000')),
      connectTimeoutMs: parsePositiveInt('SATUSEHAT_CONNECT_TIMEOUT_MS', env.SATUSEHAT_CONNECT_TIMEOUT_MS ?? '3000'),
      tokenMinIntervalMs: parseNonNegativeInt('SATUSEHAT_TOKEN_MIN_INTERVAL_MS', env.SATUSEHAT_TOKEN_MIN_INTERVAL_MS ?? '10000'),
      rateLimitRps: profile === 'mock' ? { fhir: 100, kfa: 50 } : { fhir: 5, kfa: 2 },
      breakerOpenMs: parsePositiveInt('SATUSEHAT_BREAKER_OPEN_MS', env.SATUSEHAT_BREAKER_OPEN_MS ?? '30000'),
      // The mock's public development pair; a real platform needs its own (set up through a /wizard).
      clientId: parseNonEmpty('SATUSEHAT_CLIENT_ID', env.SATUSEHAT_CLIENT_ID ?? 'dev-satusehat-client'),
      clientSecret: parseNonEmpty('SATUSEHAT_CLIENT_SECRET', env.SATUSEHAT_CLIENT_SECRET ?? 'dev-satusehat-secret'),
    },
    workerLeaseMs: parsePositiveInt('WORKER_LEASE_MS', env.WORKER_LEASE_MS ?? '90000'),
    workerProcesses: parsePositiveInt('WORKER_PROCESSES', env.WORKER_PROCESSES ?? '2'),
    workerPollIntervalMs: parsePositiveInt('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS ?? '1000'),
    attemptBudgetMs: parsePositiveInt('ATTEMPT_BUDGET_MS', env.ATTEMPT_BUDGET_MS ?? '60000'),
    retry: {
      maxAttempts: parsePositiveInt('RETRY_MAX_ATTEMPTS', env.RETRY_MAX_ATTEMPTS ?? '15'),
      backoffBaseMs: parsePositiveInt('RETRY_BACKOFF_BASE_MS', env.RETRY_BACKOFF_BASE_MS ?? '1000'),
      backoffCapMs: parsePositiveInt('RETRY_BACKOFF_CAP_MS', env.RETRY_BACKOFF_CAP_MS ?? '60000'),
      retryAfterCapMs: 300_000,
    },
    reconciliation: {
      intervalMs: parseNonNegativeInt('RECONCILIATION_INTERVAL_MS', env.RECONCILIATION_INTERVAL_MS ?? '900000'),
      lookbackMs: parsePositiveInt('RECONCILIATION_LOOKBACK_MS', env.RECONCILIATION_LOOKBACK_MS ?? '604800000'),
    },
  };
}

function parseProfile(raw: string): SatusehatProfile {
  if (raw === 'mock' || raw === 'live-sandbox') return raw;
  throw new Error(`SATUSEHAT_PROFILE must be "mock" or "live-sandbox", got "${raw}"`);
}

function parseHost(raw: string): string {
  if (raw.trim() === '') {
    throw new Error('HOST must be a hostname or IP address, got an empty string');
  }
  return raw;
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}

function parseUrl(name: string, raw: string, protocols: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value may hold a password, so it is not echoed back.
    throw new Error(`${name} must be a URL starting with ${protocols.join(' or ')}//, got an unparseable value`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}, got "${url.protocol}"`);
  }
  return raw;
}

function parseSources(raw: string): SourceSystemConfig[] {
  const expected = 'HUB_SOURCES must be a non-empty JSON array of {id, organizationId, apiKey}';
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // The value holds API keys, so it is not echoed back.
    throw new Error(`${expected}, got invalid JSON`);
  }
  const parsed = sourcesSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${expected}; ${problems.join('; ')}`);
  }
  return parsed.data;
}

function parseAdminApiKey(raw: string, sources: readonly SourceSystemConfig[]): string {
  // The value is a secret, so it is not echoed back.
  if (raw.trim() === '') throw new Error('HUB_ADMIN_API_KEY must not be empty');
  if (sources.some((s) => s.apiKey === raw)) throw new Error('HUB_ADMIN_API_KEY must differ from every HUB_SOURCES apiKey');
  return raw;
}

function parseStore(raw: string): IdempotencyStoreKind {
  if (raw === 'postgres' || raw === 'naive-redis') return raw;
  throw new Error(`IDEMPOTENCY_STORE must be "postgres" or "naive-redis", got "${raw}"`);
}

function parseRetention(raw: string): number {
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 24) {
    throw new Error(`IDEMPOTENCY_RETENTION_HOURS must be an integer of at least 24 (API contract), got "${raw}"`);
  }
  return hours;
}

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** An http(s) base URL; a missing trailing slash is added so relative paths resolve under it. */
function parseBaseUrl(name: string, raw: string): URL {
  parseUrl(name, raw, ['http:', 'https:']);
  return new URL(raw.endsWith('/') ? raw : `${raw}/`);
}

function parseNonEmpty(name: string, raw: string): string {
  // The value may be a secret, so it is not echoed back.
  if (raw.trim() === '') throw new Error(`${name} must not be empty`);
  return raw;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}
