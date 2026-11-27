import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.js';

/** How long the Postgres check may take before Postgres counts as down (#43). */
const CHECK_TIMEOUT_MS = 1_000;

/** Whether a dependency answered its check. */
export type DependencyStatus = 'up' | 'down';

/** `ready` and `not_ready` say whether Postgres answered; `draining` that the process is shutting down. */
export type ReadinessStatus = 'ready' | 'not_ready' | 'draining';

/**
 * The body of `GET /readyz` (#43). Only Postgres and draining gate it; Redis
 * is reported but never gates (ADR 0003): the process runs without it.
 */
export interface ReadinessReport {
  status: ReadinessStatus;
  checks: {
    postgres: { status: DependencyStatus; latencyMs: number };
    redis: { status: DependencyStatus; gating: false };
  };
}

/** A process's readiness: what `GET /readyz` answers, and the switch that drains it. */
export interface Readiness {
  /** Checks Postgres (`select 1` within 1s) and Redis now. */
  check(): Promise<ReadinessReport>;
  /** From now on the process reports `draining`: it is shutting down. There is no way back. */
  drain(): void;
}

/** The HTTP status `GET /readyz` answers a report with: 200 only when ready. */
export const readinessHttpStatus = (report: ReadinessReport): 200 | 503 => (report.status === 'ready' ? 200 : 503);

/** Builds a process's readiness over its Postgres pool and Redis connection. Only the composition root calls this. */
export function createReadiness(deps: { db: Kysely<Database>; redis: Redis }): Readiness {
  const { db, redis } = deps;
  let draining = false;

  async function postgres(): Promise<ReadinessReport['checks']['postgres']> {
    const startedAt = performance.now();
    const up = await within(CHECK_TIMEOUT_MS, sql`select 1`.execute(db));
    return { status: up ? 'up' : 'down', latencyMs: Math.round(performance.now() - startedAt) };
  }

  async function redisStatus(): Promise<DependencyStatus> {
    // A connection that is not ready fails or queues commands; it counts as down without asking.
    if (redis.status !== 'ready') return 'down';
    return (await within(CHECK_TIMEOUT_MS, redis.ping())) ? 'up' : 'down';
  }

  return {
    async check() {
      const [postgresCheck, redisCheck] = await Promise.all([postgres(), redisStatus()]);
      const status: ReadinessStatus = draining ? 'draining' : postgresCheck.status === 'up' ? 'ready' : 'not_ready';
      return { status, checks: { postgres: postgresCheck, redis: { status: redisCheck, gating: false } } };
    },
    drain() {
      draining = true;
    },
  };
}

/** Whether `promise` resolves within `ms`; a rejection or a later answer counts as no. */
function within(ms: number, promise: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const answered = promise.then(
    () => true,
    // A failed check is the answer: the dependency is down.
    () => false,
  );
  return Promise.race([answered, timedOut]).finally(() => clearTimeout(timer));
}
