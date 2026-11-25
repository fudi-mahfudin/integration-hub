import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import {
  drugDispensed,
  getCase,
  newVisitId,
  postEvent,
  prescriptionItem,
  prescriptionWritten,
  TEST_SOURCES,
  type CaseView,
} from './support/events.js';

describe('ingest: drug.dispensed schema', () => {
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

  it('accepts a valid dispense and stores it blocked behind its predecessors', async () => {
    const res = await postEvent(hub.baseUrl, { body: drugDispensed() });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ type: 'drug.dispensed', caseStatus: 'waiting' });
    const view = (await (await getCase(hub.baseUrl, res.headers.get('location') as string)).json()) as CaseView;
    expect(view).toMatchObject({ waitingFor: 'visit.started' });
    expect(view.steps.map((s) => s.state)).toEqual(['awaiting_event', 'awaiting_event', 'blocked', 'awaiting_event']);
  });

  it('batch and substitution are optional; every one of the five substitution reasons is accepted', async () => {
    const bare = drugDispensed();
    delete bare.data.batch;
    expect((await postEvent(hub.baseUrl, { body: bare })).status).toBe(202);
    for (const reasonCode of ['OS', 'FP', 'DRUG_INTERACTION', 'PATIENT_CHOICE', 'PRESCRIPTION_ERROR']) {
      expect((await postEvent(hub.baseUrl, { body: drugDispensed({ data: { substitution: { reasonCode } } }) })).status).toBe(202);
    }
  });

  it('reports every missing field at once', async () => {
    expect(await violations({ ...drugDispensed(), data: {} })).toEqual([
      { path: '/data/prescriptionId', code: 'REQUIRED' },
      { path: '/data/itemId', code: 'REQUIRED' },
      { path: '/data/drugCode', code: 'REQUIRED' },
      { path: '/data/quantity', code: 'REQUIRED' },
      { path: '/data/preparedAt', code: 'REQUIRED' },
      { path: '/data/handedOverAt', code: 'REQUIRED' },
      { path: '/data/pharmacist', code: 'REQUIRED' },
    ]);
  });

  it('checks formats: quantity, an identified pharmacist, offsets and the floor on both times', async () => {
    const event = drugDispensed({
      data: { quantity: -2, preparedAt: '2026-03-02T09:00:00', handedOverAt: '2014-06-03T05:00:00+07:00', pharmacist: { name: 'Apt. Y' } },
    });

    expect(await violations(event)).toEqual([
      { path: '/data/quantity', code: 'INVALID_FORMAT' },
      { path: '/data/preparedAt', code: 'TIME_OFFSET_MISSING' },
      { path: '/data/handedOverAt', code: 'DATE_BEFORE_FLOOR' },
      { path: '/data/pharmacist', code: 'REQUIRED' },
    ]);
  });

  it('batch: lot and expiry both or neither (BATCH_INCOMPLETE)', async () => {
    expect(await violations(drugDispensed({ data: { batch: { lot: 'LOT-1' } } }))).toEqual([{ path: '/data/batch', code: 'BATCH_INCOMPLETE' }]);
    expect(await violations(drugDispensed({ data: { batch: { expiry: '2028-01-31' } } }))).toEqual([{ path: '/data/batch', code: 'BATCH_INCOMPLETE' }]);
    expect(await violations(drugDispensed({ data: { batch: 'LOT-1' } }))).toEqual([{ path: '/data/batch', code: 'INVALID_FORMAT' }]);
  });

  it('batch.expiry is a plain calendar date, not before the floor (which itself is allowed)', async () => {
    expect(await violations(drugDispensed({ data: { batch: { lot: 'LOT-1', expiry: '2028-01-31T00:00:00+07:00' } } }))).toEqual([
      { path: '/data/batch/expiry', code: 'INVALID_FORMAT' },
    ]);
    expect(await violations(drugDispensed({ data: { batch: { lot: 'LOT-1', expiry: '2014-06-02' } } }))).toEqual([
      { path: '/data/batch/expiry', code: 'DATE_BEFORE_FLOOR' },
    ]);
    const onFloor = drugDispensed({ data: { batch: { lot: 'LOT-1', expiry: '2014-06-03' } } });
    expect((await postEvent(hub.baseUrl, { body: onFloor })).status).toBe(202);
  });

  it('substitution.reasonCode must be one of the five reasons (INVALID_SUBSTITUTION_REASON)', async () => {
    expect(await violations(drugDispensed({ data: { substitution: { reasonCode: 'CT' } } }))).toEqual([
      { path: '/data/substitution/reasonCode', code: 'INVALID_SUBSTITUTION_REASON' },
    ]);
    expect(await violations(drugDispensed({ data: { substitution: {} } }))).toEqual([
      { path: '/data/substitution/reasonCode', code: 'REQUIRED' },
    ]);
    expect(await violations(drugDispensed({ data: { substitution: true } }))).toEqual([{ path: '/data/substitution', code: 'INVALID_FORMAT' }]);
  });
});

