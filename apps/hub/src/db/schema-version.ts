import { sql, type Kysely } from 'kysely';
import type { Database } from './database.js';
import { migrations } from './migrations/index.js';

/** How long a process waits for Postgres at start-up before it gives up (#43). */
const POSTGRES_WAIT_MS = 30_000;
/** How often it tries Postgres meanwhile. */
const POSTGRES_RETRY_MS = 500;

/** The last migration this build was built with: the schema version it runs against. */
const BUILT_VERSION = Object.keys(migrations).at(-1) ?? 'none';

/** Postgres did not answer within the start-up wait. */
export class PostgresUnreachable extends Error {
  constructor(host: string, waitedMs: number, options: { cause: unknown }) {
    super(`Postgres is not reachable at ${host} after waiting ${waitedMs / 1000}s; run \`pnpm deps:up\``, options);
    this.name = 'PostgresUnreachable';
  }
}

/** The database schema is at another migration than the one this build is for (#43). */
export class SchemaMismatch extends Error {
  constructor(applied: string, built: string) {
    super(
      `the database schema is at migration "${applied}", but this build is for "${built}"; ` +
        'run the migrate command, or deploy the build the schema was migrated for',
    );
    this.name = 'SchemaMismatch';
  }
}

/**
 * The start-up check of the hub service and the worker (#43): waits up to 30s
 * for Postgres to answer, then compares the last migration applied with the
 * last one this build has. Throws `PostgresUnreachable` or `SchemaMismatch`;
 * the entry points exit 1 on either. Processes never migrate themselves.
 * `host` names Postgres in the error (host and port only: the URL may hold a password).
 */
export async function awaitSchema(db: Kysely<Database>, host: string): Promise<void> {
  const deadline = Date.now() + POSTGRES_WAIT_MS;
  for (;;) {
    try {
      await sql`select 1`.execute(db);
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw new PostgresUnreachable(host, POSTGRES_WAIT_MS, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, POSTGRES_RETRY_MS));
    }
  }
  const applied = await appliedVersion(db);
  if (applied !== BUILT_VERSION) throw new SchemaMismatch(applied, BUILT_VERSION);
}

/** The last migration applied to the database; `none` when the migration table is missing or empty. */
async function appliedVersion(db: Kysely<Database>): Promise<string> {
  const { rows: tables } = await sql<{ present: boolean }>`select to_regclass('kysely_migration') is not null as present`.execute(db);
  if (!tables[0]?.present) return 'none';
  const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name desc limit 1`.execute(db);
  return rows[0]?.name ?? 'none';
}
