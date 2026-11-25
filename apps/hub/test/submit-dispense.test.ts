import { MockClient } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  drugCode,
  PRESCRIPTION_SYSTEM,
  satusehatEnv,
  world,
  WORLD_LOCATIONS,
  WORLD_SOURCE,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldMappingSeed,
  worldPatient,
  worldPharmacist,
  worldPhysician,
  worldPrescriptionWritten,
  worldVisitStarted,
  writeMappingSeed,
} from './support/satusehat.js';

// World KFA products (packages/mock-satusehat/world): 92000001 Paracetamol 500 mg with brands 93000001/93000002,
// 93000003 Paracetamol 650 mg (same 91 set, another 92), 93000005 Amoxicillin (another 91 set).
const PCT500 = '92000001';
const PCT500_A = '93000001';
const PCT500_B = '93000002';
const PCT650_A = '93000003';
const AMOXICILLIN_A = '93000005';
const product = (code: string) => world.kfaProducts.find((p) => p.code === code)!;

const SUBSTITUTION_TYPE = { system: 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution', code: 'G' };

const dispenseSettled = (v: CaseView) => ['completed', 'dead_lettered'].includes(v.steps[2]?.state ?? '');

/** Submit dispense (#30): `drug.dispensed` → a MedicationDispense authorised by the case's MedicationRequest. */
describe('submit dispense', () => {
  let mock: RunningMock;
  let mockClient: MockClient;
  let database: FreshDatabase;
  const running: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    mock = await startMock();
    mockClient = new MockClient(mock.baseUrl);
  });

  beforeEach(async () => {
    await mockClient.reset();
    database = await createFreshDatabase();
  });

  afterEach(async () => {
    for (const p of running.splice(0).reverse()) await p.close();
    await database?.drop();
  });

  afterAll(async () => {
    await mock?.close();
  });

  const boot = async (seedPath?: string) => {
    const env = satusehatEnv(mock.baseUrl, database.url, seedPath);
    const hub = await bootHub(env);
    running.push(hub);
    running.push(await bootWorker(env));
    const send = async (body: unknown) => {
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
      expect(res.status, await res.clone().text()).toBe(202);
      return res.headers.get('location') as string;
    };
    const wait = async (location: string, done: (v: CaseView) => boolean) => {
      const view = await waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY });
      expectAtMostOneStepInMotion(view);
      return view;
    };
    return {
      send,
      wait,
      /** visit.started, prescription.written of `prescribed`, then `dispensed`; waits until the dispense step settles. */
      visit: async (prescribed: string, dispensed: Record<string, unknown>) => {
        const visitId = `V-${crypto.randomUUID()}`;
        const location = await send(worldVisitStarted({ visitId }));
        await send(worldPrescriptionWritten(visitId, { drugCode: drugCode(prescribed) }));
        await send(worldDrugDispensed(visitId, dispensed));
        return { visitId, view: await wait(location, dispenseSettled) };
      },
    };
  };

  const mdRequests = async () => (await mockClient.log({ resourceType: 'MedicationDispense' })).filter((e) => e.kind === 'platform');
  const mdSent = async () => {
    const created = (await mdRequests()).filter((e) => e.effect === 'created');
    expect(created).toHaveLength(1);
    return created[0]!.request.body as Record<string, any>;
  };

  it('happy path: the prescribed 93 dispensed becomes a completed MedicationDispense authorised by the MedicationRequest', async () => {
    const { visit } = await boot();

    const { visitId, view } = await visit(PCT500_A, {});

    const effects = (await mockClient.log({ visitKey: visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created', 'MedicationDispense created']);
    const encounterId = (effects[0]!.response.body as { id: string }).id;
    const medicationRequestId = (effects[1]!.response.body as { id: string }).id;
    const sent = effects[2]!.request.body as Record<string, any>;
    const dispensed = product(PCT500_A);
    expect(sent).toMatchObject({
      resourceType: 'MedicationDispense',
      identifier: [
        { system: PRESCRIPTION_SYSTEM, value: `RX-${visitId}` },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${world.organization.id}`, value: `RX-${visitId}-1` },
      ],
      status: 'completed',
      subject: { reference: `Patient/${worldPatient.ihs}` },
      context: { reference: `Encounter/${encounterId}` },
      performer: [{ actor: { reference: `Practitioner/${worldPharmacist.ihs}` } }],
      authorizingPrescription: [{ reference: `MedicationRequest/${medicationRequestId}` }],
      quantity: { value: 10, code: dispensed.doseForm!.code, unit: dispensed.doseForm!.name },
      whenPrepared: '2026-03-02T02:00:00+00:00',
      whenHandedOver: '2026-03-02T02:10:00+00:00',
    });
    // Not substituted: only the flag (#9).
    expect(sent.substitution).toEqual({ wasSubstituted: false });
    // The expiry stays a plain date (#9).
    expect(sent.contained[0]).toMatchObject({
      resourceType: 'Medication',
      code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: PCT500_A }] },
      batch: { lotNumber: 'LOT-2026-01', expirationDate: '2028-01-31' },
    });

    const created = effects[2]!.response.body as { id: string; meta: { versionId: string } };
    expect(view).toMatchObject({ status: 'waiting', waitingFor: 'visit.finished' });
    expect(view.steps[2]).toMatchObject({
      state: 'completed',
      remote: { type: 'MedicationDispense', id: created.id, version: created.meta.versionId },
      pins: { kfaCode: PCT500_A, kfaLevel: 93, parent92: PCT500, ingredients: dispensed.ingredientCodes, pharmacistIhs: worldPharmacist.ihs, wasSubstituted: false },
    });
    expect(view.steps[2]!.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'completed', httpStatus: 201, used: { drug: { localCode: drugCode(PCT500_A), kfaCode: PCT500_A }, pharmacist: { ihsNumber: worldPharmacist.ihs } } },
    ]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });
  });

  it('a child 93 of a prescribed 92 is not a substitution; a dispense without batch sends no batch', async () => {
    const { visit } = await boot();

    // `undefined` drops the field from the JSON body.
    const { view } = await visit(PCT500, { drugCode: drugCode(PCT500_B), batch: undefined });

    expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { kfaCode: PCT500_B, wasSubstituted: false } });
    const sent = await mdSent();
    expect(sent.substitution).toEqual({ wasSubstituted: false });
    expect(sent.contained[0].batch).toBeUndefined();
  });

  it('strength substitution: another strength of the same ingredient, declared, is sent as a G substitution', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: drugCode(PCT650_A), substitution: { reasonCode: 'OS' } });

    expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { kfaCode: PCT650_A, parent92: '92000002', wasSubstituted: true } });
    expect((await mdSent()).substitution).toEqual({
      wasSubstituted: true,
      type: { coding: [expect.objectContaining(SUBSTITUTION_TYPE)] },
      reason: [{ coding: [expect.objectContaining({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'OS' })] }],
      responsibleParty: [{ reference: `Practitioner/${worldPhysician.ihs}` }, { reference: `Practitioner/${worldPharmacist.ihs}` }],
    });
  });

  it.each([
    { reasonCode: 'FP', system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'FP' },
    { reasonCode: 'DRUG_INTERACTION', system: 'http://terminology.kemkes.go.id', code: 'TK000017' },
    { reasonCode: 'PATIENT_CHOICE', system: 'http://terminology.kemkes.go.id', code: 'TK000018' },
    { reasonCode: 'PRESCRIPTION_ERROR', system: 'http://snomed.info/sct', code: '661000124108' },
  ])('brand substitution of a prescribed 93, reason $reasonCode → $system $code', async ({ reasonCode, system, code }) => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: drugCode(PCT500_B), substitution: { reasonCode } });

    expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { kfaCode: PCT500_B, wasSubstituted: true } });
    const sent = await mdSent();
    expect(sent.substitution).toMatchObject({ wasSubstituted: true, type: { coding: [SUBSTITUTION_TYPE] }, reason: [{ coding: [{ system, code }] }] });
  });

  it('therapeutic substitution (another 91 set) dead-letters with UNSUPPORTED_THERAPEUTIC_SUBSTITUTION before any MedicationDispense call', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: drugCode(AMOXICILLIN_A), substitution: { reasonCode: 'OS' } });

    expect(view).toMatchObject({ status: 'dead_lettered' });
    expect(view.steps[2]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION', pins: null, remote: null });
    expect(view.steps[2]!.attemptLog).toMatchObject([
      { outcome: 'dead_lettered', errorCode: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION', used: { drug: { kfaCode: AMOXICILLIN_A } }, violations: [{ code: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION' }] },
    ]);
    expect(view.steps[3]).toMatchObject({ state: 'awaiting_event' });
    expect(await mdRequests()).toEqual([]);
  });

  it('a substitution the source did not declare dead-letters with SUBSTITUTION_MISMATCH', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: drugCode(PCT650_A) });

    expect(view.steps[2]).toMatchObject({ deadLetterReason: 'SUBSTITUTION_MISMATCH' });
    expect(view.steps[2]!.attemptLog[0]!.violations).toMatchObject([{ code: 'SUBSTITUTION_MISMATCH', message: expect.stringContaining('declared no substitution') }]);
    expect(await mdRequests()).toEqual([]);
  });

  it('a declared substitution of the prescribed product dead-letters with SUBSTITUTION_MISMATCH', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500, { drugCode: drugCode(PCT500_B), substitution: { reasonCode: 'OS' } });

    expect(view.steps[2]).toMatchObject({ deadLetterReason: 'SUBSTITUTION_MISMATCH' });
    expect(view.steps[2]!.attemptLog[0]!.violations).toMatchObject([{ code: 'SUBSTITUTION_MISMATCH', message: expect.stringContaining('declared a substitution') }]);
    expect(await mdRequests()).toEqual([]);
  });

  it('a dispensed drug mapped to a 92 dead-letters with KFA_LEVEL_INVALID', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: drugCode(PCT500) });

    expect(view.steps[2]).toMatchObject({ deadLetterReason: 'KFA_LEVEL_INVALID' });
    expect(view.steps[2]!.attemptLog[0]).toMatchObject({ used: { drug: { kfa: { level: 92 } } }, violations: [{ code: 'KFA_LEVEL_INVALID' }] });
    expect(await mdRequests()).toEqual([]);
  });

  it('an unmapped dispensed drug dead-letters with MAPPING_MISSING, naming the local code', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { drugCode: 'NOT-MAPPED' });

    expect(view.steps[2]).toMatchObject({ deadLetterReason: 'MAPPING_MISSING' });
    expect(view.steps[2]!.attemptLog[0]!.violations).toMatchObject([{ code: 'MAPPING_MISSING', mapping: { kind: 'drug', localCode: 'NOT-MAPPED' } }]);
  });

  it('an unknown pharmacist dead-letters with PRACTITIONER_NOT_FOUND', async () => {
    const { visit } = await boot();

    const { view } = await visit(PCT500_A, { pharmacist: { nik: '9900000000000000' } });

    expect(view.steps[2]).toMatchObject({ deadLetterReason: 'PRACTITIONER_NOT_FOUND' });
    expect((await mdRequests()).filter((e) => e.method === 'POST')).toEqual([]);
  });

  it('compares against the pinned prescribed product, not the live mapping', async () => {
    const seed = (kfaCode: string) =>
      writeMappingSeed(
        WORLD_LOCATIONS.map((l) => ({ source: WORLD_SOURCE.id, locationCode: l.code, locationId: l.id })),
        [
          { source: WORLD_SOURCE.id, drugCode: 'RX-DRUG', kfaCode },
          { source: WORLD_SOURCE.id, drugCode: drugCode(PCT500_A), kfaCode: PCT500_A },
        ],
      );
    const first = await boot(seed(PCT500_A));
    const visitId = `V-${crypto.randomUUID()}`;
    const location = await first.send(worldVisitStarted({ visitId }));
    await first.send(worldPrescriptionWritten(visitId, { drugCode: 'RX-DRUG' }));
    await first.wait(location, (v) => v.steps[1]?.state === 'completed');
    // The operator remaps the prescription's local code to another ingredient; a new hub loads the seed.
    const second = await boot(seed(AMOXICILLIN_A));

    await second.send(worldDrugDispensed(visitId, { drugCode: drugCode(PCT500_A) }));
    const view = await second.wait(location, dispenseSettled);

    expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { kfaCode: PCT500_A, wasSubstituted: false } });
  });

  it('search-then-create: a MedicationDispense already at the platform under prescription/{org} is adopted, not created again', async () => {
    const { send, wait } = await boot(worldMappingSeed());
    const visitId = `V-${crypto.randomUUID()}`;
    const planted = (await mockClient.insertRecord({
      resourceType: 'MedicationDispense',
      identifier: [{ system: PRESCRIPTION_SYSTEM, value: `RX-${visitId}` }],
      status: 'completed',
      subject: { reference: `Patient/${worldPatient.ihs}` },
    } as never)) as { id: string };

    const location = await send(worldVisitStarted({ visitId }));
    await send(worldPrescriptionWritten(visitId));
    await send(worldDrugDispensed(visitId));
    const view = await wait(location, dispenseSettled);

    expect(view.steps[2]).toMatchObject({ state: 'completed', remote: { type: 'MedicationDispense', id: planted.id } });
    expect((await mdRequests()).filter((e) => e.method === 'POST')).toEqual([]);
  });
});
