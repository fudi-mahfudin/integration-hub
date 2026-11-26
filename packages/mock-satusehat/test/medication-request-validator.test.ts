import { describe, expect, it } from 'vitest';
import { validateMedicationRequest } from '../src/validation/medication-request.js';
import { world } from './support/boot-mock.js';

const ORG = '99000001';
const ENCOUNTER_ID = '5f8d2c8e-7a51-4b0e-9a57-0d7c3f1e9b42';

/** A MedicationRequest body a test can break field by field. */
type Draft = Record<string, unknown>;

/** A prescription the mock must accept: Paracetamol 500 mg tablets (92000001), contained Medication. */
function validMedicationRequest(kfaCode = '92000001', doseFormCode = 'BS066'): Draft {
  return {
    resourceType: 'MedicationRequest',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: kfaCode, display: 'Parasetamol 500 mg Tablet' }] },
      },
    ],
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/prescription/${ORG}`, use: 'official', value: 'RX-1' },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, use: 'official', value: 'RX-1-1' },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community' }] }],
    medicationReference: { reference: '#medication' },
    subject: { reference: 'Patient/P02000000001' },
    encounter: { reference: `Encounter/${ENCOUNTER_ID}` },
    authoredOn: '2026-03-02T01:10:00+00:00',
    requester: { reference: 'Practitioner/10009000001' },
    dispenseRequest: {
      quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: doseFormCode },
      performer: { reference: `Organization/${ORG}` },
    },
    substitution: { allowedBoolean: true },
  };
}

function withChange(change: (m: Draft) => void, draft = validMedicationRequest()): Draft {
  change(draft);
  return draft;
}

const validate = (body: unknown, knownEncounters: readonly string[] = [ENCOUNTER_ID]) =>
  validateMedicationRequest(body, {
    organizationId: ORG,
    kfaProducts: world.kfaProducts,
    kfaIngredients: world.kfaIngredients,
    encounterExists: (id) => knownEncounters.includes(id),
  });

const codesAt = (body: unknown, knownEncounters?: readonly string[]) => validate(body, knownEncounters).map((v) => [v.code, v.path]);

describe('MedicationRequest validator', () => {
  it('accepts a complete prescription of a virtual (92) or an actual (93) product', () => {
    expect(validate(validMedicationRequest())).toEqual([]);
    expect(validate(validMedicationRequest('93000004', 'BS019'))).toEqual([]);
  });

  it('rejects a body that is not an object', () => {
    expect(codesAt('nope')).toEqual([['PAYLOAD_INVALID', 'MedicationRequest']]);
  });

  it.each([
    ['status', 'MedicationRequest.status'],
    ['intent', 'MedicationRequest.intent'],
    ['category', 'MedicationRequest.category'],
    ['subject', 'MedicationRequest.subject'],
    ['encounter', 'MedicationRequest.encounter'],
    ['authoredOn', 'MedicationRequest.authoredOn'],
    ['requester', 'MedicationRequest.requester'],
    ['dispenseRequest', 'MedicationRequest.dispenseRequest.performer'],
  ])('requires %s', (field, path) => {
    const draft = withChange((m) => delete m[field]);
    expect(codesAt(draft)).toContainEqual(['PAYLOAD_INVALID', path]);
  });

  it('requires a medication: a contained Medication with a KFA coding', () => {
    expect(codesAt(withChange((m) => delete m.medicationReference))).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.medication']]);
    expect(codesAt(withChange((m) => (m.medicationReference = { reference: '#other' })))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.medication'],
    ]);
    const noKfa = withChange((m) => (m.contained = [{ resourceType: 'Medication', id: 'medication', code: { coding: [] } }]));
    expect(codesAt(noKfa)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.medication']]);
  });

  it('needs exactly one prescription and one prescription-item identifier under the client organization', () => {
    expect(codesAt(withChange((m) => (m.identifier = [])))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.identifier'],
      ['PAYLOAD_INVALID', 'MedicationRequest.identifier'],
    ]);
    const otherOrg = withChange((m) => {
      m.identifier = [
        { system: 'http://sys-ids.kemkes.go.id/prescription/10000002', value: 'RX-1' },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, value: 'RX-1-1' },
      ];
    });
    expect(codesAt(otherOrg)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.identifier']]);
    const noItem = withChange((m) => {
      m.identifier = [{ system: `http://sys-ids.kemkes.go.id/prescription/${ORG}`, value: 'RX-1' }];
    });
    expect(codesAt(noItem)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.identifier']]);
  });

  it('takes only +00:00 times on or after the floor for authoredOn', () => {
    expect(codesAt(withChange((m) => (m.authoredOn = '2026-03-02T08:10:00+07:00')))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.authoredOn'],
    ]);
    expect(codesAt(withChange((m) => (m.authoredOn = '2014-06-02T23:59:59+00:00')))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.authoredOn'],
    ]);
  });

  it('needs the dispense performer to be the client organization', () => {
    const draft = withChange((m) => (m.dispenseRequest = { ...(m.dispenseRequest as object), performer: { reference: 'Organization/10000002' } }));
    expect(codesAt(draft)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.performer']]);
  });

  it('needs a positive quantity counted in the product’s KFA dose form', () => {
    const wrongForm = validMedicationRequest('92000001', 'BS019');
    expect(codesAt(wrongForm)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.quantity']]);
    const zero = withChange((m) => {
      m.dispenseRequest = { performer: { reference: `Organization/${ORG}` }, quantity: { value: 0, code: 'BS066' } };
    });
    expect(codesAt(zero)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.quantity']]);
  });

  it('rejects a KFA code outside its catalogue as PAYLOAD_INVALID and an ingredient (91) as KFA_LEVEL_INVALID', () => {
    expect(codesAt(validMedicationRequest('93999999'))).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.medication']]);
    expect(codesAt(validMedicationRequest('91000001'))).toEqual([['KFA_LEVEL_INVALID', 'MedicationRequest.medication']]);
  });

  it('rejects an Encounter it does not hold with REFERENCE_NOT_FOUND', () => {
    expect(codesAt(validMedicationRequest(), [])).toEqual([['REFERENCE_NOT_FOUND', 'MedicationRequest.encounter']]);
  });
});
