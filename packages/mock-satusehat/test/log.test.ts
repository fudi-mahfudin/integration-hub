import { describe, expect, it } from 'vitest';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, NIK, useMock, world } from './support/platform.js';

const ctx = useMock();

describe('request log', () => {
  it('logs a create with every field', async () => {
    await ctx.platform.bearer();
    const body = validEncounter('VISIT-LOG-1');
    const created = await ctx.platform.fhir('POST', '/Encounter', body);

    const [entry] = await ctx.client.log({ resourceType: 'Encounter' });
    expect(entry).toMatchObject({
      kind: 'platform',
      method: 'POST',
      path: '/fhir-r4/v1/Encounter',
      resourceType: 'Encounter',
      visitKey: 'VISIT-LOG-1',
      businessIdentifier: `${encounterSystem()}|VISIT-LOG-1`,
      request: { body },
      response: { status: 201, body: created.body },
      fault: null,
      effect: 'created',
    });
    expect(Date.parse(entry!.receivedAt)).toBeLessThanOrEqual(Date.parse(entry!.respondedAt));
  });

  it('logs token calls, searches, rejections, 401s and unknown routes, each with effect none', async () => {
    await ctx.platform.requestToken('mock-client-id', 'wrong');
    await ctx.client.reset();
    await ctx.platform.bearer();
    await ctx.platform.fhir('GET', `/Patient?identifier=${encodeURIComponent(`${NIK}|${world.patients[0]!.nik}`)}`);
    const bad = validEncounter('VISIT-LOG-2');
    bad.period.start = '2026-01-01T00:00:00Z';
    await ctx.platform.fhir('POST', '/Encounter', bad);
    await ctx.platform.fhir('GET', '/Location?_id=x', undefined, 'bogus');
    await ctx.platform.fhir('GET', '/Nothing/here/at/all');

    const log = await ctx.client.log();
    expect(log.map((e) => [e.method, e.path, e.response.status, e.effect])).toEqual([
      ['POST', '/oauth2/v1/accesstoken', 200, 'none'],
      ['GET', '/fhir-r4/v1/Patient', 200, 'none'],
      ['POST', '/fhir-r4/v1/Encounter', 400, 'none'],
      ['GET', '/fhir-r4/v1/Location', 401, 'none'],
      ['GET', '/fhir-r4/v1/Nothing/here/at/all', 404, 'none'],
    ]);
    expect(log[2]!.visitKey).toBe('VISIT-LOG-2');
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('logs a malformed JSON body as a 400', async () => {
    const token = await ctx.platform.bearer();
    await fetch(`${ctx.mock.baseUrl}/fhir-r4/v1/Encounter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{oops',
    });
    const log = await ctx.client.log({ resourceType: 'Encounter' });
    expect(log.map((e) => [e.method, e.response.status, e.effect])).toEqual([['POST', 400, 'none']]);
  });

  it('logs an Encounter search under the searched visit key', async () => {
    await ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|VISIT-LOG-3`)}`);
    expect(await ctx.client.log({ visitKey: 'VISIT-LOG-3' })).toHaveLength(1);
  });

  it('filters by visitKey and resourceType, pages with afterSeq and limit', async () => {
    for (const v of ['A', 'B', 'A', 'C', 'A']) await ctx.platform.fhir('POST', '/Encounter', validEncounter(`VISIT-${v}`));

    const a = await ctx.client.log({ visitKey: 'VISIT-A' });
    expect(a).toHaveLength(3);
    expect((await ctx.client.log({ resourceType: 'Encounter' })).length).toBe(5);

    const page1 = await ctx.client.log({ visitKey: 'VISIT-A', limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual(a.slice(0, 2).map((e) => e.seq));
    const page2 = await ctx.client.log({ visitKey: 'VISIT-A', afterSeq: page1[1]!.seq });
    expect(page2.map((e) => e.seq)).toEqual([a[2]!.seq]);
  });

  it('streams the whole log as NDJSON', async () => {
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-ND'));
    const lines = (await ctx.client.logNdjson()).trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual(await ctx.client.log());
    expect(lines.length).toBe(2); // token + create
  });

  it('logs admin mutations as admin entries, and reset clears the log', async () => {
    await ctx.client.seed({ locations: [{ id: 'LOC-EXTRA', name: 'Extra', organizationId: world.organization.id }] });
    await ctx.client.revokeTokens();
    const log = await ctx.client.log();
    expect(log.map((e) => [e.kind, e.path])).toEqual([
      ['admin', '/__mock/seed'],
      ['admin', '/__mock/tokens/revoke'],
    ]);
    await ctx.client.reset();
    expect(await ctx.client.log()).toEqual([]);
  });
});
