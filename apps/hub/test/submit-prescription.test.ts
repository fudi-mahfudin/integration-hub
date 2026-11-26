import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  bootMock,
  createMedicationRequestAtMock,
  PRESCRIPTION_SYSTEM,
  world,
  WORLD_SOURCE_API_KEY,
  worldEnv,
  worldPrescriptionWritten,
  worldVisit,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

const prescriptionSettled = (v: CaseView) => ['completed', 'dead_lettered'].includes(v.steps[1]?.state ?? '');

describe('submit prescription: a prescription.written becomes a MedicationRequest on the visit’s Encounter', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });

  // The mock is never reset here (a reset revokes the worker's token); each test uses a fresh visit id.
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
  const settled = (res: Response) =>
    waitForCase(hub.baseUrl, res.headers.get('location'), prescriptionSettled, { apiKey: WORLD_SOURCE_API_KEY });

  it('creates the Encounter, then exactly one MedicationRequest referencing it', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);

    await send(visit);
    const view = await settled(await send(prescription));

    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created']);
    const encounterId = view.steps[0]?.remote?.id;
    expect(effects[1]?.request.body).toMatchObject({ encounter: { reference: `Encounter/${encounterId}` } });
    expect(view).toMatchObject({ status: 'waiting', waitingFor: 'drug.dispensed' });
    expect(view.steps[1]).toMatchObject({
      step: 'submit_prescription',
      state: 'completed',
      attempts: 1,
      remote: { type: 'MedicationRequest', id: bodyId(effects[1]?.response.body), version: '1' },
    });
    expect(await mock.client.report()).toMatchObject({ duplicates: [], outOfOrder: [] });
    expectAtMostOneStepInMotion(view);
  });

  it('sends the prescription as SATUSEHAT takes it, and pins the KFA product and the requester', async () => {
    const visit = worldVisitStarted();
    // AMX500 maps to KFA 92000003, Amoksisilin 500 mg Kapsul, counted in capsules (BS019).
    const prescription = worldPrescriptionWritten(visit.visitId, {
      item: { drugCode: 'AMX500', quantity: 15, dosage: { text: '3 x 1 kapsul', timesPerDay: 3, doseAmount: 1, routeCode: 'O' } },
    });

    await send(visit);
    const view = await settled(await send(prescription));

    const posts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).filter((e) => e.method === 'POST');
    expect(posts).toHaveLength(1);
    const capsules = { unit: 'Kapsul', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS019' };
    expect(posts[0]?.request.body).toMatchObject({
      resourceType: 'MedicationRequest',
      identifier: [
        { system: PRESCRIPTION_SYSTEM, value: prescription.data.prescriptionId },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${world.organization.id}`, value: 'ITEM-1' },
      ],
      status: 'completed',
      intent: 'order',
      category: [{ coding: [{ code: 'community' }] }],
      contained: [{ resourceType: 'Medication', code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '92000003' }] } }],
      subject: { reference: `Patient/${worldVisit.patient.ihsNumber}` },
      encounter: { reference: `Encounter/${view.steps[0]?.remote?.id}` },
      // 08:10:00.750 at +07:00 is 01:10:00 UTC, truncated to the second.
      authoredOn: '2026-03-02T01:10:00+00:00',
      requester: { reference: `Practitioner/${worldVisit.physician.ihsNumber}` },
      dosageInstruction: [{ text: '3 x 1 kapsul', timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: 1, ...capsules } }] }],
      dispenseRequest: { quantity: { value: 15, ...capsules }, performer: { reference: `Organization/${world.organization.id}` } },
      substitution: { allowedBoolean: true },
    });
    const pins = {
      kfaCode: '92000003',
      kfaLevel: 92,
      parent92: null,
      activeIngredients: ['91000002'],
      requesterIhsNumber: worldVisit.physician.ihsNumber,
    };
    expect(view.steps[1]).toMatchObject({ state: 'completed', pins });
    expect(view.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'completed',
        errorCode: null,
        httpStatus: 201,
        valuesUsed: pins,
        lookupMethods: { requester: 'nik' },
        violations: [],
      }),
    ]);
  });

  it('fetches a KFA code’s details from KFA v2 once and reuses them for later cases; an actual product (93) pins its virtual product', async () => {
    // AMX500-FFC maps to KFA 93000004, derived from 92000003; no other test prescribes it.
    const views: CaseView[] = [];
    for (let i = 0; i < 2; i++) {
      const visit = worldVisitStarted();
      await send(visit);
      views.push(await settled(await send(worldPrescriptionWritten(visit.visitId, { item: { drugCode: 'AMX500-FFC' } }))));
    }

    const lookups = (await mock.client.log({ resourceType: 'KfaProduct' })).filter((e) => e.path.includes('code=93000004'));
    expect(lookups).toHaveLength(1);
    for (const view of views) {
      expect(view.steps[1]).toMatchObject({
        state: 'completed',
        pins: { kfaCode: '93000004', kfaLevel: 93, parent92: '92000003', activeIngredients: ['91000002'] },
      });
    }
  });

  it.each([
    ['has no drug mapping', 'NOT-MAPPED', 'MAPPING_MISSING', 'the drug "NOT-MAPPED" has no mapping for this source system', {}],
    [
      'maps to a code KFA does not know',
      'OBAT-TANPA-KFA',
      'MAPPING_MISSING',
      'the drug "OBAT-TANPA-KFA" maps to KFA 93999999, which KFA does not know',
      { kfaCode: '93999999' },
    ],
    [
      'maps to an ingredient (91)',
      'PCT-ZAT-AKTIF',
      'KFA_LEVEL_INVALID',
      'a prescription needs a KFA 92 or 93 product, got 91000001 at level 91',
      { kfaCode: '91000001', kfaLevel: 91, parent92: null, activeIngredients: [] },
    ],
  ])('dead-letters a drug code that %s with %s, and sends no MedicationRequest', async (_, drugCode, reason, message, valuesUsed) => {
    const visit = worldVisitStarted();

    await send(visit);
    const view = await settled(await send(worldPrescriptionWritten(visit.visitId, { item: { drugCode } })));

    expect(view.status).toBe('dead_lettered');
    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'dead_lettered', 'awaiting_event', 'awaiting_event']);
    expect(view.steps[1]).toMatchObject({ deadLetterReason: reason, pins: null, remote: null });
    const [attempt] = view.steps[1]?.attemptLog ?? [];
    expect(attempt).toMatchObject({ outcome: 'dead_lettered', errorCode: reason, valuesUsed });
    expect(attempt?.violations[0]).toEqual({ code: reason, path: null, message });
    expect(await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('adopts a MedicationRequest already at SATUSEHAT under the prescription identifier, creating none', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);
    const visitView = await waitForCase(hub.baseUrl, (await send(visit)).headers.get('location'), (v) => v.steps[0]?.state === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
    });
    const existing = await createMedicationRequestAtMock(mock.baseUrl, visitView.steps[0]?.remote?.id ?? '', prescription.data.prescriptionId);

    const view = await settled(await send(prescription));

    expect(view.steps[1]).toMatchObject({ state: 'completed', remote: { type: 'MedicationRequest', id: existing, version: '1' } });
    expect(view.steps[1]?.attemptLog).toEqual([expect.objectContaining({ outcome: 'completed', httpStatus: 200 })]);
    const posts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).filter((e) => e.method === 'POST');
    expect(posts).toHaveLength(1);
  });

  it('dead-letters with REMOTE_RECORD_AMBIGUOUS when more than one MedicationRequest has the prescription identifier', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);
    const visitView = await waitForCase(hub.baseUrl, (await send(visit)).headers.get('location'), (v) => v.steps[0]?.state === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
    });
    const encounterId = visitView.steps[0]?.remote?.id ?? '';
    await createMedicationRequestAtMock(mock.baseUrl, encounterId, prescription.data.prescriptionId);
    await createMedicationRequestAtMock(mock.baseUrl, encounterId, prescription.data.prescriptionId);

    const view = await settled(await send(prescription));

    expect(view).toMatchObject({ status: 'dead_lettered' });
    expect(view.steps[1]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'REMOTE_RECORD_AMBIGUOUS', remote: null });
    const posts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).filter((e) => e.method === 'POST');
    expect(posts).toHaveLength(2);
  });

  it('holds a prescription that arrives before its visit, then submits it after the Encounter', async () => {
    const visit = worldVisitStarted();

    const early = await send(worldPrescriptionWritten(visit.visitId));
    const blocked = await waitForCase(hub.baseUrl, early.headers.get('location'), () => true, { apiKey: WORLD_SOURCE_API_KEY });
    expect(blocked).toMatchObject({ status: 'waiting', waitingFor: 'visit.started' });
    expect(blocked.steps.map((s) => s.state)).toEqual(['awaiting_event', 'blocked', 'awaiting_event', 'awaiting_event']);
    await send(visit);
    const view = await settled(early);

    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'awaiting_event', 'awaiting_event']);
    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created']);
  });

  it('dead-letters with PRACTITIONER_NOT_FOUND when no practitioner has the requester’s NIK, creating nothing', async () => {
    const visit = worldVisitStarted();

    await send(visit);
    const view = await settled(await send(worldPrescriptionWritten(visit.visitId, { data: { requester: { nik: '7209069999999999' } } })));

    expect(view.steps[1]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PRACTITIONER_NOT_FOUND', pins: null });
    expect(view.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'dead_lettered', errorCode: 'PRACTITIONER_NOT_FOUND', httpStatus: 200, lookupMethods: {} }),
    ]);
    expect(await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationRequest' })).toEqual([]);
  });
});

/** The `id` of a stored record the mock answered with. */
function bodyId(body: unknown): string {
  const id: unknown = typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined;
  if (typeof id !== 'string') throw new Error(`not a stored record: ${JSON.stringify(body)}`);
  return id;
}
