/**
 * `npm run demo:naive-race`: shows why Redis alone can't detect duplicate
 * ingests (ADR 0003). Boots the hub in-process once per IDEMPOTENCY_STORE and
 * fires the same `visit.started` with the same Idempotency-Key 20 times at
 * once. Needs `pnpm deps:up` and `pnpm migrate` first. Exits 0 when the
 * demonstration holds (naive answers differ, Postgres answers agree).
 */
import { randomUUID } from 'node:crypto';
import { systemClock } from '../src/clock.js';
import { createHub } from '../src/composition-root.js';
import { loadConfig, type IdempotencyStoreKind } from '../src/config.js';

const CONCURRENT = 20;
const API_KEY = 'demo-source-key';
const SOURCES = JSON.stringify([{ id: 'demo', organizationId: '99000099', apiKey: API_KEY }]);

async function race(store: IdempotencyStoreKind): Promise<Map<string, number>> {
  const config = loadConfig({
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    HUB_SOURCES: SOURCES,
    IDEMPOTENCY_STORE: store,
    IDEMPOTENCY_PURGE_INTERVAL_MS: '0',
  });
  const hub = await createHub(config, { clock: systemClock });
  const baseUrl = await hub.listen();
  try {
    const idempotencyKey = randomUUID();
    // Fake values only.
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
        const res = await fetch(new URL('v1/events', baseUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${API_KEY}`, 'idempotency-key': idempotencyKey, 'content-type': 'application/json' },
          body,
        });
        const answer: unknown = await res.json();
        const code = typeof answer === 'object' && answer !== null && 'code' in answer ? String(answer.code) : 'accepted';
        return `${res.status} ${code}`;
      }),
    );
    const tally = new Map<string, number>();
    for (const answer of answers) tally.set(answer, (tally.get(answer) ?? 0) + 1);
    return tally;
  } finally {
    await hub.close();
  }
}

console.log(`${CONCURRENT} concurrent identical requests (same Idempotency-Key, same body):\n`);
let naiveDiffered = false;
let postgresAgreed = false;
for (const store of ['naive-redis', 'postgres'] as const) {
  const tally = await race(store);
  const identical = tally.size === 1;
  if (store === 'naive-redis') naiveDiffered = !identical;
  else postgresAgreed = identical;
  console.log(`IDEMPOTENCY_STORE=${store}: ${identical ? 'all answers identical' : 'ANSWERS DIFFER'}`);
  for (const [answer, count] of tally) console.log(`  ${String(count).padStart(3)} x ${answer}`);
  console.log();
}
console.log(
  'The naive store checks Redis, accepts, and only then writes the key, so concurrent duplicates all see\n' +
    '"not seen yet"; one wins and the rest get 409 instead of the original 202. The Postgres store inserts the\n' +
    "key row first in the accepting transaction: duplicates wait on its primary key and return the first request's answer instead.",
);
process.exitCode = naiveDiffered && postgresAgreed ? 0 : 1;
