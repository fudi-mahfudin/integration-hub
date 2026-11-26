import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { caseViewSchema, drugDispensed, getCase, newVisitId, postEvent, prescriptionWritten, TEST_SOURCES, visitStarted } from './support/events.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';

const problemSchema = z.object({
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});

/** Ingest of drug.dispensed. No worker runs, so no step leaves `ready`. */
describe('ingest: drug.dispensed', () => {
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

  it('accepts a dispense of the case’s prescription, its step blocked behind the prescription', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
    await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) });

    const res = await postEvent(hub.baseUrl, { body: drugDispensed({ visitId }) });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ visitId, type: 'drug.dispensed', caseStatus: 'active' });
    const view = await caseOf(res);
    expect(view.steps.map((s) => s.state)).toEqual(['ready', 'blocked', 'blocked', 'awaiting_event']);
    expectAtMostOneStepInMotion(view);
  });

  it('accepts a dispense without a batch, and a declared substitution with a known reason', async () => {
    // An undefined batch is left out of the JSON body.
    const res = await postEvent(hub.baseUrl, { body: drugDispensed({ data: { batch: undefined, substitution: { reasonCode: 'PATIENT_CHOICE' } } }) });

    expect(res.status).toBe(202);
  });

  it('reports every schema violation at once as VALIDATION_FAILED, with the batch and substitution reason codes', async () => {
    const event = drugDispensed({
      data: {
        prescriptionId: '',
        preparedAt: '2026-03-02T08:20:00',
        handedOverAt: '2014-06-03T05:00:00+07:00',
        pharmacist: {},
        batch: { lot: 'LOT-1' },
        substitution: { reasonCode: 'CHEAPER' },
      },
    });

    const res = await postEvent(hub.baseUrl, { body: event });

    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors.map((e) => [e.path, e.code])).toEqual(
      expect.arrayContaining([
        ['/data/prescriptionId', 'INVALID_FORMAT'],
        ['/data/preparedAt', 'TIME_OFFSET_MISSING'],
        ['/data/handedOverAt', 'DATE_BEFORE_FLOOR'],
        ['/data/pharmacist', 'REQUIRED'],
        ['/data/batch', 'BATCH_INCOMPLETE'],
        ['/data/substitution/reasonCode', 'INVALID_SUBSTITUTION_REASON'],
      ]),
    );
    expect(problem.errors).toHaveLength(6);
  });

  it.each([
    ['an expiry without a lot', { expiry: '2027-04-24' }, 'BATCH_INCOMPLETE', '/data/batch'],
    ['neither a lot nor an expiry (send no batch instead)', {}, 'BATCH_INCOMPLETE', '/data/batch'],
    ['an expiry before the date floor', { lot: 'LOT-1', expiry: '2014-06-02' }, 'DATE_BEFORE_FLOOR', '/data/batch/expiry'],
    ['an expiry that is not a calendar date', { lot: 'LOT-1', expiry: '2027-02-30' }, 'INVALID_FORMAT', '/data/batch/expiry'],
  ])('rejects a batch with %s', async (_, batch, code, path) => {
    const res = await postEvent(hub.baseUrl, { body: drugDispensed({ data: { batch } }) });

    expect((await problemOf(res)).errors).toEqual([expect.objectContaining({ path, code })]);
  });

  it('rejects a substitution without a reason as REQUIRED', async () => {
    const res = await postEvent(hub.baseUrl, { body: drugDispensed({ data: { substitution: {} } }) });

    expect((await problemOf(res)).errors).toEqual([expect.objectContaining({ path: '/data/substitution/reasonCode', code: 'REQUIRED' })]);
  });

  it.each([
    ['another prescriptionId', { prescriptionId: 'RX-OTHER' }, '/data/prescriptionId'],
    ['another itemId', { itemId: 'ITEM-OTHER' }, '/data/itemId'],
  ])('rejects a dispense naming %s than the case’s prescription as 422 PRESCRIPTION_MISMATCH, recording nothing', async (_, data, path) => {
    const visitId = newVisitId();
    const accepted = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) });

    const rejected = await postEvent(hub.baseUrl, { body: drugDispensed({ visitId, data }) });

    expect(rejected.status).toBe(422);
    const problem = await problemOf(rejected);
    expect(problem).toMatchObject({ code: 'PRESCRIPTION_MISMATCH', errors: [{ path, code: 'PRESCRIPTION_MISMATCH' }] });
    const view = await caseOf(accepted);
    expect(view.steps[2]).toMatchObject({ step: 'submit_dispense', state: 'awaiting_event' });
    expect(view.rejections).toEqual([expect.objectContaining({ code: 'PRESCRIPTION_MISMATCH', eventType: 'drug.dispensed' })]);
  });

  it('rejects a prescription arriving after a dispense that names another prescription as 422 PRESCRIPTION_MISMATCH', async () => {
    const visitId = newVisitId();
    const accepted = await postEvent(hub.baseUrl, { body: drugDispensed({ visitId }) });

    const rejected = await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId, data: { prescriptionId: 'RX-OTHER' } }) });

    expect(rejected.status).toBe(422);
    expect(await problemOf(rejected)).toMatchObject({ code: 'PRESCRIPTION_MISMATCH', errors: [{ path: '/data/prescriptionId' }] });
    expect((await caseOf(accepted)).steps[1]).toMatchObject({ step: 'submit_prescription', state: 'awaiting_event' });
    // With the matching pair, the prescription is then accepted.
    expect((await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId }) })).status).toBe(202);
  });

  it('rejects a second dispense for the visit as 409 EVENT_ALREADY_RECORDED', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: drugDispensed({ visitId }) });

    const again = await postEvent(hub.baseUrl, { body: drugDispensed({ visitId, data: { quantity: 5 } }) });

    expect(again.status).toBe(409);
  });
});
