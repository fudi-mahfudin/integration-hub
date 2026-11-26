import { describe, expect, it } from 'vitest';
import { validateEncounter } from '../src/validation/encounter.js';

const ORG = '99000001';

/** An Encounter body a test can break field by field. */
type Draft = Record<string, unknown>;

/** A create-visit Encounter the mock must accept. */
function validEncounter(): Record<string, unknown> {
  return {
    resourceType: 'Encounter',
    identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-1' }],
    status: 'arrived',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: 'Patient/P02000000001', display: 'Budi Santoso' },
    participant: [{ individual: { reference: 'Practitioner/10009000001' } }],
    period: { start: '2026-03-02T01:00:00+00:00' },
    location: [{ location: { reference: 'Location/5b1c0e0a-0000-4000-8000-000000000001' } }],
    statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
    serviceProvider: { reference: `Organization/${ORG}` },
  };
}

function withChange(change: (e: Draft) => void): Record<string, unknown> {
  const encounter = validEncounter();
  change(encounter);
  return encounter;
}

describe('Encounter validator', () => {
  it('accepts a complete create-visit Encounter', () => {
    expect(validateEncounter(validEncounter())).toEqual([]);
  });

  it('accepts a finished Encounter whose period ends after it starts', () => {
    const finished = withChange((e) => {
      e.status = 'finished';
      e.period = { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:00:00+00:00' };
    });
    expect(validateEncounter(finished)).toEqual([]);
  });

  it.each([
    ['resourceType is not Encounter', (e: Draft) => (e.resourceType = 'Patient'), 'Encounter.resourceType'],
    ['identifier missing (10117)', (e: Draft) => delete e.identifier, 'Encounter.identifier'],
    ['status missing', (e: Draft) => delete e.status, 'Encounter.status'],
    ['class missing', (e: Draft) => delete e.class, 'Encounter.class'],
    ['class has no code', (e: Draft) => (e.class = { system: 'x' }), 'Encounter.class'],
    ['subject missing (10118)', (e: Draft) => delete e.subject, 'Encounter.subject'],
    ['subject is not a Patient reference', (e: Draft) => (e.subject = { reference: 'Group/1' }), 'Encounter.subject'],
    ['participant missing (10119)', (e: Draft) => delete e.participant, 'Encounter.participant'],
    ['participant without individual (10119)', (e: Draft) => (e.participant = [{}]), 'Encounter.participant[0].individual'],
    ['participant is not a Practitioner', (e: Draft) => (e.participant = [{ individual: { reference: 'Patient/1' } }]), 'Encounter.participant[0].individual'],
    ['period.start missing (10123)', (e: Draft) => (e.period = {}), 'Encounter.period.start'],
    ['location missing (10120)', (e: Draft) => delete e.location, 'Encounter.location'],
    ['location without a Location reference (10120)', (e: Draft) => (e.location = [{ location: {} }]), 'Encounter.location[0].location'],
    ['statusHistory missing (10122)', (e: Draft) => delete e.statusHistory, 'Encounter.statusHistory'],
    ['statusHistory entry without period.start', (e: Draft) => (e.statusHistory = [{ status: 'arrived', period: {} }]), 'Encounter.statusHistory[0].period.start'],
    ['serviceProvider missing (10124)', (e: Draft) => delete e.serviceProvider, 'Encounter.serviceProvider'],
  ])('rejects when %s', (_name, change, path) => {
    const violations = validateEncounter(withChange(change));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path, message: expect.any(String) });
  });

  it.each([
    ['Z instead of +00:00', '2026-03-02T01:00:00Z'],
    ['a local offset', '2026-03-02T08:00:00+07:00'],
    ['fractional seconds', '2026-03-02T01:00:00.123+00:00'],
    ['a plain date', '2026-03-02'],
    ['no seconds', '2026-03-02T01:00+00:00'],
    ['an impossible date', '2026-02-30T01:00:00+00:00'],
    ['an impossible time', '2026-03-02T24:00:00+00:00'],
  ])('rejects period.start with %s', (_name, start) => {
    const violations = validateEncounter(withChange((e) => (e.period = { start })));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path: 'Encounter.period.start', message: expect.stringContaining(start) });
  });

  it.each([
    ['period.end', (e: Draft, t: string) => (e.period = { start: '2026-03-02T01:00:00+00:00', end: t }), 'Encounter.period.end'],
    ['statusHistory period.start', (e: Draft, t: string) => (e.statusHistory = [{ status: 'arrived', period: { start: t } }]), 'Encounter.statusHistory[0].period.start'],
    ['location period.start', (e: Draft, t: string) => (e.location = [{ location: { reference: 'Location/x' }, period: { start: t } }]), 'Encounter.location[0].period.start'],
    ['participant period.end', (e: Draft, t: string) => (e.participant = [{ individual: { reference: 'Practitioner/1' }, period: { end: t } }]), 'Encounter.participant[0].period.end'],
  ])('checks the time format of %s', (_name, change, path) => {
    const violations = validateEncounter(withChange((e) => change(e, '2026-03-02T09:00:00+07:00')));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path, message: expect.any(String) });
  });

  it('accepts the date floor itself: 2014-06-03T00:00:00+00:00', () => {
    const atFloor = withChange((e) => {
      e.period = { start: '2014-06-03T00:00:00+00:00' };
      e.statusHistory = [{ status: 'arrived', period: { start: '2014-06-03T00:00:00+00:00' } }];
    });
    expect(validateEncounter(atFloor)).toEqual([]);
  });

  it('rejects a time one second before the date floor', () => {
    const violations = validateEncounter(withChange((e) => (e.period = { start: '2014-06-02T23:59:59+00:00' })));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path: 'Encounter.period.start', message: expect.stringContaining('2014-06-03') });
  });

  it('rejects a finished Encounter without period.end (10121)', () => {
    const violations = validateEncounter(withChange((e) => (e.status = 'finished')));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path: 'Encounter.period.end', message: expect.any(String) });
  });

  it('rejects a finished Encounter whose period ends at or before its start (10121)', () => {
    const violations = validateEncounter(
      withChange((e) => {
        e.status = 'finished';
        e.period = { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T01:00:00+00:00' };
      }),
    );
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path: 'Encounter.period.end', message: expect.any(String) });
  });

  it.each([
    ['another identifier system', [{ system: 'http://sys-ids.kemkes.go.id/visit/99000001', value: 'V-1' }]],
    ['the encounter/{org} system of a different organization', [{ system: 'http://sys-ids.kemkes.go.id/encounter/12345', value: 'V-1' }]],
    ['an empty value', [{ system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: '' }]],
    ['two encounter/{org} identifiers', [
      { system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-1' },
      { system: `http://sys-ids.kemkes.go.id/encounter/${ORG}`, value: 'V-2' },
    ]],
  ])('rejects an identifier with %s', (_name, identifier) => {
    const violations = validateEncounter(withChange((e) => (e.identifier = identifier)));
    expect(violations).toContainEqual({ code: 'PAYLOAD_INVALID', path: 'Encounter.identifier', message: expect.any(String) });
  });

  it('reports every violation at once', () => {
    const violations = validateEncounter(
      withChange((e) => {
        delete e.subject;
        delete e.serviceProvider;
        e.period = { start: '2026-03-02T01:00:00Z' };
      }),
    );
    expect(violations.map((v) => v.path)).toEqual(
      expect.arrayContaining(['Encounter.subject', 'Encounter.serviceProvider', 'Encounter.period.start']),
    );
  });

  it('rejects a body that is not an object', () => {
    expect(validateEncounter('nope')).toEqual([{ code: 'PAYLOAD_INVALID', path: 'Encounter', message: expect.any(String) }]);
  });
});
