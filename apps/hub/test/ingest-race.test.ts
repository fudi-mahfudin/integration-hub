import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdempotencyStoreKind } from '../src/config.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { getCase, postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

const CONCURRENT = 20;
const ROUNDS = 5;

/** Fires `CONCURRENT` identical requests at once; resolves to each answer's status, case location and body. */
async function fireIdentical(baseUrl: URL) {
  const idempotencyKey = randomUUID();
  const body = visitStarted();
  return Promise.all(
    Array.from({ length: CONCURRENT }, async () => {
      const res = await postEvent(baseUrl, { idempotencyKey, body });
      return { status: res.status, location: res.headers.get('location'), body: await res.text() };
    }),
  );
}

// ADR 0003: the same race test runs against both stores. The naive Redis-only
// store is expected to FAIL it (`it.fails`): that failure is why it is kept.
const stores: { store: IdempotencyStoreKind; expectFailure: boolean }[] = [
  { store: 'postgres', expectFailure: false },
  { store: 'naive-redis', expectFailure: true },
];

for (const { store, expectFailure } of stores) {
  const test = expectFailure ? it.fails : it;

  describe(`ingest race: IDEMPOTENCY_STORE=${store}`, () => {
    let hub: BootedHub;

    beforeAll(async () => {
      hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, IDEMPOTENCY_STORE: store });
    });

    afterAll(async () => {
      await hub?.close();
    });

    test(`${CONCURRENT} concurrent identical requests open exactly one case and get identical 202 answers`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const answers = await fireIdentical(hub.baseUrl);

        const [first] = answers;
        expect(first?.status).toBe(202);
        for (const answer of answers) expect(answer).toEqual(first);
        // One case: every answer names the same one, and it exists.
        const caseId = first?.location?.split('/').at(-1) ?? '';
        expect((await getCase(hub.baseUrl, caseId)).status).toBe(200);
      }
    });
  });
}

describe('naive-redis store, sequentially', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, IDEMPOTENCY_STORE: 'naive-redis' });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('looks correct: a sequential resend is replayed and key reuse is rejected', async () => {
    const idempotencyKey = randomUUID();
    const body = visitStarted();
    const first = await postEvent(hub.baseUrl, { idempotencyKey, body });

    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body });
    const reuse = await postEvent(hub.baseUrl, { idempotencyKey, body: visitStarted() });

    expect(first.status).toBe(202);
    expect(resend.status).toBe(202);
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
    expect(await resend.text()).toBe(await first.text());
    expect(reuse.status).toBe(422);
  });
});

describe('ingest race: one visit, different keys', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('exactly one is accepted; the rest are 409 EVENT_ALREADY_RECORDED', async () => {
    const body = visitStarted();

    const statuses = await Promise.all(
      Array.from({ length: CONCURRENT }, async () => (await postEvent(hub.baseUrl, { body })).status),
    );

    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONCURRENT - 1);
  });
});
