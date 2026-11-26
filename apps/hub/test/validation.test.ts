import { describe, expect, it } from 'vitest';
import { SourceSystems } from '../src/auth/source-systems.js';
import { parseKfaProduct, type KfaProduct } from '../src/kfa/kfa-product.js';
import { validateStepPayload, type StepPayload } from '../src/validation/validation.js';

const ORG = new SourceSystems([{ id: 's', organizationId: '10000001', apiKey: 'k' }]).authenticate('Bearer k').organizationId;

/** A create visit Encounter that passes every rule; overrides are shallow-merged. */
function encounter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Encounter',
    identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-1' }],
    status: 'arrived',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: 'Patient/P02478375538' },
    participant: [{ individual: { reference: 'Practitioner/10009880728' } }],
    period: { start: '2026-03-02T01:00:00+00:00' },
    location: [{ location: { reference: 'Location/b017aa54-f1df-4ec2-9d84-8823815d7228' } }],
    statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
    serviceProvider: { reference: `Organization/${ORG}` },
    ...overrides,
  };
}

const createVisit = (overrides: Partial<Extract<StepPayload, { step: 'create_visit' }>> = {}): StepPayload => ({
  step: 'create_visit',
  organizationId: ORG,
  missingMappings: [],
  encounter: encounter(),
  ...overrides,
});

const codes = (payload: StepPayload) => validateStepPayload(payload).map((v) => v.code);

describe('validateStepPayload: MAPPING_MISSING', () => {
  it('a valid create visit has no violations', () => {
    expect(validateStepPayload(createVisit())).toEqual([]);
  });

  it('a location code with no mapping is MAPPING_MISSING, naming the kind and local code; nothing was built', () => {
    expect(
      validateStepPayload(createVisit({ missingMappings: [{ kind: 'location', localCode: 'POLI-X' }], encounter: null })),
    ).toEqual([{ code: 'MAPPING_MISSING', path: null, message: expect.stringContaining('location "POLI-X"') }]);
  });
});

