import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import {
  bootMock,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisitFinished,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

const summarySchema = z.array(z.object({ reason: z.string(), class: z.string(), count: z.number().int(), oldestSince: z.string() }));
const pageSchema = z.object({
  cases: z.array(z.object({ caseId: z.string(), status: z.string(), currentStep: z.string().nullable(), deadLetterReason: z.string().nullable() }).passthrough()),
  nextCursor: z.string().nullable(),
});

describe('dead letters in the case list and the dead-letter summary (#38)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  let seeded: { mappingMissing: CaseView[]; mismatch: CaseView; completed: CaseView } | undefined;
  /** The cases `beforeAll` drove to their end. */
  const cases = () => {
    if (!seeded) throw new Error('the cases are not seeded');
    return seeded;
  };

  const send = async (body: unknown) => {
    const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    expect(res.status).toBe(202);
    return res.headers.get('location');
  };
  const until = (location: string | null, done: (v: CaseView) => boolean) =>
    waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

  /** A whole visit; `prescriptionItem` and `dispense` override its drug events. */
  async function visit(overrides: { prescriptionItem?: Record<string, unknown>; dispense?: Record<string, unknown> } = {}) {
    const started = worldVisitStarted();
    const prescription = worldPrescriptionWritten(started.visitId, { item: overrides.prescriptionItem });
    const location = await send(started);
    await send(prescription);
    await send(worldDrugDispensed(prescription, overrides.dispense));
    await send(worldVisitFinished(started));
    return location;
  }

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);

    const ended = (v: CaseView) => v.status === 'dead_lettered' || v.status === 'completed';
    const first = await until(await visit({ prescriptionItem: { drugCode: `UNMAPPED-${crypto.randomUUID()}` } }), ended);
    const second = await until(await visit({ prescriptionItem: { drugCode: `UNMAPPED-${crypto.randomUUID()}` } }), ended);
    // PCT500-FFB derives from the prescribed 92000001: declaring it a substitution is SUBSTITUTION_MISMATCH.
    const mismatch = await until(await visit({ dispense: { drugCode: 'PCT500-FFB', substitution: { reasonCode: 'OS' } } }), ended);
    const completed = await until(await visit(), ended);
    seeded = { mappingMissing: [first, second], mismatch, completed };
  }, 60_000);
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const list = async (query: string) => {
    const res = await adminRequest(hub.baseUrl, 'GET', `v1/cases${query}`);
    expect(res.status).toBe(200);
    return pageSchema.parse(await res.json()).cases;
  };

  it('the cases ended as the setup meant them to', () => {
    expect(cases().mappingMissing.map((c) => c.deadLetterReason)).toEqual(['MAPPING_MISSING', 'MAPPING_MISSING']);
    expect(cases().mismatch.deadLetterReason).toBe('SUBSTITUTION_MISMATCH');
    expect(cases().completed.status).toBe('completed');
  });

  it('filters by dead-letter reason and by current step', async () => {
    const missing = await list('?reason=MAPPING_MISSING');
    expect(missing.map((c) => c.caseId).sort()).toEqual(cases().mappingMissing.map((c) => c.caseId).sort());
    expect(missing[0]).toMatchObject({
      status: 'dead_lettered',
      currentStep: 'submit_prescription',
      deadLetterReason: 'MAPPING_MISSING',
      reasonClass: 'replayable',
      deadLetteredSince: expect.stringMatching(/Z$/),
      // create visit's one attempt and submit prescription's one.
      attempts: 2,
    });

    expect((await list('?step=submit_dispense')).map((c) => c.caseId)).toEqual([cases().mismatch.caseId]);
    expect((await list('?status=completed')).map((c) => c.caseId)).toEqual([cases().completed.caseId]);
    expect((await list('?status=completed'))[0]).toMatchObject({ currentStep: null, deadLetterReason: null, attempts: 4 });
  });

  it('summarises dead-lettered cases by reason, with its class, how many, and since when the oldest', async () => {
    const res = await adminRequest(hub.baseUrl, 'GET', 'v1/dead-letters/summary');
    expect(res.status).toBe(200);
    const oldestMissing = cases().mappingMissing.map((c) => c.deadLetteredSince ?? '').sort()[0];
    expect(summarySchema.parse(await res.json())).toEqual([
      { reason: 'MAPPING_MISSING', class: 'replayable', count: 2, oldestSince: oldestMissing },
      { reason: 'SUBSTITUTION_MISMATCH', class: 'source_data', count: 1, oldestSince: cases().mismatch.deadLetteredSince },
    ]);
  });

  it('the summary is protected by an API key', async () => {
    expect((await adminRequest(hub.baseUrl, 'GET', 'v1/dead-letters/summary', { apiKey: null })).status).toBe(401);
    const own = await adminRequest(hub.baseUrl, 'GET', 'v1/dead-letters/summary', { apiKey: WORLD_SOURCE_API_KEY });
    expect(own.status).toBe(200);
    expect(summarySchema.parse(await own.json()).map((g) => g.count)).toEqual([2, 1]);
  });
});
