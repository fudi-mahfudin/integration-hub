import { describe, expect, it } from 'vitest';
import { RULE_CODE_SYSTEM, STEP_CODE_SYSTEM } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { substitutedTo, validMedicationDispense } from './support/medication-dispenses.js';
import { prescriptionSystem, product93, validMedicationRequest } from './support/medication-requests.js';
import { useMock, world } from './support/platform.js';

const ctx = useMock();

const codesOf = (body: any) =>
  body.issue.map((i: any) => ({
    step: i.details.coding.find((c: any) => c.system === STEP_CODE_SYSTEM)?.code,
    rule: i.details.coding.find((c: any) => c.system === RULE_CODE_SYSTEM)?.code,
    path: i.expression[0],
  }));

/** Creates the visit's Encounter and its MedicationRequest (of `prescribedCode`, default `product93`); returns both ids. */
async function prescribed(visitKey: string, prescriptionId: string, prescribedCode = product93.code) {
  const encounterId = (await ctx.platform.fhir('POST', '/Encounter', validEncounter(visitKey))).body.id as string;
  const mr = validMedicationRequest(encounterId, prescriptionId);
  mr.contained[0].code.coding[0].code = prescribedCode;
  const created = await ctx.platform.fhir('POST', '/MedicationRequest', mr);
  expect(created.status).toBe(201);
  return { encounterId, medicationRequestId: created.body.id as string };
}

const dispense = (md: unknown) => ctx.platform.fhir('POST', '/MedicationDispense', md);
const search = (prescriptionId: string) =>
  ctx.platform.fhir('GET', `/MedicationDispense?identifier=${encodeURIComponent(`${prescriptionSystem()}|${prescriptionId}`)}`);

// World products: 93000001/2 are Paracetamol 500 mg brands under 92000001, 93000003 is Paracetamol 650 mg, 93000005 Amoxicillin.
const BRAND_B = '93000002';
const OTHER_STRENGTH = '93000003';
const OTHER_INGREDIENT = '93000005';
const TEMPLATE = product93.parentCode!;

describe('MedicationDispense create and search', () => {
  it('creates it, logged under the visit of its context Encounter and its prescription identifier, after the MedicationRequest', async () => {
    const { encounterId, medicationRequestId } = await prescribed('VISIT-MD-1', 'RX-MD-1');

    const r = await dispense(validMedicationDispense(encounterId, medicationRequestId, 'RX-MD-1'));

    expect(r.status).toBe(201);
    expect(typeof r.body.meta.versionId).toBe('string');
    const [entry] = await ctx.client.log({ resourceType: 'MedicationDispense' });
    expect(entry).toMatchObject({ method: 'POST', visitKey: 'VISIT-MD-1', businessIdentifier: `${prescriptionSystem()}|RX-MD-1`, effect: 'created' });
    expect(await ctx.client.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [] });
  });

  it('finds it by its prescription/{org} identifier, under its visit; none for an unknown one', async () => {
    const { encounterId, medicationRequestId } = await prescribed('VISIT-MD-2', 'RX-MD-2');
    const created = await dispense(validMedicationDispense(encounterId, medicationRequestId, 'RX-MD-2'));

    const hit = await search('RX-MD-2');
    expect(hit.body.total).toBe(1);
    expect(hit.body.entry[0].resource.id).toBe(created.body.id);
    expect((await search('RX-NONE')).body.total).toBe(0);
    const searches = (await ctx.client.log({ resourceType: 'MedicationDispense' })).filter((e) => e.method === 'GET');
    expect(searches.map((e) => e.visitKey)).toEqual(['VISIT-MD-2', null]);
  });

  it('rejects an authorizingPrescription it does not hold with 400 REFERENCE_NOT_FOUND (rule 10394)', async () => {
    const { encounterId } = await prescribed('VISIT-MD-3', 'RX-MD-3');

    const r = await dispense(validMedicationDispense(encounterId, '00000000-0000-4000-8000-000000000000', 'RX-MD-3'));

    expect(r.status).toBe(400);
    expect(codesOf(r.body)).toEqual([
      { step: 'REFERENCE_NOT_FOUND', rule: 'REFERENCE_NOT_FOUND', path: 'MedicationDispense.authorizingPrescription[0].reference' },
    ]);
  });

  it('rejects a context Encounter it does not hold with 400 REFERENCE_NOT_FOUND', async () => {
    const { medicationRequestId } = await prescribed('VISIT-MD-4', 'RX-MD-4');

    const r = await dispense(validMedicationDispense('00000000-0000-4000-8000-000000000000', medicationRequestId, 'RX-MD-4'));

    expect(codesOf(r.body)).toContainEqual({ step: 'REFERENCE_NOT_FOUND', rule: 'REFERENCE_NOT_FOUND', path: 'MedicationDispense.context.reference' });
  });
});

