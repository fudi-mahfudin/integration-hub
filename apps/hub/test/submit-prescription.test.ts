import { MockClient } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  PRESCRIPTION_SYSTEM,
  satusehatEnv,
  world,
  WORLD_SOURCE,
  WORLD_SOURCE_API_KEY,
  worldDrug,
  worldMappingSeed,
  worldPatient,
  worldPhysician,
  worldPrescriptionWritten,
  worldVisitStarted,
} from './support/satusehat.js';

const prescriptionDone = (v: CaseView) => v.steps[1]?.state === 'completed';
const prescriptionDeadLettered = (v: CaseView) => v.steps[1]?.state === 'dead_lettered';

/** Submit prescription (#29): `prescription.written` → a MedicationRequest at the mock, referencing the visit's Encounter. */
describe('submit prescription', () => {
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

  /** Boots a hub and a worker on this test's database; `env` is spread over the world env. */
  const boot = async (env: Record<string, string> = {}, seedPath?: string) => {
    const full = { ...satusehatEnv(mock.baseUrl, database.url, seedPath), ...env };
    const hub = await bootHub(full);
    running.push(hub);
    running.push(await bootWorker(full));
    const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    return {
      send,
      /** Sends visit.started then `prescription`, and waits until `done`. */
      visit: async (prescription: { visitId: string }, done: (v: CaseView) => boolean) => {
        const opened = await send(worldVisitStarted({ visitId: prescription.visitId }));
        expect(opened.status).toBe(202);
        expect((await send(prescription)).status).toBe(202);
        const view = await waitForCase(hub.baseUrl, opened.headers.get('location') as string, done, { apiKey: WORLD_SOURCE_API_KEY });
        expectAtMostOneStepInMotion(view);
        return view;
      },
    };
  };
  const mrRequests = async () => (await mockClient.log({ resourceType: 'MedicationRequest' })).filter((e) => e.kind === 'platform');
  const mrWrites = async () => (await mrRequests()).filter((e) => e.method === 'POST');
  const kfaRequests = async () => (await mockClient.log()).filter((e) => e.path === '/kfa-v2/products');

  it('visit.started + prescription.written: the mock shows the Encounter created, then the MedicationRequest referencing it', async () => {
    const { visit } = await boot();
    const visitId = `V-${crypto.randomUUID()}`;
    const drug = worldDrug(93).product;

    const view = await visit(worldPrescriptionWritten(visitId), prescriptionDone);

    const effects = (await mockClient.log({ visitKey: visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created', 'MedicationRequest created']);
    const encounterId = (effects[0]!.response.body as { id: string }).id;
    const sent = effects[1]!.request.body as Record<string, any>;
    const unit = { unit: drug.doseForm!.name, system: 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm', code: drug.doseForm!.code };
    expect(sent).toMatchObject({
      resourceType: 'MedicationRequest',
      identifier: [
        { system: PRESCRIPTION_SYSTEM, value: `RX-${visitId}` },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${world.organization.id}`, value: `RX-${visitId}-1` },
      ],
      status: 'completed',
      intent: 'order',
      category: [{ coding: [{ code: 'community' }] }],
      subject: { reference: `Patient/${worldPatient.ihs}` },
      encounter: { reference: `Encounter/${encounterId}` },
      requester: { reference: `Practitioner/${worldPhysician.ihs}` },
      authoredOn: '2026-03-02T01:30:00+00:00',
      dosageInstruction: [
        {
          text: '3 x 1 sesudah makan',
          timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' } },
          route: { coding: [{ code: 'O' }] },
          doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
        },
      ],
      dispenseRequest: { quantity: { value: 10, ...unit }, performer: { reference: `Organization/${world.organization.id}` } },
      substitution: { allowedBoolean: true },
    });
    expect(sent.contained[0].code.coding[0]).toMatchObject({ system: 'http://sys-ids.kemkes.go.id/kfa', code: drug.code });

    const created = effects[1]!.response.body as { id: string; meta: { versionId: string } };
    expect(view).toMatchObject({ status: 'waiting', waitingFor: 'drug.dispensed' });
    expect(view.steps[1]).toMatchObject({
      state: 'completed',
      remote: { type: 'MedicationRequest', id: created.id, version: created.meta.versionId },
      pins: { kfaCode: drug.code, kfaLevel: 93, parent92: drug.parentCode, ingredients: [...drug.ingredientCodes].sort(), requesterIhs: worldPhysician.ihs },
    });
    expect(view.steps[1]!.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'completed', httpStatus: 201, used: { drug: { localCode: worldDrug(93).code, kfaCode: drug.code } } },
    ]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });
  });

  it('a 92 prescription completes and pins no parent 92', async () => {
    const { visit } = await boot();
    const drug = worldDrug(92);

    const view = await visit(worldPrescriptionWritten(newVisit(), { drugCode: drug.code }), prescriptionDone);

    expect(view.steps[1]!.pins).toMatchObject({ kfaCode: drug.product.code, kfaLevel: 92, parent92: null });
  });

  it('an unmapped drugCode dead-letters with MAPPING_MISSING before any KFA or MedicationRequest call', async () => {
    const { visit } = await boot();

    const view = await visit(worldPrescriptionWritten(newVisit(), { drugCode: 'NOT-MAPPED' }), prescriptionDeadLettered);

    expect(view).toMatchObject({ status: 'dead_lettered' });
    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'MAPPING_MISSING', pins: null, remote: null });
    expect(view.steps[1]!.attemptLog).toMatchObject([
      {
        outcome: 'dead_lettered',
        errorCode: 'MAPPING_MISSING',
        used: { drug: { localCode: 'NOT-MAPPED', kfaCode: null } },
        violations: [{ code: 'MAPPING_MISSING', mapping: { kind: 'drug', localCode: 'NOT-MAPPED' } }],
      },
    ]);
    expect(await kfaRequests()).toEqual([]);
    expect(await mrRequests()).toEqual([]);
  });

  it('a mapped KFA code that KFA does not know is MAPPING_MISSING', async () => {
    const seed = worldMappingSeed([{ source: WORLD_SOURCE.id, drugCode: 'GHOST', kfaCode: '93999999' }]);
    const { visit } = await boot({}, seed);

    const view = await visit(worldPrescriptionWritten(newVisit(), { drugCode: 'GHOST' }), prescriptionDeadLettered);

    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'MAPPING_MISSING' });
    expect(view.steps[1]!.attemptLog[0]).toMatchObject({
      httpStatus: 404,
      used: { drug: { localCode: 'GHOST', kfaCode: '93999999' } },
      violations: [{ code: 'MAPPING_MISSING', mapping: { kind: 'drug', localCode: 'GHOST' }, message: expect.stringContaining('93999999') }],
    });
    expect(await mrRequests()).toEqual([]);
  });

  it('a drug mapped to a KFA 91 dead-letters with KFA_LEVEL_INVALID and sends no MedicationRequest', async () => {
    const { visit } = await boot();
    const drug = worldDrug(91);

    const view = await visit(worldPrescriptionWritten(newVisit(), { drugCode: drug.code }), prescriptionDeadLettered);

    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'KFA_LEVEL_INVALID', pins: null });
    expect(view.steps[1]!.attemptLog[0]).toMatchObject({
      errorCode: 'KFA_LEVEL_INVALID',
      used: { drug: { localCode: drug.code, kfaCode: drug.product.code, kfa: { level: 91 } } },
      violations: [{ code: 'KFA_LEVEL_INVALID' }],
    });
    expect(await mrRequests()).toEqual([]);
  });

  it('a KFA product without a dose form gives no quantity unit: PAYLOAD_INVALID before any MedicationRequest write', async () => {
    const p92 = worldDrug(92).product;
    await mockClient.seed({ kfaProducts: [{ code: '93888888', level: 93, display: 'No form', parentCode: p92.code, ingredientCodes: p92.ingredientCodes }] });
    const { visit } = await boot({}, worldMappingSeed([{ source: WORLD_SOURCE.id, drugCode: 'NO-FORM', kfaCode: '93888888' }]));

    const view = await visit(worldPrescriptionWritten(newVisit(), { drugCode: 'NO-FORM' }), prescriptionDeadLettered);

    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'PAYLOAD_INVALID' });
    expect(view.steps[1]!.attemptLog[0]!.violations).toContainEqual(
      expect.objectContaining({ code: 'PAYLOAD_INVALID', rule: 'REQUIRED', path: 'MedicationRequest.dispenseRequest.quantity.code' }),
    );
    expect(await mrWrites()).toEqual([]);
  });

  it('an unknown requester dead-letters with PRACTITIONER_NOT_FOUND', async () => {
    const { visit } = await boot();

    const view = await visit(worldPrescriptionWritten(newVisit(), {}, { requester: { nik: '9900000000000000' } }), prescriptionDeadLettered);

    expect(view.steps[1]).toMatchObject({ deadLetterReason: 'PRACTITIONER_NOT_FOUND' });
    expect(await mrWrites()).toEqual([]);
  });

  it.each([
    { kind: 'http_503' as const, params: {} },
    { kind: 'timeout' as const, params: { ms: 100 } },
  ])('a KFA $kind is transient: the step waits and retries, then completes', async ({ kind, params }) => {
    await mockClient.setFaults({ seed: 1, rules: [{ id: 'kfa-down', match: { path: '/kfa-v2/products' }, kind, firstN: 1, params }] });
    const { visit } = await boot({ WORKER_RETRY_DELAY_MS: '10' });

    const view = await visit(worldPrescriptionWritten(newVisit()), prescriptionDone);

    const log = view.steps[1]!.attemptLog;
    expect(log.map((a) => a.outcome)).toEqual(['retry_wait', 'completed']);
    if (kind === 'http_503') expect(log[0]!.httpStatus).toBe(503);
    expect(await mrWrites()).toHaveLength(1);
  });

  it('fetches a KFA product once and stores it: a second case with the same drug asks KFA nothing', async () => {
    const { visit } = await boot();

    await visit(worldPrescriptionWritten(newVisit()), prescriptionDone);
    await visit(worldPrescriptionWritten(newVisit()), prescriptionDone);

    expect((await kfaRequests()).map((e) => e.request.query.code)).toEqual([worldDrug(93).product.code]);
    expect(await mrWrites()).toHaveLength(2);
  });

  it('search-then-create: a MedicationRequest already at the platform under prescription/{org} is adopted, not created again', async () => {
    const { visit } = await boot();
    const visitId = newVisit();
    const planted = await mockClient.insertRecord({
      resourceType: 'MedicationRequest',
      identifier: [{ system: PRESCRIPTION_SYSTEM, value: `RX-${visitId}` }],
      status: 'completed',
      intent: 'order',
      subject: { reference: `Patient/${worldPatient.ihs}` },
    } as never);

    const view = await visit(worldPrescriptionWritten(visitId), prescriptionDone);

    expect(view.steps[1]!.remote).toMatchObject({ type: 'MedicationRequest', id: (planted as { id: string }).id });
    expect(await mrWrites()).toEqual([]);
  });
});

const newVisit = () => `V-${crypto.randomUUID()}`;
