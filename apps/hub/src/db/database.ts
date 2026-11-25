import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/** Table types are added here as migrations create tables. */
export interface Database {}

export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
