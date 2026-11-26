import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase } from './support/fresh-database.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldPrescriptionWritten, worldVisitStarted } from './support/satusehat.js';

/** A fake KFA v2 that answers 503 to `/down/*`, 404 to `/gone/*`, and never answers `/hung/*`. */
async function bootBrokenKfa(): Promise<{ baseUrl: URL; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/down/')) res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
    if (req.url?.startsWith('/gone/')) res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    // `/hung/*` is left unanswered.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!isAddressInfo(address)) throw new Error(`expected a TCP address, got ${JSON.stringify(address)}`);
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}/`),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}

/** A hub, a worker and a mock whose KFA v2 is the fake at `kfaPath`. */
async function bootWithKfaAt(kfaPath: string) {
  const mock = await bootMock();
  const kfa = await bootBrokenKfa();
  const database = await createFreshDatabase();
  const env = { ...worldEnv(mock.baseUrl, database.url), SATUSEHAT_KFA_URL: new URL(kfaPath, kfa.baseUrl).href, SATUSEHAT_KFA_TIMEOUT_MS: '200' };
  const hub = await bootHub(env);
  const worker = await bootWorker(env);
  return {
    mock,
    hub,
    /** Sends a visit and its prescription; resolves to the case once `done` holds. */
    async run(done: (v: CaseView) => boolean) {
      const visit = worldVisitStarted();
      await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit });
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldPrescriptionWritten(visit.visitId) });
      const view = await waitForCase(hub.baseUrl, res.headers.get('location'), done, { apiKey: WORLD_SOURCE_API_KEY });
      return { visit, view };
    },
    async close() {
      await worker.close();
      await hub.close();
      await database.drop();
      await kfa.close();
      await mock.close();
    },
  };
}

describe('submit prescription when KFA v2 answers 404 for the code', () => {
  let booted: Awaited<ReturnType<typeof bootWithKfaAt>>;

  beforeAll(async () => {
    booted = await bootWithKfaAt('gone/');
  });
  afterAll(async () => booted?.close());

  it('treats the code as unknown to KFA: MAPPING_MISSING, permanent, and sends nothing', async () => {
    const { visit, view } = await booted.run((v) => v.steps[1]?.state === 'dead_lettered');

    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'MAPPING_MISSING' });
    expect(view.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'dead_lettered', errorCode: 'MAPPING_MISSING', httpStatus: 404, valuesUsed: { kfaCode: '92000001' } }),
    ]);
    expect(await booted.mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).toEqual([]);
  });
});

describe.each([
  ['answers 5xx', 'down/', 503],
  ['times out', 'hung/', null],
])('submit prescription when KFA v2 %s', (_, kfaPath, httpStatus) => {
  let booted: Awaited<ReturnType<typeof bootWithKfaAt>>;

  beforeAll(async () => {
    booted = await bootWithKfaAt(kfaPath);
  });
  afterAll(async () => booted?.close());

  it('ends the attempt without an outcome (transient): the step stays in flight, is not dead-lettered, and sends nothing', async () => {
    const { visit, view } = await booted.run((v) => (v.steps[1]?.attemptLog.length ?? 0) > 0);

    expect(view.status).toBe('active');
    expect(view.steps[1]).toMatchObject({ state: 'in_flight', deadLetterReason: null, pins: null });
    expect(view.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'failed', errorCode: null, httpStatus, valuesUsed: { kfaCode: '92000001' } }),
    ]);
    expect(await booted.mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).toEqual([]);
  });
});
