import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import {
  caseViewSchema,
  getCase,
  newVisitId,
  postEvent,
  prescriptionItem,
  prescriptionWritten,
  TEST_SOURCES,
  visitStarted,
} from './support/events.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';

const problemSchema = z.object({
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});

/** Ingest of prescription.written. No worker runs, so no step leaves `ready`. */
describe('ingest: prescription.written', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });
  afterAll(async () => {
    await hub?.close();
  });

  const caseOf = async (res: Response) => {
    const caseId = res.headers.get('location')?.split('/').at(-1) ?? '';
    return caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json());
  };
  const problemOf = async (res: Response) => problemSchema.parse(await res.json());

  it('accepts a single-item prescription', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });

    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ visitId, type: 'prescription.written', caseStatus: 'active' });
    const view = await caseOf(res);
    expect(view.steps.map((s) => s.state)).toEqual(['ready', 'blocked', 'awaiting_event', 'awaiting_event']);
  });

  it('stores a prescription that arrives before its visit with its step blocked, waiting for visit.started', async () => {
    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten() });

    expect(res.status).toBe(202);
    const view = await caseOf(res);
    expect(view).toMatchObject({ status: 'waiting', waitingFor: 'visit.started', rejections: [] });
    expect(view.steps.map((s) => s.state)).toEqual(['awaiting_event', 'blocked', 'awaiting_event', 'awaiting_event']);
    expectAtMostOneStepInMotion(view);
  });

  it.each([
    ['two items', [prescriptionItem(), prescriptionItem({ itemId: 'ITEM-2', drugCode: 'AMX500' })]],
    ['no items', []],
  ])('rejects a prescription with %s as 422 UNSUPPORTED_MULTI_ITEM and opens no case', async (_, items) => {
    const visitId = newVisitId();

    const rejected = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { items } }) });

    expect(rejected.status).toBe(422);
    expect(rejected.headers.get('location')).toBeNull();
    expect((await problemOf(rejected)).code).toBe('UNSUPPORTED_MULTI_ITEM');
    // The visit's first accepted event opens its case, with no prescription recorded.
    const opened = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    expect(await opened.json()).toMatchObject({ caseStatus: 'active' });
    expect((await caseOf(opened)).steps[1]).toMatchObject({ step: 'submit_prescription', state: 'awaiting_event' });
  });

  it('reports every schema violation at once as VALIDATION_FAILED, before judging the item count', async () => {
    const event = prescriptionWritten({
      data: {
        authoredAt: '2026-03-02T08:10:00',
        requester: {},
        items: [{ itemId: 'ITEM-1', quantity: 0, dosage: { text: 'x', timesPerDay: 1.5, doseAmount: 1 } }, prescriptionItem()],
        prescriptionId: undefined,
      },
    });

    const res = await postEvent(hub.baseUrl, { body: event });

    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors.map(({ path, code }) => ({ path, code }))).toEqual(
      expect.arrayContaining([
        { path: '/data/prescriptionId', code: 'REQUIRED' },
        { path: '/data/authoredAt', code: 'TIME_OFFSET_MISSING' },
        { path: '/data/requester', code: 'REQUIRED' },
        { path: '/data/items/0/drugCode', code: 'REQUIRED' },
        { path: '/data/items/0/quantity', code: 'INVALID_FORMAT' },
        { path: '/data/items/0/dosage/timesPerDay', code: 'INVALID_FORMAT' },
        { path: '/data/items/0/dosage/routeCode', code: 'REQUIRED' },
      ]),
    );
    expect(problem.errors).toHaveLength(7);
  });

  it('applies the date floor to authoredAt', async () => {
    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten({ data: { authoredAt: '2014-06-03T05:00:00+07:00' } }) });

    expect((await problemOf(res)).errors).toEqual([expect.objectContaining({ path: '/data/authoredAt', code: 'DATE_BEFORE_FLOOR' })]);
  });

  it('rejects a second prescription with a different item for the same visit as UNSUPPORTED_MULTI_ITEM; the same item again is EVENT_ALREADY_RECORDED', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) });

    const otherItem = await postEvent(hub.baseUrl, {
      body: prescriptionWritten({ visitId, data: { items: [prescriptionItem({ itemId: 'ITEM-2' })] } }),
    });
    const otherPrescription = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { prescriptionId: 'RX-2' } }) });
    const sameItem = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { requester: { nik: '7209061211900002' } } }) });

    expect([otherItem.status, otherPrescription.status, sameItem.status]).toEqual([422, 422, 409]);
    expect((await problemOf(otherItem)).code).toBe('UNSUPPORTED_MULTI_ITEM');
    expect((await problemOf(otherPrescription)).code).toBe('UNSUPPORTED_MULTI_ITEM');
    expect((await problemOf(sameItem)).code).toBe('EVENT_ALREADY_RECORDED');
  });

  it('logs each rejection against the visit and shows it on the case view without changing the case', async () => {
    const visitId = newVisitId();
    const accepted = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    const before = await caseOf(accepted);

    const multi = prescriptionWritten({ visitId, data: { items: [prescriptionItem(), prescriptionItem({ itemId: 'ITEM-2' })] } });
    await postEvent(hub.baseUrl, { body: multi });
    await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { authoredAt: 'yesterday' } }) });
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });

    const after = await caseOf(accepted);
    expect(after.rejections).toEqual([
      { code: 'UNSUPPORTED_MULTI_ITEM', eventType: 'prescription.written', rejectedAt: expect.any(String) },
      { code: 'VALIDATION_FAILED', eventType: 'prescription.written', rejectedAt: expect.any(String) },
      { code: 'EVENT_ALREADY_RECORDED', eventType: 'visit.started', rejectedAt: expect.any(String) },
    ]);
    expect(Date.parse(after.rejections[0]?.rejectedAt ?? '')).not.toBeNaN();
    expect({ ...after, rejections: [] }).toEqual(before);
    // Only code, event type and time are kept: nothing of the rejected body.
    expect(JSON.stringify(after.rejections)).not.toContain('ITEM-2');
  });

  it('shows rejections logged before the visit had a case once its case opens', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { items: [] } }) });

    const view = await caseOf(await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) }));

    expect(view.rejections).toEqual([{ code: 'UNSUPPORTED_MULTI_ITEM', eventType: 'prescription.written', rejectedAt: expect.any(String) }]);
  });

  it('accepts a corrected single-item resend under the same key after a 422', async () => {
    const visitId = newVisitId();
    const idempotencyKey = crypto.randomUUID();
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    const multi = prescriptionWritten({ visitId, data: { items: [prescriptionItem(), prescriptionItem({ itemId: 'ITEM-2' })] } });

    const rejected = await postEvent(hub.baseUrl, { idempotencyKey, body: multi });
    const corrected = await postEvent(hub.baseUrl, { idempotencyKey, body: prescriptionWritten({ visitId }) });

    expect(rejected.status).toBe(422);
    expect(corrected.status).toBe(202);
    expect(corrected.headers.get('idempotent-replayed')).toBeNull();
    const view = await caseOf(corrected);
    expect(view.steps[1]).toMatchObject({ step: 'submit_prescription', state: 'blocked' });
    expect(view.rejections.map((r) => r.code)).toEqual(['UNSUPPORTED_MULTI_ITEM']);
  });

  it('keeps other source systems’ rejections off the case', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { apiKey: 'other-source-key', body: prescriptionWritten({ visitId, data: { items: [] } }) });

    const view = await caseOf(await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) }));

    expect(view.rejections).toEqual([]);
  });
});
