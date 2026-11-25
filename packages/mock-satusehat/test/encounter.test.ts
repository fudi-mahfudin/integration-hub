import { describe, expect, it } from 'vitest';
import { RULE_CODE_SYSTEM, STEP_CODE_SYSTEM } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, useMock } from './support/platform.js';

const ctx = useMock();

const search = async (visitKey: string) =>
  ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${visitKey}`)}`);

describe('Encounter create', () => {
  it('issues an id and a meta.versionId', async () => {
    const r = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-1'));
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe('string');
    expect(typeof r.body.meta.versionId).toBe('string');
    expect(r.body.identifier[0].value).toBe('VISIT-1');
    expect(r.headers.get('location')).toContain(`/Encounter/${r.body.id}`);
  });

  it('stores a second create for the same business identifier, so the duplicate is visible', async () => {
    const a = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-2'));
    const b = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-2'));
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
    expect((await search('VISIT-2')).body.total).toBe(2);
  });

  it('accepts an Encounter without the optional end time or status history', async () => {
    const e = validEncounter('VISIT-3');
    delete e.statusHistory;
    expect((await ctx.platform.fhir('POST', '/Encounter', e)).status).toBe(201);
  });
});

type Mutation = (e: any) => void;

// [name, mutation, rule expected in issue.details.coding, path expected in issue.expression]
const rejections: [string, Mutation, string, string][] = [
  // time format: +00:00 only
  ['Z instead of +00:00', (e) => (e.period.start = '2026-03-01T02:15:00Z'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['a non-UTC offset', (e) => (e.period.start = '2026-03-01T09:15:00+07:00'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['fractional seconds', (e) => (e.period.start = '2026-03-01T02:15:00.123+00:00'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['no offset', (e) => (e.period.start = '2026-03-01T02:15:00'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['date only', (e) => (e.period.start = '2026-03-01'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['an impossible date', (e) => (e.period.start = '2026-02-30T02:15:00+00:00'), 'TIME_FORMAT', 'Encounter.period.start'],
  ['a bad end time', (e) => (e.period.end = '2026-03-01T03:00:00Z'), 'TIME_FORMAT', 'Encounter.period.end'],
  ['a bad status-history time', (e) => (e.statusHistory[0].period.start = '2026-03-01 02:15:00'), 'TIME_FORMAT', 'Encounter.statusHistory[0].period.start'],
  ['a bad location period time', (e) => (e.location[0].period = { start: '2026-03-01T02:15Z' }), 'TIME_FORMAT', 'Encounter.location[0].period.start'],
  // date floor 2014-06-03T00:00:00+00:00
  ['a start before the floor', (e) => (e.period.start = '2014-06-02T23:59:59+00:00'), 'DATE_FLOOR', 'Encounter.period.start'],
  ['a status-history time before the floor', (e) => (e.statusHistory[0].period.start = '2001-01-01T00:00:00+00:00'), 'DATE_FLOOR', 'Encounter.statusHistory[0].period.start'],
  // mandatory fields
  ['no identifier', (e) => delete e.identifier, 'REQUIRED', 'Encounter.identifier'],
  ['no identifier value', (e) => delete e.identifier[0].value, 'REQUIRED', 'Encounter.identifier'],
  ['no status', (e) => delete e.status, 'REQUIRED', 'Encounter.status'],
  ['no class', (e) => delete e.class, 'REQUIRED', 'Encounter.class'],
  ['no class code', (e) => delete e.class.code, 'REQUIRED', 'Encounter.class.code'],
  ['no subject', (e) => delete e.subject, 'REQUIRED', 'Encounter.subject.reference'],
  ['no participant', (e) => (e.participant = []), 'REQUIRED', 'Encounter.participant'],
  ['a participant without individual', (e) => delete e.participant[0].individual, 'REQUIRED', 'Encounter.participant[0].individual.reference'],
  ['no period', (e) => delete e.period, 'REQUIRED', 'Encounter.period.start'],
  ['no location', (e) => delete e.location, 'REQUIRED', 'Encounter.location'],
  ['a location without reference', (e) => delete e.location[0].location.reference, 'REQUIRED', 'Encounter.location[0].location.reference'],
  ['no serviceProvider', (e) => delete e.serviceProvider, 'REQUIRED', 'Encounter.serviceProvider.reference'],
  // identifier system encounter/{org}
  ['another identifier system', (e) => (e.identifier[0].system = 'http://sys-ids.kemkes.go.id/prescription/99000001'), 'IDENTIFIER_SYSTEM', 'Encounter.identifier'],
  ['an unknown organization', (e) => (e.identifier[0].system = 'http://sys-ids.kemkes.go.id/encounter/12345678'), 'IDENTIFIER_SYSTEM', 'Encounter.identifier'],
  ['a subsystem suffix', (e) => (e.identifier[0].system = 'http://sys-ids.kemkes.go.id/encounter/99000001/rj'), 'IDENTIFIER_SYSTEM', 'Encounter.identifier'],
  ['serviceProvider of another organization', (e) => (e.serviceProvider.reference = 'Organization/12345678'), 'ORGANIZATION_MISMATCH', 'Encounter.serviceProvider.reference'],
  // values and references
  ['a status outside the FHIR value set', (e) => (e.status = 'open'), 'VALUE_SET', 'Encounter.status'],
  ['a subject that is not a Patient', (e) => (e.subject.reference = 'Practitioner/10099000001'), 'REFERENCE_TYPE', 'Encounter.subject.reference'],
  ['a participant that is not a Practitioner', (e) => (e.participant[0].individual.reference = 'Patient/P9900000001'), 'REFERENCE_TYPE', 'Encounter.participant[0].individual.reference'],
  ['a location that is not a Location', (e) => (e.location[0].location.reference = 'Organization/99000001'), 'REFERENCE_TYPE', 'Encounter.location[0].location.reference'],
  ['a wrong resourceType', (e) => (e.resourceType = 'Patient'), 'RESOURCE_TYPE', 'Encounter.resourceType'],
];

describe('Encounter validator (ADR 0006: independent of the hub)', () => {
  it.each(rejections)('rejects %s', async (_name, mutate, rule, path) => {
    const e = validEncounter('VISIT-BAD');
    mutate(e);
    const r = await ctx.platform.fhir('POST', '/Encounter', e);

    expect(r.status).toBe(400);
    expect(r.body.resourceType).toBe('OperationOutcome');
    const issue = r.body.issue.find((i: any) =>
      i.details.coding.some((c: any) => c.system === RULE_CODE_SYSTEM && c.code === rule),
    );
    expect(issue, `no ${rule} issue in ${JSON.stringify(r.body)}`).toBeDefined();
    expect(issue.severity).toBe('error');
    expect(issue.details.coding).toContainEqual({ system: STEP_CODE_SYSTEM, code: 'PAYLOAD_INVALID' });
    expect(issue.expression).toEqual([path]);
  });

  it('reports every violation at once', async () => {
    const e = validEncounter('VISIT-BAD');
    delete e.status;
    e.period.start = '2026-03-01T02:15:00Z';
    const r = await ctx.platform.fhir('POST', '/Encounter', e);
    const rules = r.body.issue.flatMap((i: any) => i.details.coding.filter((c: any) => c.system === RULE_CODE_SYSTEM).map((c: any) => c.code));
    expect(rules.sort()).toEqual(['REQUIRED', 'TIME_FORMAT']);
  });

  it('accepts the floor itself', async () => {
    const e = validEncounter('VISIT-FLOOR');
    e.period.start = '2014-06-03T00:00:00+00:00';
    e.statusHistory[0].period.start = '2014-06-03T00:00:00+00:00';
    expect((await ctx.platform.fhir('POST', '/Encounter', e)).status).toBe(201);
  });

  it('stores nothing for a rejected create', async () => {
    const e = validEncounter('VISIT-REJECTED');
    e.period.start = 'yesterday';
    await ctx.platform.fhir('POST', '/Encounter', e);
    expect((await search('VISIT-REJECTED')).body.total).toBe(0);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await fetch(`${ctx.mock.baseUrl}/fhir-r4/v1/Encounter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await ctx.platform.bearer()}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});
