import { describe, expect, it } from 'vitest';
import { deadLetterReason, validateStep, type StepCheck, type Violation } from '../src/validation/validation.js';

/**
 * The Validation module's public pure interface (#9, #28): what a step is
 * about to send in, violations out, in rule order. Expected values come from
 * the rule text in #9, not from the module.
 */

const ORG = '99000001';

const codes = (vs: Violation[]) => vs.map((v) => v.code);

describe('validation: MAPPING_MISSING', () => {
  it.each([
    { name: 'every mapping found', mappings: [{ kind: 'location', localCode: 'POLI-1', found: true }], expected: [] },
    {
      name: 'a missing location',
      mappings: [{ kind: 'location', localCode: 'POLI-X', found: false }],
      expected: [{ code: 'MAPPING_MISSING', mapping: { kind: 'location', localCode: 'POLI-X' } }],
    },
    {
      name: 'a missing drug next to a found location',
      mappings: [
        { kind: 'location', localCode: 'POLI-1', found: true },
        { kind: 'drug', localCode: 'AMX-500', found: false },
      ],
      expected: [{ code: 'MAPPING_MISSING', mapping: { kind: 'drug', localCode: 'AMX-500' } }],
    },
    {
      name: 'two missing, both reported',
      mappings: [
        { kind: 'location', localCode: 'POLI-X', found: false },
        { kind: 'drug', localCode: 'AMX-500', found: false },
      ],
      expected: [
        { code: 'MAPPING_MISSING', mapping: { kind: 'location', localCode: 'POLI-X' } },
        { code: 'MAPPING_MISSING', mapping: { kind: 'drug', localCode: 'AMX-500' } },
      ],
    },
  ] as const)('$name', ({ mappings, expected }) => {
    const violations = validateStep({ organizationId: ORG, mappings: [...mappings] });
    expect(violations).toMatchObject(expected);
    expect(violations).toHaveLength(expected.length);
  });

  it('a missing mapping is the dead-letter reason; nothing to send means no reason', () => {
    expect(deadLetterReason(validateStep({ organizationId: ORG, mappings: [{ kind: 'location', localCode: 'X', found: false }] }))).toBe(
      'MAPPING_MISSING',
    );
    expect(deadLetterReason(validateStep({ organizationId: ORG, mappings: [] }))).toBeUndefined();
  });
});

// Synthetic KFA products (91 = ingredient, 92 = product template, 93 = branded product).
const AMOXICILLIN = 'K91-AMX';
const CLAVULANATE = 'K91-CLV';
const amx500Template = { code: 'K92-AMX500', level: 92, parent92: null, ingredients: [AMOXICILLIN] } as const;
const amx500BrandA = { code: 'K93-AMX500-A', level: 93, parent92: 'K92-AMX500', ingredients: [AMOXICILLIN] } as const;
const amx500BrandB = { code: 'K93-AMX500-B', level: 93, parent92: 'K92-AMX500', ingredients: [AMOXICILLIN] } as const;
const amx250Brand = { code: 'K93-AMX250', level: 93, parent92: 'K92-AMX250', ingredients: [AMOXICILLIN] } as const;
const coAmoxiclav = { code: 'K93-AMXCLV', level: 93, parent92: 'K92-AMXCLV', ingredients: [CLAVULANATE, AMOXICILLIN] } as const;
const coAmoxiclavOther = { code: 'K93-AMXCLV-B', level: 93, parent92: 'K92-AMXCLV-B', ingredients: [AMOXICILLIN, CLAVULANATE] } as const;
const amoxicillinIngredient = { code: AMOXICILLIN, level: 91, parent92: null, ingredients: [AMOXICILLIN] } as const;

