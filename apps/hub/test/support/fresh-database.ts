import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateDatabase } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

/** A throwaway, migrated database next to the shared test database. */
export interface FreshDatabase {
  /** `DATABASE_URL` of the new database. */
  url: string;
  /** Drops the database. Close every hub and worker using it first. */
  drop(): Promise<void>;
}

/**
 * Creates and migrates a throwaway database. Use one whenever a worker runs:
 * a worker claims every ready step it can see, so it must never see other
 * suites' cases. It is also how a test gets "a fresh hub database".
 */
export async function createFreshDatabase(): Promise<FreshDatabase> {
  const base = loadConfig(process.env);
  const name = `hub_t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin(base.databaseUrl, `create database ${name}`);
  const url = new URL(base.databaseUrl);
  url.pathname = `/${name}`;
  await migrateDatabase({ ...base, databaseUrl: url.toString() });
  return {
    url: url.toString(),
    drop: () => admin(base.databaseUrl, `drop database if exists ${name} with (force)`),
  };
}

async function admin(databaseUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
