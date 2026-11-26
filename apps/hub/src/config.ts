import { z } from 'zod';

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
  /** client_credentials pair; one client belongs to one organization. */
  clientId: string;
  clientSecret: string;
}

/** Everything the hub reads from its environment, validated once at startup. */
export interface HubConfig {
  /** Interface the HTTP server binds to. */
  host: string;
  /** TCP port the HTTP server listens on; `0` picks a free port. */
  port: number;
  /** Postgres connection URL (`postgres://` or `postgresql://`). */
  databaseUrl: string;
  /** Redis connection URL (`redis://` or `rediss://`). */
  redisUrl: string;
  /** The source systems allowed to post events, one static API key each. */
  sources: SourceSystemConfig[];
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
  /** How long an idle worker waits before it looks for a claimable step again. */
  workerPollIntervalMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * The source system a clean clone runs with. Its key is public: production
 * must set `HUB_SOURCES`.
 */
const DEV_SOURCES: SourceSystemConfig[] = [{ id: 'simulator', organizationId: '99000001', apiKey: 'dev-source-key' }];

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
  return {
    host: parseHost(env.HOST ?? '0.0.0.0'),
    port: parsePort(env.PORT ?? '3000'),
    databaseUrl: parseUrl('DATABASE_URL', env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub', [
      'postgres:',
      'postgresql:',
    ]),
    redisUrl: parseUrl('REDIS_URL', env.REDIS_URL ?? 'redis://localhost:6379', ['redis:', 'rediss:']),
    sources: env.HUB_SOURCES === undefined ? DEV_SOURCES : parseSources(env.HUB_SOURCES),
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
      // The mock's public development pair; a real platform needs its own (set up through a /wizard).
      clientId: parseNonEmpty('SATUSEHAT_CLIENT_ID', env.SATUSEHAT_CLIENT_ID ?? 'dev-satusehat-client'),
      clientSecret: parseNonEmpty('SATUSEHAT_CLIENT_SECRET', env.SATUSEHAT_CLIENT_SECRET ?? 'dev-satusehat-secret'),
    },
    workerLeaseMs: parsePositiveInt('WORKER_LEASE_MS', env.WORKER_LEASE_MS ?? '90000'),
    workerPollIntervalMs: parsePositiveInt('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS ?? '1000'),
  };
}

function parseHost(raw: string): string {
  if (raw.trim() === '') {
    throw new Error('HOST must be a hostname or IP address, got an empty string');
  }
  return raw;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${raw}"`);
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
