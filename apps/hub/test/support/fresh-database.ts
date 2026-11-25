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
    drop: () => admin(base, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
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
