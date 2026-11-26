import { describe, expect, it } from 'vitest';
import { validateMedicationDispense } from '../src/validation/medication-dispense.js';
import { world } from './support/boot-mock.js';

const ORG = '99000001';
const ENCOUNTER_ID = '5f8d2c8e-7a51-4b0e-9a57-0d7c3f1e9b42';
const MEDICATION_REQUEST_ID = '0b6f6c1e-8a0e-4d55-9b4b-3f1f1d7f2a10';
const REQUESTER = 'Practitioner/10009000001';
const PHARMACIST = 'Practitioner/10009000030';

/** A MedicationDispense body a test can break field by field. */
type Draft = Record<string, unknown>;

/** The substitution of a dispense the source declared, with a reason. */
const substituted = {
  wasSubstituted: true,
  type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution', code: 'G' }] },
  reason: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'OS' }] }],
  responsibleParty: [{ reference: REQUESTER }, { reference: PHARMACIST }],
};

/** A dispense the mock must accept: Paracetamol 500 mg (Fiktif Farma A, 93000001), not a substitution. */
function validDispense(kfaCode = '93000001', substitution: unknown = { wasSubstituted: false }, doseFormCode = 'BS066'): Draft {
  return {
    resourceType: 'MedicationDispense',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: kfaCode, display: 'Parasetamol 500 mg Tablet (Fiktif Farma A)' }] },
        batch: { lotNumber: 'LOT-1', expirationDate: '2027-04-24' },
      },
    ],
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/prescription/${ORG}`, use: 'official', value: 'RX-1' },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, use: 'official', value: 'ITEM-1' },
    ],
    status: 'completed',
    medicationReference: { reference: '#medication' },
    subject: { reference: 'Patient/P02000000001' },
    context: { reference: `Encounter/${ENCOUNTER_ID}` },
    performer: [{ actor: { reference: PHARMACIST } }],
    authorizingPrescription: [{ reference: `MedicationRequest/${MEDICATION_REQUEST_ID}` }],
    quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: doseFormCode },
    whenPrepared: '2026-03-02T01:20:00+00:00',
    whenHandedOver: '2026-03-02T01:30:00+00:00',
    substitution,
  };
}

function withChange(change: (d: Draft) => void, draft = validDispense()): Draft {
  change(draft);
  return draft;
}

/** Validates against a platform holding one Encounter and one MedicationRequest prescribing `prescribed`. */
const validate = (body: unknown, prescribed = '92000001', held = { encounter: ENCOUNTER_ID, medicationRequest: MEDICATION_REQUEST_ID }) =>
  validateMedicationDispense(body, {
    organizationId: ORG,
    kfaProducts: world.kfaProducts,
    kfaIngredients: world.kfaIngredients,
    encounterExists: (id) => id === held.encounter,
    prescribedKfaCode: (id) => (id === held.medicationRequest ? prescribed : undefined),
  });

const codesAt = (body: unknown, prescribed?: string) => validate(body, prescribed).map((v) => [v.code, v.path]);

describe('MedicationDispense validator', () => {
  it('accepts a complete dispense of a child of the prescribed virtual product, not substituted', () => {
    expect(validate(validDispense())).toEqual([]);
  });

  it('rejects a body that is not an object', () => {
    expect(codesAt('nope')).toEqual([['PAYLOAD_INVALID', 'MedicationDispense']]);
  });

  it.each([
    ['status', 'MedicationDispense.status'],
    ['subject', 'MedicationDispense.subject'],
    ['context', 'MedicationDispense.context'],
    ['performer', 'MedicationDispense.performer'],
    ['authorizingPrescription', 'MedicationDispense.authorizingPrescription'],
    ['quantity', 'MedicationDispense.quantity'],
    ['whenPrepared', 'MedicationDispense.whenPrepared'],
    ['whenHandedOver', 'MedicationDispense.whenHandedOver'],
    ['substitution', 'MedicationDispense.substitution.wasSubstituted'],
    ['medicationReference', 'MedicationDispense.medication'],
  ])('requires %s', (field, path) => {
    expect(codesAt(withChange((d) => delete d[field]))).toEqual([['PAYLOAD_INVALID', path]]);
  });

  it('needs exactly one prescription and one prescription-item identifier under the client organization', () => {
    expect(codesAt(withChange((d) => (d.identifier = [])))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationDispense.identifier'],
      ['PAYLOAD_INVALID', 'MedicationDispense.identifier'],
    ]);
    const otherOrg = withChange((d) => {
      d.identifier = [
        { system: 'http://sys-ids.kemkes.go.id/prescription/10000002', value: 'RX-1' },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, value: 'ITEM-1' },
      ];
    });
    expect(codesAt(otherOrg)).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.identifier']]);
  });

  it.each(['whenPrepared', 'whenHandedOver'])('takes only a +00:00 %s on or after the floor', (field) => {
    expect(codesAt(withChange((d) => (d[field] = '2026-03-02T08:20:00+07:00')))).toEqual([['PAYLOAD_INVALID', `MedicationDispense.${field}`]]);
    expect(codesAt(withChange((d) => (d[field] = '2014-06-02T23:59:59+00:00')))).toEqual([['PAYLOAD_INVALID', `MedicationDispense.${field}`]]);
  });

  it('takes a batch with a lot number and a plain expiry date on or after the floor, or no batch', () => {
    const batch = (value: unknown) => withChange((d) => ((d.contained as Draft[])[0] = { ...(d.contained as Draft[])[0], batch: value }));
    expect(codesAt(batch(undefined))).toEqual([]);
    expect(codesAt(batch({ lotNumber: 'LOT-1', expirationDate: '2014-06-02' }))).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.contained.Medication.batch.expirationDate']]);
    expect(codesAt(batch({ lotNumber: 'LOT-1', expirationDate: '2027-02-30' }))).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.contained.Medication.batch.expirationDate']]);
    expect(codesAt(batch({ expirationDate: '2027-04-24' }))).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.contained.Medication.batch.lotNumber']]);
  });

  it('rejects a dispense of a virtual product (92) or an ingredient (91) as KFA_LEVEL_INVALID', () => {
    expect(codesAt(validDispense('92000001'))).toEqual([['KFA_LEVEL_INVALID', 'MedicationDispense.medication']]);
    expect(codesAt(validDispense('91000001'))).toEqual([['KFA_LEVEL_INVALID', 'MedicationDispense.medication']]);
  });

  it.each<[string, string, string, unknown, string[][]]>([
    ['the prescribed actual product, not substituted', '93000001', '93000001', { wasSubstituted: false }, []],
    ['another brand of the prescribed actual product, substituted', '93000001', '93000002', substituted, []],
    ['another strength with the same ingredients, substituted', '92000001', '93000003', substituted, []],
    ['a child of the prescribed virtual product, substituted', '92000001', '93000002', substituted, [['SUBSTITUTION_MISMATCH', 'MedicationDispense.substitution.wasSubstituted']]],
    ['another strength, not substituted', '92000001', '93000003', { wasSubstituted: false }, [['SUBSTITUTION_MISMATCH', 'MedicationDispense.substitution.wasSubstituted']]],
    ['different active ingredients', '92000001', '93000007', substituted, [['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION', 'MedicationDispense.medication']]],
    ['a 91 superset', '92000003', '93000006', substituted, [['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION', 'MedicationDispense.medication']]],
  ])('judges %s against the held prescription', (_, prescribed, dispensed, substitution, expected) => {
    expect(codesAt(validDispense(dispensed, substitution), prescribed)).toEqual(expected);
  });

  it('needs a substitution to say its type, its reason and who is responsible', () => {
    expect(codesAt(validDispense('93000003', { wasSubstituted: true }))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationDispense.substitution.type'],
      ['PAYLOAD_INVALID', 'MedicationDispense.substitution.reason'],
      ['PAYLOAD_INVALID', 'MedicationDispense.substitution.responsibleParty'],
    ]);
  });

  it('rejects an authorizingPrescription or a context it does not hold with REFERENCE_NOT_FOUND', () => {
    expect(validate(validDispense(), '92000001', { encounter: ENCOUNTER_ID, medicationRequest: 'other' }).map((v) => [v.code, v.path])).toEqual([
      ['REFERENCE_NOT_FOUND', 'MedicationDispense.authorizingPrescription'],
    ]);
    expect(validate(validDispense(), '92000001', { encounter: 'other', medicationRequest: MEDICATION_REQUEST_ID }).map((v) => [v.code, v.path])).toEqual([
      ['REFERENCE_NOT_FOUND', 'MedicationDispense.context'],
    ]);
  });

  it('needs a positive quantity counted in the dispensed product’s KFA dose form', () => {
    expect(codesAt(validDispense('93000001', { wasSubstituted: false }, 'BS019'))).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.quantity']]);
    expect(codesAt(withChange((d) => (d.quantity = { value: 0, unit: 'Tablet', code: 'BS066' })))).toEqual([['PAYLOAD_INVALID', 'MedicationDispense.quantity']]);
  });
});
