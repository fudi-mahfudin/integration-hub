import { describe, expect, it } from 'vitest';
import { RULE_CODE_SYSTEM, STEP_CODE_SYSTEM } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { prescriptionSystem, product93, validMedicationRequest } from './support/medication-requests.js';
import { useMock, world } from './support/platform.js';

const ctx = useMock();

/** Creates the visit's Encounter and returns its id. */
const encounterFor = async (visitKey: string) => (await ctx.platform.fhir('POST', '/Encounter', validEncounter(visitKey))).body.id as string;
const search = (prescriptionId: string) =>
  ctx.platform.fhir('GET', `/MedicationRequest?identifier=${encodeURIComponent(`${prescriptionSystem()}|${prescriptionId}`)}`);

const codesOf = (body: any) =>
  body.issue.map((i: any) => ({
    step: i.details.coding.find((c: any) => c.system === STEP_CODE_SYSTEM)?.code,
    rule: i.details.coding.find((c: any) => c.system === RULE_CODE_SYSTEM)?.code,
    path: i.expression[0],
  }));

describe('MedicationRequest create and search', () => {
  it('creates it with an id and versionId, logged under the visit of its Encounter and its prescription identifier', async () => {
    const encounterId = await encounterFor('VISIT-MR-1');

    const r = await ctx.platform.fhir('POST', '/MedicationRequest', validMedicationRequest(encounterId, 'RX-MR-1'));

    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe('string');
    expect(typeof r.body.meta.versionId).toBe('string');
    const [entry] = await ctx.client.log({ resourceType: 'MedicationRequest' });
    expect(entry).toMatchObject({
      method: 'POST',
      visitKey: 'VISIT-MR-1',
      businessIdentifier: `${prescriptionSystem()}|RX-MR-1`,
      effect: 'created',
    });
    expect((await ctx.client.report()).outOfOrderEffects).toEqual([]);
  });

  it('finds it by its prescription/{org} identifier, under its visit; none for an unknown one', async () => {
    const encounterId = await encounterFor('VISIT-MR-2');
    const created = await ctx.platform.fhir('POST', '/MedicationRequest', validMedicationRequest(encounterId, 'RX-MR-2'));

    const hit = await search('RX-MR-2');
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);
    expect(hit.body.entry[0].resource.id).toBe(created.body.id);
    expect((await search('RX-NONE')).body.total).toBe(0);
    const searches = (await ctx.client.log({ resourceType: 'MedicationRequest' })).filter((e) => e.method === 'GET');
    expect(searches.map((e) => e.visitKey)).toEqual(['VISIT-MR-2', null]);
  });

  it('rejects a search by any other identifier system', async () => {
    const r = await ctx.platform.fhir('GET', `/MedicationRequest?identifier=${encodeURIComponent('http://example.org|RX-1')}`);
    expect(r.status).toBe(400);
  });

  it('rejects an Encounter it does not hold with 400 REFERENCE_NOT_FOUND', async () => {
    const r = await ctx.platform.fhir('POST', '/MedicationRequest', validMedicationRequest('00000000-0000-4000-8000-000000000000'));

    expect(r.status).toBe(400);
    expect(codesOf(r.body)).toEqual([{ step: 'REFERENCE_NOT_FOUND', rule: 'REFERENCE_NOT_FOUND', path: 'MedicationRequest.encounter.reference' }]);
    expect((await ctx.client.log({ resourceType: 'MedicationRequest' }))[0]).toMatchObject({ effect: 'none' });
  });
});

type Mutation = (mr: any) => void;
const product91 = world.kfaProducts.find((p) => p.level === 91)!;
const otherForm = world.kfaProducts.find((p) => p.doseForm && p.doseForm.code !== product93.doseForm!.code)!.doseForm!;

