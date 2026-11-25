import { describe, expect, it } from 'vitest';
import { RULE_CODE_SYSTEM, STEP_CODE_SYSTEM } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { useMock } from './support/platform.js';

const ctx = useMock();

/** Creates an arrived Encounter and returns it with a valid `finished` update of it. */
async function created(visitKey: string) {
  const r = await ctx.platform.fhir('POST', '/Encounter', validEncounter(visitKey));
  expect(r.status).toBe(201);
  const stored = r.body;
  const finished = {
    ...validEncounter(visitKey),
    id: stored.id,
    status: 'finished',
    period: { start: '2026-03-01T02:15:00+00:00', end: '2026-03-01T03:00:00+00:00' },
    statusHistory: [
      { status: 'arrived', period: { start: '2026-03-01T02:15:00+00:00', end: '2026-03-01T03:00:00+00:00' } },
      { status: 'finished', period: { start: '2026-03-01T03:00:00+00:00', end: '2026-03-01T03:00:00+00:00' } },
    ],
  };
  return { stored, finished };
}

const rules = (body: any): string[] =>
  body.issue.flatMap((i: any) => i.details.coding.filter((c: any) => c.system === RULE_CODE_SYSTEM).map((c: any) => c.code));

describe('Encounter update (PUT /Encounter/{id})', () => {
  it('an applied PUT stores the body, bumps meta.versionId and returns it; logged as effect updated', async () => {
    const { stored, finished } = await created('VISIT-U1');

    const put = await ctx.platform.fhir('PUT', `/Encounter/${stored.id}`, finished);

    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ id: stored.id, status: 'finished', period: finished.period });
    expect(put.body.meta.versionId).not.toBe(stored.meta.versionId);
    expect((await ctx.platform.fhir('GET', `/Encounter/${stored.id}`)).body).toEqual(put.body);
    const entry = (await ctx.client.log({ visitKey: 'VISIT-U1' })).find((e) => e.method === 'PUT')!;
    expect(entry).toMatchObject({ effect: 'updated', resourceType: 'Encounter', response: { status: 200 } });
  });

  type Mutation = (e: any) => void;
  // [name, mutation, rule, path]
  const rejections: [string, Mutation, string, string][] = [
    ['the create rules (a Z time)', (e) => (e.period.end = '2026-03-01T03:00:00Z'), 'TIME_FORMAT', 'Encounter.period.end'],
    ['the create rules (no subject)', (e) => delete e.subject, 'REQUIRED', 'Encounter.subject.reference'],
    ['a body id other than the URL id', (e) => (e.id = 'another-id'), 'ID_MISMATCH', 'Encounter.id'],
    ['no body id', (e) => delete e.id, 'ID_MISMATCH', 'Encounter.id'],
    ['another visit identifier', (e) => (e.identifier[0].value = 'VISIT-OTHER'), 'IDENTIFIER_CHANGED', 'Encounter.identifier'],
    ['finished without period.end', (e) => delete e.period.end, 'REQUIRED', 'Encounter.period.end'],
    // Dictionary rule 10121: the end is after the start.
    ['an end equal to the start', (e) => (e.period.end = e.period.start), 'PERIOD_ORDER', 'Encounter.period.end'],
    ['an end before the start', (e) => (e.period.end = '2026-03-01T02:14:59+00:00'), 'PERIOD_ORDER', 'Encounter.period.end'],
  ];

  it.each(rejections)('rejects %s with 400, stores nothing and logs effect none', async (_name, mutate, rule, path) => {
    const visitKey = `VISIT-UBAD-${rule}`;
    const { stored, finished } = await created(visitKey);
    mutate(finished);

    const put = await ctx.platform.fhir('PUT', `/Encounter/${stored.id}`, finished);

    expect(put.status).toBe(400);
    const issue = put.body.issue.find((i: any) => i.details.coding.some((c: any) => c.system === RULE_CODE_SYSTEM && c.code === rule));
    expect(issue, `no ${rule} issue in ${JSON.stringify(put.body)}`).toBeDefined();
    expect(issue.details.coding).toContainEqual({ system: STEP_CODE_SYSTEM, code: 'PAYLOAD_INVALID' });
    expect(issue.expression).toEqual([path]);
    expect((await ctx.platform.fhir('GET', `/Encounter/${stored.id}`)).body).toEqual(stored);
    const entry = (await ctx.client.log({ visitKey })).find((e) => e.method === 'PUT')!;
    expect(entry.effect).toBe('none');
  });

  it('the period order rule applies to creates too', async () => {
    const e = validEncounter('VISIT-U2');
    e.period.end = '2026-03-01T02:00:00+00:00';
    const r = await ctx.platform.fhir('POST', '/Encounter', e);
    expect(r.status).toBe(400);
    expect(rules(r.body)).toEqual(['PERIOD_ORDER']);
  });

  it('a second applied PUT for the visit is a duplicate submission in the report', async () => {
    const { stored, finished } = await created('VISIT-U3');
    expect((await ctx.platform.fhir('PUT', `/Encounter/${stored.id}`, finished)).status).toBe(200);
    expect((await ctx.client.report()).duplicateSubmissions).toEqual([]);

    expect((await ctx.platform.fhir('PUT', `/Encounter/${stored.id}`, finished)).status).toBe(200);
    expect((await ctx.client.report()).duplicateSubmissions).toMatchObject([{ resourceType: 'Encounter', effect: 'updated', key: 'VISIT-U3' }]);
  });
});
