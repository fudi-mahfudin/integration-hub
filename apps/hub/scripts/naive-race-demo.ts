/**
 * `pnpm demo:naive-race` (or `npm run demo:naive-race`): shows why Redis alone
 * cannot detect duplicate ingests (ADR 0003). Boots the hub twice in-process,
 * once per IDEMPOTENCY_STORE, and fires the same `visit.started` with the
 * same Idempotency-Key 20 times at once. Needs `pnpm deps:up`.
 */
import { randomUUID } from 'node:crypto';
import { createHub } from '../src/composition-root.js';
import { loadConfig, type IdempotencyStoreKind } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

const CONCURRENT = 20;
const API_KEY = 'demo-source-key';
const SOURCES = JSON.stringify([{ id: 'demo', organizationId: '10000000-0000-4000-8000-000000000099', apiKey: API_KEY }]);

async function race(store: IdempotencyStoreKind): Promise<Map<string, number>> {
  const config = loadConfig({
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    HUB_SOURCES: SOURCES,
    IDEMPOTENCY_STORE: store,
    IDEMPOTENCY_PURGE_INTERVAL_MS: '0',
  });
  const hub = await createHub(config);
  const baseUrl = await hub.listen();
  try {
    const key = randomUUID();
    const body = JSON.stringify({
      type: 'visit.started',
      visitId: `DEMO-${randomUUID()}`,
      occurredAt: '2026-03-02T08:00:00+07:00',
      data: {
        patient: { nik: '9271060312000001', mrn: 'MRN-DEMO' },
        practitioner: { nik: '7209061211900001' },
        encounterClass: 'AMB',
        locationCode: 'POLI-UMUM',
        startedAt: '2026-03-02T08:00:00+07:00',
      },
    });
    const answers = await Promise.all(
      Array.from({ length: CONCURRENT }, async () => {
        const res = await fetch(`${baseUrl}/v1/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${API_KEY}`, 'idempotency-key': key, 'content-type': 'application/json' },
          body,
        });
        const json = (await res.json()) as { code?: string };
        // Replays carry `Idempotent-Replayed: true` on top of the same status and body.
        return `${res.status} ${json.code ?? 'accepted'}`;
      }),
    );
    const tally = new Map<string, number>();
    for (const a of answers) tally.set(a, (tally.get(a) ?? 0) + 1);
    return tally;
  } finally {
    await hub.close();
  }
}

await runMigrations(loadConfig(process.env).databaseUrl);
console.log(`${CONCURRENT} concurrent identical requests (same Idempotency-Key, same body):\n`);
let naiveFailed = false;
let postgresHeld = false;
for (const store of ['naive-redis', 'postgres'] as const) {
  const tally = await race(store);
  const identical = tally.size === 1;
  if (store === 'naive-redis') naiveFailed = !identical;
  else postgresHeld = identical;
  console.log(`IDEMPOTENCY_STORE=${store}: ${identical ? 'all answers identical' : 'ANSWERS DIFFER'}`);
  for (const [answer, count] of tally) console.log(`  ${String(count).padStart(3)} x ${answer}`);
  console.log();
}
console.log(
  'The naive store checks Redis, accepts, and only then writes the key, so concurrent duplicates all see\n' +
    '"not seen yet"; one wins and the rest get 409 instead of the original 202. The Postgres store inserts the\n' +
    'key row first in the accepting transaction: duplicates wait on its unique index and replay the winner.',
);
process.exitCode = naiveFailed && postgresHeld ? 0 : 1;