// [name, mutation, step code, rule, path]
const rejections: [string, Mutation, string, string, string][] = [
  ['a 91 ingredient code', (m) => (m.contained[0].code.coding[0].code = product91.code), 'KFA_LEVEL_INVALID', 'KFA_LEVEL', 'Medication.code'],
  ['a code not in the KFA catalogue', (m) => (m.contained[0].code.coding[0].code = '93999999'), 'PAYLOAD_INVALID', 'VALUE_SET', 'Medication.code'],
  ['a non-KFA code system', (m) => (m.contained[0].code.coding[0].system = 'http://example.org'), 'PAYLOAD_INVALID', 'REQUIRED', 'Medication.code'],
  ['no medication type extension', (m) => delete m.contained[0].extension, 'PAYLOAD_INVALID', 'REQUIRED', 'Medication.extension'],
  ['no medication/{org} identifier', (m) => delete m.contained[0].identifier, 'PAYLOAD_INVALID', 'REQUIRED', 'Medication.identifier'],
  ['a medicationReference to nothing contained', (m) => (m.medicationReference.reference = '#other'), 'PAYLOAD_INVALID', 'REFERENCE_TYPE', 'MedicationRequest.medicationReference.reference'],
  ['no prescription identifier', (m) => (m.identifier = [m.identifier[1]]), 'PAYLOAD_INVALID', 'IDENTIFIER_SYSTEM', 'MedicationRequest.identifier'],
  ['no prescription-item identifier', (m) => (m.identifier = [m.identifier[0]]), 'PAYLOAD_INVALID', 'IDENTIFIER_SYSTEM', 'MedicationRequest.identifier'],
  ['an unknown status', (m) => (m.status = 'done'), 'PAYLOAD_INVALID', 'VALUE_SET', 'MedicationRequest.status'],
  ['no intent', (m) => delete m.intent, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.intent'],
  ['a subject that is not a Patient', (m) => (m.subject.reference = 'Group/1'), 'PAYLOAD_INVALID', 'REFERENCE_TYPE', 'MedicationRequest.subject.reference'],
  ['no requester', (m) => delete m.requester, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.requester.reference'],
  ['no authoredOn', (m) => delete m.authoredOn, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.authoredOn'],
  ['authoredOn with Z', (m) => (m.authoredOn = '2026-03-01T02:30:00Z'), 'PAYLOAD_INVALID', 'TIME_FORMAT', 'MedicationRequest.authoredOn'],
  ['authoredOn before the floor', (m) => (m.authoredOn = '2014-06-02T23:59:59+00:00'), 'PAYLOAD_INVALID', 'DATE_FLOOR', 'MedicationRequest.authoredOn'],
  ['no dosage timing', (m) => delete m.dosageInstruction[0].timing, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.dosageInstruction[0].timing.repeat'],
  ['no dosage route', (m) => delete m.dosageInstruction[0].route, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.dosageInstruction[0].route'],
  ['no dispenseRequest performer', (m) => delete m.dispenseRequest.performer, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.dispenseRequest.performer.reference'],
  ['a performer of another organization', (m) => (m.dispenseRequest.performer.reference = 'Organization/42'), 'PAYLOAD_INVALID', 'ORGANIZATION_MISMATCH', 'MedicationRequest.dispenseRequest.performer.reference'],
  ['no substitution.allowedBoolean', (m) => delete m.substitution, 'PAYLOAD_INVALID', 'REQUIRED', 'MedicationRequest.substitution.allowed[x]'],
  ['a quantity unit that is not the dose form', (m) => Object.assign(m.dispenseRequest.quantity, { code: otherForm.code, unit: otherForm.name }), 'PAYLOAD_INVALID', 'VALUE_SET', 'MedicationRequest.dispenseRequest.quantity.code'],
];

describe('MedicationRequest validation (the mock\'s own rules, ADR 0006)', () => {
  it.each(rejections)('rejects %s', async (_name, mutate, step, rule, path) => {
    const mr = validMedicationRequest(await encounterFor('VISIT-RULES'));
    mutate(mr);

    const r = await ctx.platform.fhir('POST', '/MedicationRequest', mr);

    expect(r.status).toBe(400);
    expect(codesOf(r.body)).toContainEqual({ step, rule, path });
  });

  it('accepts a 92 code (a prescription may use 92 or 93)', async () => {
    const mr = validMedicationRequest(await encounterFor('VISIT-92'));
    mr.contained[0].code.coding[0].code = product93.parentCode;
    expect((await ctx.platform.fhir('POST', '/MedicationRequest', mr)).status).toBe(201);
  });
});
