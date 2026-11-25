import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import {
  getCase,
  newVisitId,
  OTHER_SOURCE_API_KEY,
  postEvent,
  prescriptionItem,
  prescriptionWritten,
  TEST_SOURCES,
  visitStarted,
  type CaseView,
} from './support/events.js';

describe('ingest: prescription.written schema', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  async function violations(body: unknown) {
    const res = await postEvent(hub.baseUrl, { body });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; errors: { path: string; code: string }[] };
    expect(problem.code).toBe('VALIDATION_FAILED');
    return problem.errors.map(({ path, code }) => ({ path, code }));
  }

  it('accepts a valid single-item prescription and opens a case waiting for visit.started', async () => {
    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten() });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ type: 'prescription.written', caseStatus: 'waiting' });
  });

  it('stores a prescription arriving before visit.started with its step blocked; waitingFor names the earliest missing event', async () => {
    const visitId = newVisitId();
    const first = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) });
    const location = first.headers.get('location') as string;

    const early = (await (await getCase(hub.baseUrl, location)).json()) as CaseView;
    expect(early).toMatchObject({ status: 'waiting', waitingFor: 'visit.started' });
    expect(early.steps.map((s) => s.state)).toEqual(['awaiting_event', 'blocked', 'awaiting_event', 'awaiting_event']);

    expect((await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) })).status).toBe(202);
    const later = (await (await getCase(hub.baseUrl, location)).json()) as CaseView;
    expect(later).toMatchObject({ status: 'active', waitingFor: null });
    expect(later.steps.map((s) => s.state)).toEqual(['ready', 'blocked', 'awaiting_event', 'awaiting_event']);
  });

  it('reports every missing prescription field at once', async () => {
    expect(await violations({ ...prescriptionWritten(), data: {} })).toEqual([
      { path: '/data/prescriptionId', code: 'REQUIRED' },
      { path: '/data/authoredAt', code: 'REQUIRED' },
      { path: '/data/requester', code: 'REQUIRED' },
      { path: '/data/items', code: 'REQUIRED' },
    ]);
  });

  it('reports every missing item and dosage field at once', async () => {
    expect(await violations(prescriptionWritten({ data: { items: [{ dosage: {} }] } }))).toEqual([
      { path: '/data/items/0/itemId', code: 'REQUIRED' },
      { path: '/data/items/0/drugCode', code: 'REQUIRED' },
      { path: '/data/items/0/quantity', code: 'REQUIRED' },
      { path: '/data/items/0/dosage/text', code: 'REQUIRED' },
      { path: '/data/items/0/dosage/timesPerDay', code: 'REQUIRED' },
      { path: '/data/items/0/dosage/doseAmount', code: 'REQUIRED' },
      { path: '/data/items/0/dosage/routeCode', code: 'REQUIRED' },
    ]);
  });

  it('checks formats: positive amounts, integer timesPerDay, an identified requester, authoredAt offset and floor', async () => {
    const item = prescriptionItem({ quantity: 0, dosage: { text: 'x', timesPerDay: 1.5, doseAmount: -1, routeCode: '' } });
    const event = prescriptionWritten({
      data: { authoredAt: '2014-06-03T05:00:00+07:00', requester: { name: 'dr. X' }, items: [item] },
    });

    expect(await violations(event)).toEqual([
      { path: '/data/authoredAt', code: 'DATE_BEFORE_FLOOR' },
      { path: '/data/requester', code: 'REQUIRED' },
      { path: '/data/items/0/quantity', code: 'INVALID_FORMAT' },
      { path: '/data/items/0/dosage/timesPerDay', code: 'INVALID_FORMAT' },
      { path: '/data/items/0/dosage/doseAmount', code: 'INVALID_FORMAT' },
      { path: '/data/items/0/dosage/routeCode', code: 'INVALID_FORMAT' },
    ]);
    expect(await violations(prescriptionWritten({ data: { authoredAt: '2026-03-02T08:30:00' } }))).toEqual([
      { path: '/data/authoredAt', code: 'TIME_OFFSET_MISSING' },
    ]);
    expect(await violations(prescriptionWritten({ data: { items: 'one' } }))).toEqual([{ path: '/data/items', code: 'INVALID_FORMAT' }]);
  });
});