describe('validation: KFA level, substitution class, substitution declaration', () => {
  it.each([
    { name: 'prescription of a 92', medication: { role: 'prescription', product: amx500Template }, expected: [] },
    { name: 'prescription of a 93', medication: { role: 'prescription', product: amx500BrandA }, expected: [] },
    { name: 'prescription of a 91', medication: { role: 'prescription', product: amoxicillinIngredient }, expected: ['KFA_LEVEL_INVALID'] },
    {
      name: 'dispense of a 92',
      medication: { role: 'dispense', product: amx500Template, prescribed: amx500Template, declaredSubstitution: false },
      expected: ['KFA_LEVEL_INVALID'],
    },
    {
      name: 'dispense of a 91',
      medication: { role: 'dispense', product: amoxicillinIngredient, prescribed: amx500Template, declaredSubstitution: false },
      expected: ['KFA_LEVEL_INVALID'],
    },
    {
      name: 'dispense of the prescribed 93, none declared',
      medication: { role: 'dispense', product: amx500BrandA, prescribed: amx500BrandA, declaredSubstitution: false },
      expected: [],
    },
    {
      name: 'dispense of a child of the prescribed 92, none declared',
      medication: { role: 'dispense', product: amx500BrandB, prescribed: amx500Template, declaredSubstitution: false },
      expected: [],
    },
    {
      name: 'brand swap of a prescribed 93 (same 91 set), declared',
      medication: { role: 'dispense', product: amx500BrandB, prescribed: amx500BrandA, declaredSubstitution: true },
      expected: [],
    },
    {
      name: 'strength change of a prescribed 92 (same 91 set), declared',
      medication: { role: 'dispense', product: amx250Brand, prescribed: amx500Template, declaredSubstitution: true },
      expected: [],
    },
    {
      name: '91 sets equal regardless of order, declared',
      medication: { role: 'dispense', product: coAmoxiclavOther, prescribed: coAmoxiclav, declaredSubstitution: true },
      expected: [],
    },
    {
      name: 'a substitution the source did not declare',
      medication: { role: 'dispense', product: amx250Brand, prescribed: amx500Template, declaredSubstitution: false },
      expected: ['SUBSTITUTION_MISMATCH'],
    },
    {
      name: 'a declared substitution that is the prescribed product',
      medication: { role: 'dispense', product: amx500BrandA, prescribed: amx500BrandA, declaredSubstitution: true },
      expected: ['SUBSTITUTION_MISMATCH'],
    },
    {
      name: 'a declared substitution that is a child of the prescribed 92',
      medication: { role: 'dispense', product: amx500BrandB, prescribed: amx500Template, declaredSubstitution: true },
      expected: ['SUBSTITUTION_MISMATCH'],
    },
    {
      name: 'a different 91 set (therapeutic substitution), declared',
      medication: { role: 'dispense', product: coAmoxiclav, prescribed: amx500Template, declaredSubstitution: true },
      expected: ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'],
    },
    {
      name: 'a different 91 set, undeclared: one violation, not also a mismatch',
      medication: { role: 'dispense', product: amx500BrandA, prescribed: coAmoxiclav, declaredSubstitution: false },
      expected: ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'],
    },
    {
      name: 'a 91 superset is a different set',
      medication: { role: 'dispense', product: coAmoxiclav, prescribed: amx500BrandA, declaredSubstitution: true },
      expected: ['UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'],
    },
  ] as const)('$name', ({ medication, expected }) => {
    expect(codes(validateStep({ organizationId: ORG, medication } as StepCheck))).toEqual(expected);
  });
});

