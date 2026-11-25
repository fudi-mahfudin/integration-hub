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
}

type Env = Record<string, string | undefined>;

/**
 * Development source for a clean clone and the simulator. Production sets
 * `HUB_SOURCES`; this key is public and must never be used outside local runs.
 */
const DEV_SOURCES: SourceSystemConfig[] = [
  { id: 'simulator', organizationId: '10000000-0000-4000-8000-000000000000', apiKey: 'dev-source-key' },
];

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

function parseNonNegativeInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}
