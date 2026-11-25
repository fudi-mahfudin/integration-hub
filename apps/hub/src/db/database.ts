import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/** Table types are added here as migrations create tables. */
export interface Database {}

/**
 * Builds a Kysely instance over a Postgres pool. The pool connects lazily;
 * callers own it and must `destroy()` it. Only the composition root calls this.
 */
export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