describe('ingest: the dispense must name the case prescription (PRESCRIPTION_MISMATCH)', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { body });

  async function mismatch(body: unknown) {
    const res = await send(body);
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; errors: { path: string; code: string }[] };
    expect(problem.code).toBe('PRESCRIPTION_MISMATCH');
    return problem.errors.map(({ path, code }) => ({ path, code }));
  }

  it('dispense second: another prescriptionId or itemId is rejected and logged, the step untouched; the matching one is accepted', async () => {
    const visitId = newVisitId();
    const prescribed = await send(prescriptionWritten({ visitId }));
    expect(prescribed.status).toBe(202);

    expect(await mismatch(drugDispensed({ visitId, data: { prescriptionId: 'RX-2' } }))).toEqual([
      { path: '/data/prescriptionId', code: 'PRESCRIPTION_MISMATCH' },
    ]);
    expect(await mismatch(drugDispensed({ visitId, data: { itemId: 'RX-1-2' } }))).toEqual([{ path: '/data/itemId', code: 'PRESCRIPTION_MISMATCH' }]);

    const view = (await (await getCase(hub.baseUrl, prescribed.headers.get('location') as string)).json()) as CaseView;
    expect(view.steps[2]).toMatchObject({ state: 'awaiting_event' });
    expect(view.rejections.map((r) => [r.code, r.eventType])).toEqual([
      ['PRESCRIPTION_MISMATCH', 'drug.dispensed'],
      ['PRESCRIPTION_MISMATCH', 'drug.dispensed'],
    ]);
    expect((await send(drugDispensed({ visitId }))).status).toBe(202);
  });

  it('prescription second: a prescription for another item than the stored dispense is rejected', async () => {
    const visitId = newVisitId();
    expect((await send(drugDispensed({ visitId }))).status).toBe(202);

    const other = prescriptionWritten({ visitId, data: { prescriptionId: 'RX-9', items: [prescriptionItem({ itemId: 'RX-9-1' })] } });
    expect(await mismatch(other)).toEqual([
      { path: '/data/prescriptionId', code: 'PRESCRIPTION_MISMATCH' },
      { path: '/data/items/0/itemId', code: 'PRESCRIPTION_MISMATCH' },
    ]);
    expect((await send(prescriptionWritten({ visitId }))).status).toBe(202);
  });

  it('a second dispense is EVENT_ALREADY_RECORDED even when it also mismatches (409 is checked first)', async () => {
    const visitId = newVisitId();
    expect((await send(prescriptionWritten({ visitId }))).status).toBe(202);
    expect((await send(drugDispensed({ visitId }))).status).toBe(202);

    const again = await send(drugDispensed({ visitId, data: { prescriptionId: 'RX-2' } }));

    expect(again.status).toBe(409);
  });
});