describe('validation: rule order', () => {
  it('reports every violation, ordered by rule, and the reason is the first', () => {
    const violations = validateStep({
      organizationId: ORG,
      // Listed out of order on purpose: payload first, mapping last.
      resource: { resourceType: 'Encounter' },
      medication: { role: 'prescription', product: amoxicillinIngredient },
      mappings: [{ kind: 'drug', localCode: 'AMX-500', found: false }],
    });

    const order = [...new Set(codes(violations))];
    expect(order).toEqual(['MAPPING_MISSING', 'KFA_LEVEL_INVALID', 'PAYLOAD_INVALID']);
    expect(deadLetterReason(violations)).toBe('MAPPING_MISSING');
  });

  it.each([
    [['PAYLOAD_INVALID', 'SUBSTITUTION_MISMATCH'], 'SUBSTITUTION_MISMATCH'],
    [['PAYLOAD_INVALID', 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'], 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION'],
    [['PAYLOAD_INVALID'], 'PAYLOAD_INVALID'],
  ] as const)('given %j the reason is %s', (given, reason) => {
    const violations = given.map((code) => ({ code, path: '', message: '' }));
    expect(deadLetterReason(violations)).toBe(reason);
  });
});

/** A create visit Encounter as #9 and the create visit step describe it. */
const validEncounter = (): Record<string, any> => ({
  resourceType: 'Encounter',
  identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-1' }],
  status: 'arrived',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  subject: { reference: 'Patient/P02478375538' },
  participant: [{ individual: { reference: 'Practitioner/N10000001' } }],
  period: { start: '2026-03-02T01:00:00+00:00' },
  location: [{ location: { reference: 'Location/b017aa54-f1df-4ec2-9d84-8823815d7228' } }],
  statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
  serviceProvider: { reference: `Organization/${ORG}` },
});

type Edit = (e: Record<string, any>) => void;

describe('validation: PAYLOAD_INVALID for an Encounter', () => {
  it('a valid create visit Encounter has no violations', () => {
    expect(validateStep({ organizationId: ORG, resource: validEncounter() })).toEqual([]);
  });

  it.each<[string, Edit, { rule: string; path: string }[]]>([
    ['no identifier', (e) => delete e.identifier, [{ rule: 'REQUIRED', path: 'Encounter.identifier' }]],
    ['identifier of another org', (e) => (e.identifier[0].system = 'http://sys-ids.kemkes.go.id/encounter/12345678'), [{ rule: 'IDENTIFIER_SYSTEM', path: 'Encounter.identifier' }]],
    ['identifier with a /{subsystem}', (e) => (e.identifier[0].system += '/rj'), [{ rule: 'IDENTIFIER_SYSTEM', path: 'Encounter.identifier' }]],
    ['identifier without a value', (e) => (e.identifier[0].value = ''), [{ rule: 'REQUIRED', path: 'Encounter.identifier[0].value' }]],
    ['no status', (e) => delete e.status, [{ rule: 'REQUIRED', path: 'Encounter.status' }]],
    ['status outside the value set', (e) => (e.status = 'started'), [{ rule: 'VALUE_SET', path: 'Encounter.status' }]],
    ['no class', (e) => delete e.class, [{ rule: 'REQUIRED', path: 'Encounter.class' }]],
    ['class code outside AMB/IMP/EMER', (e) => (e.class.code = 'HH'), [{ rule: 'VALUE_SET', path: 'Encounter.class.code' }]],
    ['class from another code system', (e) => (e.class.system = 'http://example.org'), [{ rule: 'VALUE_SET', path: 'Encounter.class.system' }]],
    ['no subject', (e) => delete e.subject, [{ rule: 'REQUIRED', path: 'Encounter.subject.reference' }]],
    ['subject is not a Patient', (e) => (e.subject.reference = 'Practitioner/N1'), [{ rule: 'REFERENCE', path: 'Encounter.subject.reference' }]],
    ['subject id is not a FHIR id', (e) => (e.subject.reference = 'Patient/has space'), [{ rule: 'REFERENCE', path: 'Encounter.subject.reference' }]],
    ['no participant', (e) => (e.participant = []), [{ rule: 'REQUIRED', path: 'Encounter.participant' }]],
    ['participant is not a Practitioner', (e) => (e.participant[0].individual.reference = 'Patient/P1'), [{ rule: 'REFERENCE', path: 'Encounter.participant[0].individual.reference' }]],
    ['no period.start', (e) => (e.period = {}), [{ rule: 'REQUIRED', path: 'Encounter.period.start' }]],
    ['period.start with Z', (e) => (e.period.start = '2026-03-02T01:00:00Z'), [{ rule: 'TIME_FORMAT', path: 'Encounter.period.start' }]],
    ['period.start with +07:00', (e) => (e.period.start = '2026-03-02T08:00:00+07:00'), [{ rule: 'TIME_FORMAT', path: 'Encounter.period.start' }]],
    ['period.start with a fraction', (e) => (e.period.start = '2026-03-02T01:00:00.5+00:00'), [{ rule: 'TIME_FORMAT', path: 'Encounter.period.start' }]],
    ['period.start a date only', (e) => (e.period.start = '2026-03-02'), [{ rule: 'TIME_FORMAT', path: 'Encounter.period.start' }]],
    ['period.start not a real date', (e) => (e.period.start = '2026-02-30T01:00:00+00:00'), [{ rule: 'TIME_FORMAT', path: 'Encounter.period.start' }]],
    ['period.start before the floor', (e) => (e.period.start = '2014-06-02T23:59:59+00:00'), [{ rule: 'DATE_FLOOR', path: 'Encounter.period.start' }]],
    ['period.end before the floor', (e) => (e.period.end = '2010-01-01T00:00:00+00:00'), [{ rule: 'DATE_FLOOR', path: 'Encounter.period.end' }]],
    ['statusHistory time with Z', (e) => (e.statusHistory[0].period.start = '2026-03-02T01:00:00Z'), [{ rule: 'TIME_FORMAT', path: 'Encounter.statusHistory[0].period.start' }]],
    ['no location', (e) => delete e.location, [{ rule: 'REQUIRED', path: 'Encounter.location' }]],
    ['location id is not a FHIR id', (e) => (e.location[0].location.reference = 'Location/bad id!'), [{ rule: 'REFERENCE', path: 'Encounter.location[0].location.reference' }]],
    ['no serviceProvider', (e) => delete e.serviceProvider, [{ rule: 'REQUIRED', path: 'Encounter.serviceProvider.reference' }]],
    ['serviceProvider is another org', (e) => (e.serviceProvider.reference = 'Organization/12345678'), [{ rule: 'IDENTIFIER_SYSTEM', path: 'Encounter.serviceProvider.reference' }]],
    [
      'two faults, both reported',
      (e) => {
        delete e.status;
        e.period.start = '2026-03-02';
      },
      [
        { rule: 'REQUIRED', path: 'Encounter.status' },
        { rule: 'TIME_FORMAT', path: 'Encounter.period.start' },
      ],
    ],
  ])('%s', (_name, edit, expected) => {
    const resource = validEncounter();
    edit(resource);
    const violations = validateStep({ organizationId: ORG, resource });
    expect(violations.map((v) => ({ code: v.code, rule: v.rule, path: v.path }))).toEqual(
      expected.map((x) => ({ code: 'PAYLOAD_INVALID', ...x })),
    );
  });

  it('the floor itself is allowed', () => {
    const atFloor = validEncounter();
    atFloor.period.start = '2014-06-03T00:00:00+00:00';
    expect(validateStep({ organizationId: ORG, resource: atFloor })).toEqual([]);
  });

  it('a resource type without payload rules is a violation, so a new step cannot skip validation', () => {
    expect(validateStep({ organizationId: ORG, resource: { resourceType: 'Observation' } })).toMatchObject([
      { code: 'PAYLOAD_INVALID', rule: 'RESOURCE_TYPE' },
    ]);
  });
});
