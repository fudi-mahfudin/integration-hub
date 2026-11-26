import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldPrescriptionWritten, worldVisitStarted, type BootedMock } from './support/satusehat.js';

/** A fake KFA v2 that answers 503 to `/down/*` and never answers `/hung/*`. */
async function bootBrokenKfa(): Promise<{ baseUrl: URL; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/down/')) res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
    // `/hung/*` is left unanswered.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo; // listen() on a TCP port yields an AddressInfo
  return {
    baseUrl: new URL(`http://127.0.0.1:${port}/`),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe.each([
  ['answers 5xx', 'down/', 503],
  ['times out', 'hung/', null],
])('submit prescription when KFA v2 %s', (_, kfaPath, httpStatus) => {
  let mock: BootedMock;
  let kfa: Awaited<ReturnType<typeof bootBrokenKfa>>;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    kfa = await bootBrokenKfa();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), SATUSEHAT_KFA_URL: new URL(kfaPath, kfa.baseUrl).href, SATUSEHAT_KFA_TIMEOUT_MS: '200' };
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await kfa?.close();
    await mock?.close();
  });

  it('ends the attempt without an outcome (transient): the step stays in flight, is not dead-lettered, and sends nothing', async () => {
    const visit = worldVisitStarted();
    await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit });
    const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldPrescriptionWritten(visit.visitId) });

    const view = await waitForCase(hub.baseUrl, res.headers.get('location'), (v) => (v.steps[1]?.attemptLog.length ?? 0) > 0, {
      apiKey: WORLD_SOURCE_API_KEY,
    });

    expect(view.status).toBe('active');
    expect(view.steps[1]).toMatchObject({ state: 'in_flight', deadLetterReason: null, pins: null });
    expect(view.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'failed', errorCode: null, httpStatus, valuesUsed: { kfaCode: '92000001' } }),
    ]);
    expect(await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).toEqual([]);
  });
});