describe('ingest: one item per prescription (ADR 0004)', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const caseOf = async (res: Response) => (await getCase(hub.baseUrl, res.headers.get('location') as string)).json() as Promise<CaseView>;

  it.each([
    { name: 'two items', items: [prescriptionItem(), prescriptionItem({ itemId: 'RX-1-2', drugCode: 'AMX-500' })] },
    { name: 'no item', items: [] },
  ])('$name: 422 UNSUPPORTED_MULTI_ITEM, and nothing is stored for the visit', async ({ items }) => {
    const visitId = newVisitId();

    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { items } }) });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_MULTI_ITEM' });
    // The visit's case opens only with the next accepted event, and holds no prescription.
    const view = await caseOf(await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) }));
    expect(view.steps[1]).toMatchObject({ step: 'submit_prescription', state: 'awaiting_event' });
  });

  it('a schema violation is reported before the item count', async () => {
    const res = await postEvent(hub.baseUrl, { body: prescriptionWritten({ data: { prescriptionId: '', items: [] } }) });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: '/data/prescriptionId' }] });
  });

  it('a second prescription.written with a different item is UNSUPPORTED_MULTI_ITEM; the same item again is EVENT_ALREADY_RECORDED', async () => {
    const visitId = newVisitId();
    expect((await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) })).status).toBe(202);

    const otherItem = prescriptionWritten({ visitId, data: { items: [prescriptionItem({ itemId: 'RX-1-2' })] } });
    const otherPrescription = prescriptionWritten({ visitId, data: { prescriptionId: 'RX-2', items: [prescriptionItem({ itemId: 'RX-2-1' })] } });
    const sameItem = prescriptionWritten({ visitId, data: { items: [prescriptionItem({ quantity: 20 })] } });

    for (const body of [otherItem, otherPrescription]) {
      const res = await postEvent(hub.baseUrl, { body });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_MULTI_ITEM' });
    }
    const again = await postEvent(hub.baseUrl, { body: sameItem });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'EVENT_ALREADY_RECORDED' });
  });
});

describe('ingest: rejection log (#8)', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const view = async (location: string) => (await getCase(hub.baseUrl, location)).json() as Promise<CaseView>;
  const twoItems = (visitId: string) =>
    prescriptionWritten({ visitId, data: { items: [prescriptionItem(), prescriptionItem({ itemId: 'RX-1-2' })] } });

  it('shows a rejection on the waiting case (code, event type, time; no body) and changes nothing', async () => {
    const visitId = newVisitId();
    const opened = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    const location = opened.headers.get('location') as string;
    const before = await view(location);

    expect((await postEvent(hub.baseUrl, { body: twoItems(visitId) })).status).toBe(422);

    const after = await view(location);
    expect(after.rejections).toEqual([{ code: 'UNSUPPORTED_MULTI_ITEM', eventType: 'prescription.written', rejectedAt: expect.any(String) }]);
    expect(Date.parse(after.rejections[0]!.rejectedAt)).not.toBeNaN();
    const { rejections: _r1, ...stateBefore } = before;
    const { rejections: _r2, ...stateAfter } = after;
    expect(stateAfter).toEqual(stateBefore);
  });

  it('keeps rejections from before the case opened, oldest first, keyed by (source, visitId)', async () => {
    const visitId = newVisitId();
    expect((await postEvent(hub.baseUrl, { body: twoItems(visitId) })).status).toBe(422);
    expect((await postEvent(hub.baseUrl, { body: { ...visitStarted({ visitId }), data: {} } })).status).toBe(422);
    // The same visitId from another source is another case and sees none of them.
    const other = await postEvent(hub.baseUrl, { apiKey: OTHER_SOURCE_API_KEY, body: visitStarted({ visitId }) });
    const otherView = (await (await getCase(hub.baseUrl, other.headers.get('location') as string, OTHER_SOURCE_API_KEY)).json()) as CaseView;
    expect(otherView.rejections).toEqual([]);

    const opened = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });

    expect((await view(opened.headers.get('location') as string)).rejections.map((r) => [r.code, r.eventType])).toEqual([
      ['UNSUPPORTED_MULTI_ITEM', 'prescription.written'],
      ['VALIDATION_FAILED', 'visit.started'],
    ]);
  });

  it('logs a repeated event type too', async () => {
    const visitId = newVisitId();
    const opened = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    expect((await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) })).status).toBe(409);

    expect((await view(opened.headers.get('location') as string)).rejections).toMatchObject([
      { code: 'EVENT_ALREADY_RECORDED', eventType: 'visit.started' },
    ]);
  });

  it('accepts a corrected single-item resend with the same Idempotency-Key after a 422', async () => {
    const visitId = newVisitId();
    const opened = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    const key = randomUUID();
    expect((await postEvent(hub.baseUrl, { idempotencyKey: key, body: twoItems(visitId) })).status).toBe(422);

    const resent = await postEvent(hub.baseUrl, { idempotencyKey: key, body: prescriptionWritten({ visitId }) });

    expect(resent.status).toBe(202);
    const after = await view(opened.headers.get('location') as string);
    expect(after.steps[1]).toMatchObject({ step: 'submit_prescription', state: 'blocked' });
    expect(after.rejections).toHaveLength(1);
  });
});
