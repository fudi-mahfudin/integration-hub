import { fileURLToPath } from 'node:url';

export interface SourceSystemConfig {
  /** Stable source id; part of every idempotency and case key. */
  id: string;
  /** SATUSEHAT Organization id: the `{org}` in identifier systems, `serviceProvider`. */
  organizationId: string;
  apiKey: string;
}

export type IdempotencyStoreKind = 'postgres' | 'naive-redis';

export interface HubConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** One static API key per source system (#25). */
  sources: SourceSystemConfig[];
  /** `naive-redis` is the deliberately broken store kept to show the race (ADR 0003). */
  idempotencyStore: IdempotencyStoreKind;
  /** Idempotency keys are kept at least this long; never below 24 (API contract). */
  idempotencyRetentionHours: number;
  /** How often the hub service purges expired keys; 0 disables the timer (tests trigger it). */
  idempotencyPurgeIntervalMs: number;
  /** Operator mapping seed (#10), upserted idempotently when the hub service boots. */
  mappingSeedPath: string;
  satusehat: SatusehatConfig;
  worker: WorkerConfig;
}

/** One platform registration (one client per organization, #3). FHIR and KFA have separate bases (#14). */
export interface SatusehatConfig {
  /** OAuth base, e.g. `https://api-satusehat-stg.dto.kemkes.go.id/oauth2/v1`. */
  authUrl: string;
  /** FHIR base, e.g. `https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1`. */
  fhirUrl: string;
  /** KFA v2 base; its host differs from FHIR's on staging (#14). */
  kfaUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface WorkerConfig {
  /** How long a claim holds a step before another worker may take it (#13: 90s). */
  leaseMs: number;
  /** Idle wait between claim attempts when nothing is claimable. */
  pollIntervalMs: number;
  /** Steps one worker process runs at once. */
  concurrency: number;
  /** Placeholder wait before a transient failure is claimable again; #35 replaces it with backoff. */
  retryDelayMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * Development source for a clean clone and the simulator. Production sets
 * `HUB_SOURCES`; this key is public and must never be used outside local runs.
 */
const DEV_SOURCES: SourceSystemConfig[] = [
  // The mock world's organization (packages/mock-satusehat/world/world.json).
  { id: 'simulator', organizationId: '99000001', apiKey: 'dev-source-key' },
];

/** The committed seed for the simulator's source; resolves from `src/` and `dist/` alike. */
const DEFAULT_MAPPING_SEED = fileURLToPath(new URL('../seed/mappings.json', import.meta.url));
/** The mock SATUSEHAT run standalone (`MOCK_PORT` 4010); its credentials are public test values. */
const DEV_PLATFORM = 'http://localhost:4010';

/** Defaults match compose.yaml, so a clean clone needs no .env. */
export function loadConfig(env: Env): HubConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parsePort(env.PORT ?? '3000'),
    databaseUrl: env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    sources: env.HUB_SOURCES === undefined ? DEV_SOURCES : parseSources(env.HUB_SOURCES),
    idempotencyStore: parseStore(env.IDEMPOTENCY_STORE ?? 'postgres'),
    idempotencyRetentionHours: parseRetention(env.IDEMPOTENCY_RETENTION_HOURS ?? '24'),
    idempotencyPurgeIntervalMs: parseNonNegativeInt('IDEMPOTENCY_PURGE_INTERVAL_MS', env.IDEMPOTENCY_PURGE_INTERVAL_MS ?? '3600000'),
    mappingSeedPath: env.MAPPING_SEED_PATH ?? DEFAULT_MAPPING_SEED,
    satusehat: {
      authUrl: trimSlash(env.SATUSEHAT_AUTH_URL ?? `${DEV_PLATFORM}/oauth2/v1`),
      fhirUrl: trimSlash(env.SATUSEHAT_FHIR_URL ?? `${DEV_PLATFORM}/fhir-r4/v1`),
      kfaUrl: trimSlash(env.SATUSEHAT_KFA_URL ?? `${DEV_PLATFORM}/kfa-v2`),
      clientId: env.SATUSEHAT_CLIENT_ID ?? 'mock-client-id',
      clientSecret: env.SATUSEHAT_CLIENT_SECRET ?? 'mock-client-secret',
    },
    worker: {
      leaseMs: parsePositiveInt('WORKER_LEASE_MS', env.WORKER_LEASE_MS ?? '90000'),
      pollIntervalMs: parsePositiveInt('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS ?? '500'),
      concurrency: parsePositiveInt('WORKER_CONCURRENCY', env.WORKER_CONCURRENCY ?? '4'),
      retryDelayMs: parseNonNegativeInt('WORKER_RETRY_DELAY_MS', env.WORKER_RETRY_DELAY_MS ?? '1000'),
    },
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}

function parseSources(raw: string): SourceSystemConfig[] {
  const fail = (why: string): never => {
    throw new Error(`HUB_SOURCES must be a JSON array of {id, organizationId, apiKey}: ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return fail('expected a non-empty array');
  const sources = parsed.map((entry: unknown, i): SourceSystemConfig => {
    const e = entry as Partial<Record<keyof SourceSystemConfig, unknown>>;
    for (const field of ['id', 'organizationId', 'apiKey'] as const) {
      if (typeof e?.[field] !== 'string' || e[field] === '') fail(`entry ${i} needs a non-empty "${field}"`);
    }
    return { id: e.id as string, organizationId: e.organizationId as string, apiKey: e.apiKey as string };
  });
  for (const field of ['id', 'apiKey'] as const) {
    if (new Set(sources.map((s) => s[field])).size !== sources.length) fail(`duplicate "${field}"`);
  }
  return sources;
}

function parseStore(raw: string): IdempotencyStoreKind {
  if (raw === 'postgres' || raw === 'naive-redis') return raw;
  throw new Error(`IDEMPOTENCY_STORE must be "postgres" or "naive-redis", got "${raw}"`);
}

function parseRetention(raw: string): number {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 24) {
    throw new Error(`IDEMPOTENCY_RETENTION_HOURS must be at least 24 (API contract), got "${raw}"`);
  }
  return hours;
}

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}