describe('MedicationDispense KFA and substitution (the mock\'s own rules, ADR 0006)', () => {
  it.each([
    { name: 'the prescribed 93, not substituted', prescribedCode: product93.code, edit: (md: any) => md },
    { name: 'a brand swap of a prescribed 93, substituted', prescribedCode: product93.code, edit: (md: any) => substitutedTo(md, BRAND_B) },
    { name: 'another strength of the same ingredient, substituted', prescribedCode: product93.code, edit: (md: any) => substitutedTo(md, OTHER_STRENGTH) },
    {
      name: 'a child of the prescribed 92, not substituted',
      prescribedCode: TEMPLATE,
      edit: (md: any) => ((md.contained[0].code.coding[0].code = BRAND_B), md),
    },
    { name: 'a non-child of the prescribed 92 with its ingredients, substituted', prescribedCode: TEMPLATE, edit: (md: any) => substitutedTo(md, OTHER_STRENGTH) },
  ])('accepts $name', async ({ prescribedCode, edit }) => {
    const id = `RX-OK-${Math.random().toString(36).slice(2)}`;
    const { encounterId, medicationRequestId } = await prescribed(`VISIT-${id}`, id, prescribedCode);

    const r = await dispense(edit(validMedicationDispense(encounterId, medicationRequestId, id)));

    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  type Case = { name: string; prescribedCode?: string; edit: (md: any) => void; step: string; rule: string; path: string };
  it.each<Case>([
    { name: 'a 92 on dispense', edit: (md) => (md.contained[0].code.coding[0].code = TEMPLATE), step: 'KFA_LEVEL_INVALID', rule: 'KFA_LEVEL', path: 'Medication.code' },
    {
      name: 'another active ingredient (therapeutic substitution)',
      edit: (md) => substitutedTo(md, OTHER_INGREDIENT),
      step: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
      rule: 'KFA_PARENTAGE',
      path: 'Medication.code',
    },
    {
      name: 'a 93 that is no child of the prescribed 92 and has other ingredients',
      prescribedCode: TEMPLATE,
      edit: (md) => (md.contained[0].code.coding[0].code = OTHER_INGREDIENT),
      step: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
      rule: 'KFA_PARENTAGE',
      path: 'Medication.code',
    },
    {
      name: 'a brand swap sent as not substituted',
      edit: (md) => (md.contained[0].code.coding[0].code = BRAND_B),
      step: 'SUBSTITUTION_MISMATCH',
      rule: 'WAS_SUBSTITUTED',
      path: 'MedicationDispense.substitution.wasSubstituted',
    },
    {
      name: 'the prescribed product sent as substituted',
      edit: (md) => substitutedTo(md, product93.code),
      step: 'SUBSTITUTION_MISMATCH',
      rule: 'WAS_SUBSTITUTED',
      path: 'MedicationDispense.substitution.wasSubstituted',
    },
    {
      name: 'a substitution without responsibleParty',
      edit: (md) => delete substitutedTo(md, BRAND_B).substitution.responsibleParty,
      step: 'PAYLOAD_INVALID',
      rule: 'REQUIRED',
      path: 'MedicationDispense.substitution.responsibleParty',
    },
    {
      name: 'a substitution without type',
      edit: (md) => delete substitutedTo(md, BRAND_B).substitution.type,
      step: 'PAYLOAD_INVALID',
      rule: 'REQUIRED',
      path: 'MedicationDispense.substitution.type',
    },
    { name: 'no wasSubstituted', edit: (md) => delete md.substitution, step: 'PAYLOAD_INVALID', rule: 'REQUIRED', path: 'MedicationDispense.substitution.wasSubstituted' },
  ])('rejects $name', async ({ prescribedCode, edit, step, rule, path }) => {
    const id = `RX-NO-${Math.random().toString(36).slice(2)}`;
    const { encounterId, medicationRequestId } = await prescribed(`VISIT-${id}`, id, prescribedCode);
    const md = validMedicationDispense(encounterId, medicationRequestId, id);
    edit(md);

    const r = await dispense(md);

    expect(r.status).toBe(400);
    expect(codesOf(r.body)).toContainEqual({ step, rule, path });
  });
});

type Mutation = (md: any) => void;
const otherForm = world.kfaProducts.find((p) => p.doseForm && p.doseForm.code !== product93.doseForm!.code)!.doseForm!;

// [name, mutation, rule, path]; all PAYLOAD_INVALID
const rejections: [string, Mutation, string, string][] = [
  ['no prescription identifier', (m) => (m.identifier = [m.identifier[1]]), 'IDENTIFIER_SYSTEM', 'MedicationDispense.identifier'],
  ['no status', (m) => delete m.status, 'REQUIRED', 'MedicationDispense.status'],
  ['an unknown status', (m) => (m.status = 'done'), 'VALUE_SET', 'MedicationDispense.status'],
  ['a medicationReference to nothing contained', (m) => (m.medicationReference.reference = '#other'), 'REFERENCE_TYPE', 'MedicationDispense.medicationReference.reference'],
  ['a batch without expiry', (m) => delete m.contained[0].batch.expirationDate, 'REQUIRED', 'Medication.batch.expirationDate'],
  ['an expiry before the floor', (m) => (m.contained[0].batch.expirationDate = '2014-06-02'), 'DATE_FLOOR', 'Medication.batch.expirationDate'],
  ['an expiry that is not a date', (m) => (m.contained[0].batch.expirationDate = '31-01-2028'), 'TIME_FORMAT', 'Medication.batch.expirationDate'],
  ['no subject', (m) => delete m.subject, 'REQUIRED', 'MedicationDispense.subject.reference'],
  ['no context', (m) => delete m.context, 'REQUIRED', 'MedicationDispense.context.reference'],
  ['no performer actor', (m) => delete m.performer, 'REQUIRED', 'MedicationDispense.performer[0].actor.reference'],
  ['no authorizingPrescription', (m) => delete m.authorizingPrescription, 'REQUIRED', 'MedicationDispense.authorizingPrescription[0].reference'],
  ['whenPrepared with Z', (m) => (m.whenPrepared = '2026-03-01T03:00:00Z'), 'TIME_FORMAT', 'MedicationDispense.whenPrepared'],
  ['whenHandedOver before the floor', (m) => (m.whenHandedOver = '2014-06-02T23:59:59+00:00'), 'DATE_FLOOR', 'MedicationDispense.whenHandedOver'],
  ['a quantity unit that is not the dose form', (m) => Object.assign(m.quantity, { code: otherForm.code }), 'VALUE_SET', 'MedicationDispense.quantity.code'],
];

describe('MedicationDispense payload validation (the mock\'s own rules, ADR 0006)', () => {
  it.each(rejections)('rejects %s', async (_name, mutate, rule, path) => {
    const id = `RX-P-${Math.random().toString(36).slice(2)}`;
    const { encounterId, medicationRequestId } = await prescribed(`VISIT-${id}`, id);
    const md = validMedicationDispense(encounterId, medicationRequestId, id);
    mutate(md);

    const r = await dispense(md);

    expect(r.status).toBe(400);
    expect(codesOf(r.body)).toContainEqual({ step: 'PAYLOAD_INVALID', rule, path });
  });
});
