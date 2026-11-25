import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';

export interface FreshDatabase {
  /** `DATABASE_URL` of the new, migrated database. */
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates and migrates a throwaway database next to the shared test one. Use
 * it whenever a worker runs: a worker claims every ready step in its
 * database, so it must never see other suites' cases. It is also how a test
 * gets "a fresh hub database". Always `drop()` in `afterAll`.
 */
export async function createFreshDatabase(): Promise<FreshDatabase> {
  const base = new URL(loadConfig(process.env).databaseUrl);
  const name = `hub_t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin(base, `CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return {
    url: url.toString(),
    drop: async () => {
      await connectionsGone(base, name);
      await admin(base, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/**
 * pg's `pool.end()` resolves before its sockets have closed; a FORCE drop
 * that terminates one of those mid-goodbye raises an unhandled 57P01 in the
 * closed pool. So wait (briefly) for closed pools to really go away first;
 * FORCE is left for connections that never will (a SIGKILLed worker's).
 */
async function connectionsGone(base: URL, name: string, timeoutMs = 5_000): Promise<void> {
  const client = new pg.Client({ connectionString: base.toString() });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = $1', [name]);
      if (rows[0]!.n === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await client.end();
  }
}

async function admin(base: URL, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: base.toString() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
