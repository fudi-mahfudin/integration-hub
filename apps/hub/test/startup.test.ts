import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrations } from '../src/db/migrations/index.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { spawnWorker } from './support/spawn-worker.js';
import { startTcpProxy, type TcpProxy } from './support/tcp-proxy.js';

const builtVersion = Object.keys(migrations).at(-1);

/** Runs `statement` against the database at `url`: how a test makes its schema another build's. */
async function onDatabase(url: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

describe('start-up schema check (#43)', () => {
  let database: FreshDatabase | undefined;

  afterEach(async () => {
    await database?.drop();
    database = undefined;
  });

  it('the hub service refuses to start against a schema a newer build migrated, naming both versions', async () => {
    database = await createFreshDatabase();
    await onDatabase(database.url, `insert into kysely_migration (name, timestamp) values ('9999_from_a_newer_build', now())`);

    await expect(bootHub({ DATABASE_URL: database.url })).rejects.toThrow(
      `the database schema is at migration "9999_from_a_newer_build", but this build is for "${builtVersion}"`,
    );
  });

  it('the worker refuses to start against a schema not yet migrated to its build', async () => {
    database = await createFreshDatabase();
    await onDatabase(database.url, `delete from kysely_migration where name = '${builtVersion}'`);

    await expect(bootWorker({ DATABASE_URL: database.url })).rejects.toThrow(`but this build is for "${builtVersion}"; run the migrate command`);
  });

  it('a worker process exits 1 on a schema mismatch', async () => {
    database = await createFreshDatabase();
    await onDatabase(database.url, `delete from kysely_migration where name = '${builtVersion}'`);

    await expect(spawnWorker({ DATABASE_URL: database.url })).rejects.toThrow('worker process exited with 1');
  });
});

describe('start-up wait for Postgres (#43)', () => {
  let hub: BootedHub | undefined;
  let proxy: TcpProxy | undefined;

  afterEach(async () => {
    await hub?.close();
    hub = undefined;
    await proxy?.cut();
    proxy = undefined;
  });

  it('the hub service waits for a Postgres that is not reachable yet, and starts once it is', async () => {
    const port = await freePort();
    const unreachable = new URL(loadConfig(process.env).databaseUrl);
    unreachable.hostname = '127.0.0.1';
    unreachable.port = String(port);

    const booting = bootHub({ DATABASE_URL: unreachable.toString() });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    proxy = await startTcpProxy(loadConfig(process.env).databaseUrl, port);
    hub = await booting;

    expect((await fetch(new URL('readyz', hub.baseUrl))).status).toBe(200);
  });
});

/** A local TCP port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