describe('validateStepPayload: PAYLOAD_INVALID on a create visit Encounter', () => {
  const OTHER_SYSTEM = 'http://sys-ids.kemkes.go.id/encounter/10000002';
  const time = (start: unknown) => ({ period: { start }, statusHistory: [{ status: 'arrived', period: { start } }] });

  it.each<[string, Record<string, unknown>, string]>([
    ['resourceType is not Encounter', { resourceType: 'Patient' }, 'Encounter.resourceType'],
    ['no identifier', { identifier: undefined }, 'Encounter.identifier'],
    ['no identifier under encounter/{org}', { identifier: [{ system: 'http://example.org/visit', value: 'V-1' }] }, 'Encounter.identifier'],
    ['two encounter/{org} identifiers', { identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-1' }, { system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-2' }] }, 'Encounter.identifier'],
    ["the identifier's {org} is not the case's", { identifier: [{ system: OTHER_SYSTEM, value: 'V-1' }] }, 'Encounter.identifier'],
    ['an identifier with an empty value', { identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: '' }] }, 'Encounter.identifier'],
    ['no status', { status: undefined }, 'Encounter.status'],
    ['no class code', { class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' } }, 'Encounter.class'],
    ['subject is not a Patient reference', { subject: { reference: 'Practitioner/1' } }, 'Encounter.subject'],
    ['no participant', { participant: [] }, 'Encounter.participant'],
    ['a participant without a Practitioner', { participant: [{ individual: { reference: 'Patient/1' } }] }, 'Encounter.participant[0].individual'],
    ['no location', { location: undefined }, 'Encounter.location'],
    ['a location that is not a Location reference', { location: [{ location: { reference: 'Location/' } }] }, 'Encounter.location[0].location'],
    ['no statusHistory', { statusHistory: [] }, 'Encounter.statusHistory'],
    ['a statusHistory entry without a status', { statusHistory: [{ period: { start: '2026-03-02T01:00:00+00:00' } }] }, 'Encounter.statusHistory[0].status'],
    ['a statusHistory entry without a start', { statusHistory: [{ status: 'arrived', period: {} }] }, 'Encounter.statusHistory[0].period.start'],
    ['no period.start', { period: {} }, 'Encounter.period.start'],
    ['no serviceProvider', { serviceProvider: undefined }, 'Encounter.serviceProvider'],
    ["a serviceProvider that is not the case's organization", { serviceProvider: { reference: 'Organization/10000002' } }, 'Encounter.serviceProvider'],
    ['finished without period.end', { status: 'finished' }, 'Encounter.period.end'],
    ['finished with an end not after its start', { status: 'finished', period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T01:00:00+00:00' } }, 'Encounter.period.end'],
  ])('%s', (_name, overrides, path) => {
    expect(validateStepPayload(createVisit({ encounter: encounter(overrides) }))).toEqual([
      { code: 'PAYLOAD_INVALID', path, message: expect.stringContaining(path) },
    ]);
  });

  it.each<[string, unknown]>([
    ['a Z time', '2026-03-02T01:00:00Z'],
    ['a +07:00 time', '2026-03-02T08:00:00+07:00'],
    ['fractional seconds', '2026-03-02T01:00:00.000+00:00'],
    ['a date only', '2026-03-02'],
    ['an impossible date', '2026-02-30T01:00:00+00:00'],
    ['hour 24', '2026-03-02T24:00:00+00:00'],
    ['a number', 1772413200000],
    ['a time before the 2014-06-03 floor', '2014-06-02T23:59:59+00:00'],
  ])('a time that is %s is PAYLOAD_INVALID wherever it appears', (_name, value) => {
    const violations = validateStepPayload(createVisit({ encounter: encounter(time(value)) }));
    expect(violations.map((v) => v.code)).toEqual(['PAYLOAD_INVALID', 'PAYLOAD_INVALID']);
    expect(violations.map((v) => v.path).sort()).toEqual(['Encounter.period.start', 'Encounter.statusHistory[0].period.start']);
  });

  it('the floor itself is allowed', () => {
    expect(validateStepPayload(createVisit({ encounter: encounter(time('2014-06-03T00:00:00+00:00')) }))).toEqual([]);
  });

  it('a finished Encounter with an end after its start is valid', () => {
    const period = { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T01:00:01+00:00' };
    expect(validateStepPayload(createVisit({ encounter: encounter({ status: 'finished', period }) }))).toEqual([]);
  });

  it('a body that is not an object is PAYLOAD_INVALID', () => {
    expect(codes(createVisit({ encounter: [] }))).toEqual(['PAYLOAD_INVALID']);
  });

  it('nothing built with no mapping missing is PAYLOAD_INVALID: a hub bug, not a configuration problem', () => {
    expect(codes(createVisit({ encounter: null }))).toEqual(['PAYLOAD_INVALID']);
  });

  it('reports every violation at once', () => {
    expect(codes(createVisit({ encounter: encounter({ status: undefined, subject: undefined, period: {} }) }))).toEqual([
      'PAYLOAD_INVALID',
      'PAYLOAD_INVALID',
      'PAYLOAD_INVALID',
    ]);
  });
});

/** A KFA product as the KFA details give it. */
const kfa = (code: string, level: number, activeIngredients: string[], parent92: string | null = null): KfaProduct =>
  parseKfaProduct({ code, level, parent92, activeIngredients });

// Paracetamol 500 mg tablet (92) and two actual products derived from it (93);
// paracetamol 650 mg (93) of another virtual product; amoxicillin (93).
const PARACETAMOL_500 = kfa('92000101', 92, ['91000001']);
const PARACETAMOL_500_BRAND_A = kfa('93000101', 93, ['91000001'], '92000101');
const PARACETAMOL_500_BRAND_B = kfa('93000102', 93, ['91000001'], '92000101');
const PARACETAMOL_650 = kfa('93000201', 93, ['91000001'], '92000201');
const AMOXICILLIN = kfa('93000301', 93, ['91000002'], '92000301');
const AMOXICLAV = kfa('93000401', 93, ['91000003', '91000002'], '92000401');
const AMOXICLAV_OTHER_BRAND = kfa('93000402', 93, ['91000002', '91000003'], '92000402');
const INGREDIENT = kfa('91000001', 91, []);

/** A prescription's MedicationRequest that passes every PAYLOAD_INVALID rule; overrides are shallow-merged. */
function medicationRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'MedicationRequest',
    contained: [
      { resourceType: 'Medication', id: 'medication', code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '92000101' }] } },
    ],
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/prescription/${ORG}`, value: 'RX-1' },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, value: 'ITEM-1' },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community' }] }],
    medicationReference: { reference: '#medication' },
    subject: { reference: 'Patient/P02478375538' },
    encounter: { reference: 'Encounter/5f8d2c8e-7a51-4b0e-9a57-0d7c3f1e9b42' },
    authoredOn: '2026-03-02T01:10:00+00:00',
    requester: { reference: 'Practitioner/10009880728' },
    dispenseRequest: {
      quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS066' },
      performer: { reference: `Organization/${ORG}` },
    },
    substitution: { allowedBoolean: true },
    ...overrides,
  };
}

const prescription = (product: KfaProduct | null, missing = product === null, built: unknown = missing ? null : medicationRequest()): StepPayload => ({
  step: 'submit_prescription',
  organizationId: ORG,
  missingMappings: missing ? [{ kind: 'drug', localCode: 'OBAT-1' }] : [],
  product,
  medicationRequest: built,
});

const dispense = (
  prescribed: KfaProduct,
  dispensed: KfaProduct | null,
  declaredSubstitution: boolean,
): StepPayload => ({
  step: 'submit_dispense',
  missingMappings: dispensed === null ? [{ kind: 'drug', localCode: 'OBAT-2' }] : [],
  prescribed,
  dispensed,
  declaredSubstitution,
});

describe('validateStepPayload: KFA_LEVEL_INVALID', () => {
  it.each<[string, KfaProduct, string[]]>([
    ['a virtual product (92) may be prescribed', PARACETAMOL_500, []],
    ['an actual product (93) may be prescribed', PARACETAMOL_500_BRAND_A, []],
    ['an ingredient (91) may not be prescribed', INGREDIENT, ['KFA_LEVEL_INVALID']],
    ['an unknown level may not be prescribed', kfa('94000001', 94, ['91000001']), ['KFA_LEVEL_INVALID']],
  ])('%s', (_name, product, expected) => {
    expect(codes(prescription(product))).toEqual(expected);
  });

  it('a dispense of a virtual product (92) is KFA_LEVEL_INVALID, and no substitution is judged', () => {
    expect(codes(dispense(PARACETAMOL_500, PARACETAMOL_500, false))).toEqual(['KFA_LEVEL_INVALID']);
    expect(codes(dispense(PARACETAMOL_500, kfa('92000201', 92, ['91000002']), false))).toEqual(['KFA_LEVEL_INVALID']);
  });

  it('a prescription whose drug code has no mapping is MAPPING_MISSING only', () => {
    expect(validateStepPayload(prescription(null))).toEqual([
      { code: 'MAPPING_MISSING', path: null, message: expect.stringContaining('drug "OBAT-1"') },
    ]);
  });
});

describe('validateStepPayload: substitution on a dispense', () => {
  it.each<[string, KfaProduct, KfaProduct, boolean, string[]]>([
    ['the prescribed actual product, not declared', PARACETAMOL_500_BRAND_A, PARACETAMOL_500_BRAND_A, false, []],
    ['a child of the prescribed virtual product, not declared', PARACETAMOL_500, PARACETAMOL_500_BRAND_B, false, []],
    ['another brand of the same virtual product, declared', PARACETAMOL_500_BRAND_A, PARACETAMOL_500_BRAND_B, true, []],
    ['another strength with the same 91 set, declared', PARACETAMOL_500, PARACETAMOL_650, true, []],
    ['the same 91 set in another order, declared', AMOXICLAV, AMOXICLAV_OTHER_BRAND, true, []],
    ['another strength, not declared', PARACETAMOL_500, PARACETAMOL_650, false, ['SUBSTITUTION_MISMATCH']],
    ['the prescribed actual product, declared', PARACETAMOL_500_BRAND_A, PARACETAMOL_500_BRAND_A, true, ['SUBSTITUTION_MISMATCH']],
    ['a child of the prescribed virtual product, declared', PARACETAMOL_500, PARACETAMOL_500_BRAND_A, true, ['SUBSTITUTION_MISMATCH']],
    ['different active ingredients, declared', PARACETAMOL_500, AMOXICILLIN, true, ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION']],
    ['different active ingredients, not declared', PARACETAMOL_500_BRAND_A, AMOXICILLIN, false, ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION']],
    ['a 91 superset, declared', AMOXICILLIN, AMOXICLAV, true, ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION']],
    ['a 91 subset, declared', AMOXICLAV, AMOXICILLIN, true, ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION']],
  ])('%s', (_name, prescribed, dispensed, declared, expected) => {
    expect(codes(dispense(prescribed, dispensed, declared))).toEqual(expected);
  });

  it('a dispensed drug code with no mapping is MAPPING_MISSING only', () => {
    expect(codes(dispense(PARACETAMOL_500, null, false))).toEqual(['MAPPING_MISSING']);
  });
});

describe('validateStepPayload: rule order', () => {
  it('lists violations in rule order, whatever order they were found in', () => {
    const payload = createVisit({
      missingMappings: [{ kind: 'location', localCode: 'POLI-X' }],
      encounter: encounter({ status: undefined }),
    });
    expect(codes(payload)).toEqual(['MAPPING_MISSING', 'PAYLOAD_INVALID']);
  });
});

describe('validateStepPayload: a prescription’s MedicationRequest', () => {
  const pathsOf = (built: unknown) =>
    validateStepPayload(prescription(PARACETAMOL_500, false, built)).map((v) => [v.code, v.path]);
  const without = (field: string) => {
    const built = medicationRequest();
    delete built[field];
    return built;
  };

  it('a complete MedicationRequest passes', () => {
    expect(pathsOf(medicationRequest())).toEqual([]);
  });

  it.each([
    ['status', 'MedicationRequest.status'],
    ['intent', 'MedicationRequest.intent'],
    ['category', 'MedicationRequest.category'],
    ['subject', 'MedicationRequest.subject'],
    ['encounter', 'MedicationRequest.encounter'],
    ['authoredOn', 'MedicationRequest.authoredOn'],
    ['requester', 'MedicationRequest.requester'],
    ['medicationReference', 'MedicationRequest.medicationReference'],
  ])('%s is mandatory', (field, path) => {
    expect(pathsOf(without(field))).toEqual([['PAYLOAD_INVALID', path]]);
  });

  it('takes the payload constants only: completed, order, community, substitution allowed', () => {
    const built = medicationRequest({
      status: 'active',
      intent: 'plan',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'inpatient' }] }],
      substitution: { allowedBoolean: false },
    });
    expect(pathsOf(built)).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.status'],
      ['PAYLOAD_INVALID', 'MedicationRequest.intent'],
      ['PAYLOAD_INVALID', 'MedicationRequest.category'],
      ['PAYLOAD_INVALID', 'MedicationRequest.substitution.allowedBoolean'],
    ]);
  });

  it('needs the case organization as the dispense performer, and a quantity with a value and a dose-form unit', () => {
    const built = medicationRequest({ dispenseRequest: { quantity: { value: 0 }, performer: { reference: 'Organization/10000002' } } });
    expect(pathsOf(built)).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.performer'],
      ['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.quantity.value'],
      ['PAYLOAD_INVALID', 'MedicationRequest.dispenseRequest.quantity'],
    ]);
  });

  it('takes authoredOn only as a +00:00 time not before the floor', () => {
    expect(pathsOf(medicationRequest({ authoredOn: '2026-03-02T08:10:00+07:00' }))).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.authoredOn']]);
    expect(pathsOf(medicationRequest({ authoredOn: '2014-06-02T23:59:59+00:00' }))).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.authoredOn']]);
  });

  it('needs one prescription and one prescription-item identifier of the case organization', () => {
    const otherOrg = medicationRequest({
      identifier: [
        { system: 'http://sys-ids.kemkes.go.id/prescription/10000002', value: 'RX-1' },
        { system: `http://sys-ids.kemkes.go.id/prescription-item/${ORG}`, value: 'ITEM-1' },
      ],
    });
    expect(pathsOf(otherOrg)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.identifier']]);
    expect(pathsOf(medicationRequest({ identifier: [] }))).toEqual([
      ['PAYLOAD_INVALID', 'MedicationRequest.identifier'],
      ['PAYLOAD_INVALID', 'MedicationRequest.identifier'],
    ]);
  });

  it('needs the contained Medication coded by KFA', () => {
    const built = medicationRequest({ contained: [{ resourceType: 'Medication', id: 'medication', code: { coding: [] } }] });
    expect(pathsOf(built)).toEqual([['PAYLOAD_INVALID', 'MedicationRequest.contained.Medication.code']]);
  });

  it('puts KFA_LEVEL_INVALID before PAYLOAD_INVALID, and logs both', () => {
    expect(codes(prescription(INGREDIENT, false, without('requester')))).toEqual(['KFA_LEVEL_INVALID', 'PAYLOAD_INVALID']);
  });

  it('a drug code mapped to a code KFA does not know is MAPPING_MISSING, naming both codes', () => {
    const payload: StepPayload = {
      step: 'submit_prescription',
      organizationId: ORG,
      missingMappings: [{ kind: 'kfa', localCode: 'OBAT-1', kfaCode: kfa('93999999', 93, []).code }],
      product: null,
      medicationRequest: null,
    };
    expect(validateStepPayload(payload)).toEqual([
      { code: 'MAPPING_MISSING', path: null, message: 'the drug "OBAT-1" maps to KFA 93999999, which KFA does not know' },
    ]);
  });
});
