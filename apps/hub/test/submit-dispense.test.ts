import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  bootMock,
  createMedicationDispenseAtMock,
  PRESCRIPTION_SYSTEM,
  world,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisit,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

const dispenseSettled = (v: CaseView) => ['completed', 'dead_lettered'].includes(v.steps[2]?.state ?? '') || v.status === 'dead_lettered';

const REQUESTER = { reference: `Practitioner/${worldVisit.physician.ihsNumber}` };
const PHARMACIST = { reference: `Practitioner/${worldVisit.pharmacist.ihsNumber}` };
const SUBSTITUTION_TYPE_G = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution', code: 'G' }] };

describe('submit dispense: a drug.dispensed becomes a MedicationDispense authorized by the case’s MedicationRequest', () => {
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

  /** Sends a visit, its prescription of `prescribedCode` and its dispense with `dispensed` data; resolves once the dispense settled. */
  async function deliver(prescribedCode: string, dispensed: Record<string, unknown>) {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId, { item: { drugCode: prescribedCode } });
    await send(visit);
    await send(prescription);
    const res = await send(worldDrugDispensed(prescription, dispensed));
    const view = await waitForCase(hub.baseUrl, res.headers.get('location'), dispenseSettled, { apiKey: WORLD_SOURCE_API_KEY });
    const posts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationDispense' })).filter((e) => e.method === 'POST');
    return { visit, prescription, view, posts };
  }

  it('creates the Encounter, the MedicationRequest, then exactly one MedicationDispense, and pins the dispensed product and the pharmacist', async () => {
    const { visit, prescription, view, posts } = await deliver('PCT500', {});

    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created', 'MedicationDispense created']);
    expect(posts).toHaveLength(1);
    const org = world.organization.id;
    expect(posts[0]?.request.body).toEqual({
      resourceType: 'MedicationDispense',
      contained: [
        {
          resourceType: 'Medication',
          id: 'medication',
          identifier: [{ system: `http://sys-ids.kemkes.go.id/medication/${org}`, use: 'official', value: `${prescription.data.prescriptionId}-ITEM-1` }],
          code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000001', display: 'Parasetamol 500 mg Tablet (Fiktif Farma A)' }] },
          status: 'active',
          form: { coding: [{ system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS066', display: 'Tablet' }] },
          // The expiry stays the plain date the source sent.
          batch: { lotNumber: 'LOT-2026-001', expirationDate: '2027-04-24' },
        },
      ],
      identifier: [
        { system: PRESCRIPTION_SYSTEM, use: 'official', value: prescription.data.prescriptionId },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${org}`, use: 'official', value: 'ITEM-1' },
      ],
      status: 'completed',
      medicationReference: { reference: '#medication', display: 'Parasetamol 500 mg Tablet (Fiktif Farma A)' },
      subject: { reference: `Patient/${worldVisit.patient.ihsNumber}` },
      context: { reference: `Encounter/${view.steps[0]?.remote?.id}` },
      performer: [{ actor: PHARMACIST }],
      authorizingPrescription: [{ reference: `MedicationRequest/${view.steps[1]?.remote?.id}` }],
      quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS066' },
      // 08:20 and 08:30:00.900 at +07:00, in UTC, truncated to the second.
      whenPrepared: '2026-03-02T01:20:00+00:00',
      whenHandedOver: '2026-03-02T01:30:00+00:00',
      substitution: { wasSubstituted: false },
    });
    expect(posts[0]?.response.status).toBe(201);
    expect(view).toMatchObject({ status: 'waiting', waitingFor: 'visit.finished' });
    const pins = { kfaCode: '93000001', kfaLevel: 93, parent92: '92000001', activeIngredients: ['91000001'], pharmacistIhsNumber: worldVisit.pharmacist.ihsNumber };
    expect(view.steps[2]).toMatchObject({ step: 'submit_dispense', state: 'completed', remote: { type: 'MedicationDispense', version: '1' }, pins });
    expect(view.steps[2]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'completed', httpStatus: 201, valuesUsed: pins, lookupMethods: { pharmacist: 'nik' }, violations: [] }),
    ]);
    expect(await mock.client.report()).toMatchObject({ duplicates: [], outOfOrder: [] });
    expectAtMostOneStepInMotion(view);
  });

  it('flags a strength substitution (same 91 set, another 92), with its reason, type G and the requester and pharmacist responsible', async () => {
    // PCT650-FFA is KFA 93000003, Parasetamol 650 mg: the prescribed 92000001 is 500 mg.
    const { view, posts } = await deliver('PCT500', { drugCode: 'PCT650-FFA', substitution: { reasonCode: 'OS' } });

    expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { kfaCode: '93000003', parent92: '92000002' } });
    expect(posts.map((p) => p.response.status)).toEqual([201]);
    expect(posts[0]?.request.body).toMatchObject({
      substitution: {
        wasSubstituted: true,
        type: SUBSTITUTION_TYPE_G,
        reason: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'OS' }] }],
        responsibleParty: [REQUESTER, PHARMACIST],
      },
    });
  });

  it.each([
    ['FP', { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'FP' }],
    ['DRUG_INTERACTION', { system: 'http://terminology.kemkes.go.id', code: 'TK000017' }],
    ['PATIENT_CHOICE', { system: 'http://terminology.kemkes.go.id', code: 'TK000018' }],
    ['PRESCRIPTION_ERROR', { system: 'http://snomed.info/sct', code: '661000124108' }],
  ])('flags a brand substitution of the prescribed actual product, for the reason %s', async (reasonCode, coding) => {
    // PCT500-FFA (93000001) prescribed, PCT500-FFB (93000002) dispensed: the same virtual product, another brand.
    const { view, posts } = await deliver('PCT500-FFA', { drugCode: 'PCT500-FFB', substitution: { reasonCode } });

    expect(view.steps[2]).toMatchObject({ state: 'completed' });
    expect(posts[0]?.request.body).toMatchObject({
      substitution: { wasSubstituted: true, type: SUBSTITUTION_TYPE_G, reason: [{ coding: [coding] }], responsibleParty: [REQUESTER, PHARMACIST] },
    });
  });

  it.each([
    ['a therapeutic substitution (other active ingredients)', 'PCT500', { drugCode: 'IBU400-FFB', substitution: { reasonCode: 'OS' } }, 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'],
    ['a declared substitution that KFA judges is none', 'PCT500', { drugCode: 'PCT500-FFB', substitution: { reasonCode: 'OS' } }, 'SUBSTITUTION_MISMATCH'],
    ['a substitution the source did not declare', 'PCT500', { drugCode: 'PCT650-FFA' }, 'SUBSTITUTION_MISMATCH'],
    ['a dispense of a virtual product (92)', 'PCT500', { drugCode: 'PCT650' }, 'KFA_LEVEL_INVALID'],
    ['a drug code with no mapping', 'PCT500', { drugCode: 'NOT-MAPPED' }, 'MAPPING_MISSING'],
  ])('dead-letters %s with %s, and sends no MedicationDispense', async (_, prescribed, dispensed, reason) => {
    const { view, posts } = await deliver(prescribed, dispensed);

    expect(view.status).toBe('dead_lettered');
    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'dead_lettered', 'awaiting_event']);
    expect(view.steps[2]).toMatchObject({ deadLetterReason: reason, pins: null, remote: null });
    expect(view.steps[2]?.attemptLog).toEqual([expect.objectContaining({ outcome: 'dead_lettered', errorCode: reason })]);
    expect(view.steps[2]?.attemptLog[0]?.violations[0]).toMatchObject({ code: reason });
    expect(posts).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('adopts a MedicationDispense already at SATUSEHAT under the prescription identifier, creating none', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);
    await send(visit);
    const prescribed = await waitForCase(hub.baseUrl, (await send(prescription)).headers.get('location'), (v) => v.steps[1]?.state === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
    });
    const existing = await createMedicationDispenseAtMock(mock.baseUrl, {
      encounterId: prescribed.steps[0]?.remote?.id ?? '',
      medicationRequestId: prescribed.steps[1]?.remote?.id ?? '',
      prescriptionId: prescription.data.prescriptionId,
    });

    const res = await send(worldDrugDispensed(prescription));
    const view = await waitForCase(hub.baseUrl, res.headers.get('location'), dispenseSettled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.steps[2]).toMatchObject({ state: 'completed', remote: { type: 'MedicationDispense', id: existing } });
    expect(view.steps[2]?.attemptLog).toEqual([expect.objectContaining({ outcome: 'completed', httpStatus: 200 })]);
    const posts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'MedicationDispense' })).filter((e) => e.method === 'POST');
    expect(posts).toHaveLength(1);
  });

  it('holds a dispense that arrives before its prescription, then submits it after the MedicationRequest', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);

    const early = await send(worldDrugDispensed(prescription));
    await send(visit);
    await send(prescription);
    const view = await waitForCase(hub.baseUrl, early.headers.get('location'), dispenseSettled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'awaiting_event']);
    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created', 'MedicationDispense created']);
  });

  it('dead-letters with PRACTITIONER_NOT_FOUND when no practitioner has the pharmacist’s NIK, creating nothing', async () => {
    const { view, posts } = await deliver('PCT500', { pharmacist: { nik: '7209069999999999' } });

    expect(view.steps[2]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PRACTITIONER_NOT_FOUND', pins: null });
    expect(posts).toEqual([]);
  });
});
