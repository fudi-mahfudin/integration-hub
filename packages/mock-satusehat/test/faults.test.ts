import { describe, expect, it } from 'vitest';
import { RULE_CODE_SYSTEM, STEP_CODE_SYSTEM, type FaultRule } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, NIK, useMock, world } from './support/platform.js';

const ctx = useMock();

const search = async (visitKey: string) =>
  ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${visitKey}`)}`);

describe('fault rules', () => {
  it('fails the first N matching requests with http_500, logged with the rule id and no effect', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({
      seed: 7,
      rules: [{ id: 'enc-500', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 }],
    });

    const first = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-F1'));
    const second = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-F1'));
    expect(first.status).toBe(500);
    expect(first.body.resourceType).toBe('OperationOutcome');
    expect(second.status).toBe(201);
    expect((await search('VISIT-F1')).body.total).toBe(1);

    const log = await ctx.client.log({ resourceType: 'Encounter' });
    expect(log.map((e) => [e.method, e.response.status, e.fault, e.effect, e.visitKey])).toEqual([
      ['POST', 500, 'enc-500', 'none', 'VISIT-F1'],
      ['POST', 201, null, 'created', 'VISIT-F1'],
      ['GET', 200, null, 'none', 'VISIT-F1'],
    ]);
    expect((await ctx.client.report()).faultSeed).toBe(7);
  });

  it.each([
    ['http_503 without Retry-After', { kind: 'http_503' }, 503, null],
    ['http_503 with Retry-After seconds', { kind: 'http_503', params: { retryAfter: 7 } }, 503, '7'],
    ['http_429 without Retry-After', { kind: 'http_429' }, 429, null],
    ['http_429 with Retry-After seconds', { kind: 'http_429', params: { retryAfter: 3 } }, 429, '3'],
    ['http_429 with a verbatim Retry-After', { kind: 'http_429', params: { retryAfter: 'soon-ish' } }, 429, 'soon-ish'],
    ['http_401', { kind: 'http_401' }, 401, null],
  ] as const)('%s', async (_name, rule, status, retryAfter) => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({ seed: 1, rules: [{ id: 'r', match: { resourceType: 'Location' }, firstN: 1, ...rule } as FaultRule] });
    const r = await ctx.platform.fhir('GET', `/Location?_id=${world.locations[0]!.id}`);
    expect(r.status).toBe(status);
    expect(r.headers.get('retry-after')).toBe(retryAfter);
    expect(r.body.resourceType).toBe('OperationOutcome');
    expect((await ctx.platform.fhir('GET', `/Location?_id=${world.locations[0]!.id}`)).status).toBe(200);
  });

  it('http_429 with Retry-After as an HTTP date that many seconds ahead', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({
      seed: 1,
      rules: [{ id: 'r', match: { resourceType: 'Location' }, kind: 'http_429', firstN: 1, params: { retryAfter: 120, retryAfterFormat: 'http-date' } }],
    });
    const before = Date.now();
    const r = await ctx.platform.fhir('GET', `/Location?_id=${world.locations[0]!.id}`);
    const header = r.headers.get('retry-after')!;
    expect(header).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    const ahead = Date.parse(header) - before;
    expect(ahead).toBeGreaterThan(118_000);
    expect(ahead).toBeLessThanOrEqual(121_000);
  });

  it('http_400 is a validation-shaped OperationOutcome with the configured rule code', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({
      seed: 1,
      rules: [{ id: 'perm', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_400', firstN: 1, params: { rule: 'FORCED' } }],
    });
    const r = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-F400'));
    expect(r.status).toBe(400);
    expect(r.body.issue[0].details.coding).toEqual([
      { system: STEP_CODE_SYSTEM, code: 'PAYLOAD_INVALID' },
      { system: RULE_CODE_SYSTEM, code: 'FORCED' },
    ]);
    expect((await search('VISIT-F400')).body.total).toBe(0);
  });

  it('targets the token endpoint by path like any other route', async () => {
    await ctx.client.setFaults({ seed: 1, rules: [{ id: 'tok', match: { path: '/oauth2/v1/accesstoken' }, kind: 'http_503', firstN: 1 }] });
    expect((await ctx.platform.requestToken()).status).toBe(503);
    expect((await ctx.platform.requestToken()).status).toBe(200);
    const log = await ctx.client.log();
    expect(log.map((e) => [e.kind, e.path, e.fault])).toEqual([
      ['admin', '/__mock/faults', null],
      ['platform', '/oauth2/v1/accesstoken', 'tok'],
      ['platform', '/oauth2/v1/accesstoken', null],
    ]);
  });

  it('everyNth counts per business identifier, so other visits do not shift the pattern', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({ seed: 1, rules: [{ id: 'nth', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', everyNth: 2 }] });
    const statuses: [string, number][] = [];
    for (const v of ['A', 'B', 'A', 'A', 'B']) {
      statuses.push([v, (await ctx.platform.fhir('POST', '/Encounter', validEncounter(`VISIT-N${v}`))).status]);
    }
    expect(statuses).toEqual([
      ['A', 201],
      ['B', 201],
      ['A', 500],
      ['A', 201],
      ['B', 500],
    ]);
  });

  it('matches only requests that fit every given field', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults({ seed: 1, rules: [{ id: 'm', match: { method: 'POST', path: '/fhir-r4/v1/*' }, kind: 'http_500', firstN: 100 }] });
    const patient = await ctx.platform.fhir('GET', `/Patient?identifier=${encodeURIComponent(`${NIK}|${world.patients[0]!.nik}`)}`);
    expect(patient.status).toBe(200);
    expect((await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-M'))).status).toBe(500);
  });

  it('rejects a malformed rule set', async () => {
    const res = await fetch(`${ctx.mock.baseUrl}/__mock/faults`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 1, rules: [{ id: 'x', match: {}, kind: 'meteor', rate: 0.5, firstN: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('kind'), expect.stringContaining('exactly one of')]),
    );
  });
});
