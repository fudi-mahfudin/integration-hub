import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, createdId, encounter, fhir, world, type BootedMock } from './support/boot-mock.js';

/** The create-visit Encounter for `visitKey`, finished at 02:00 UTC, as an update of record `id`. */
function finished(id: string, visitKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return encounter(visitKey, {
    id,
    status: 'finished',
    period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:00:00+00:00' },
    statusHistory: [
      { status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:00:00+00:00' } },
      { status: 'finished', period: { start: '2026-03-02T02:00:00+00:00', end: '2026-03-02T02:00:00+00:00' } },
    ],
    ...overrides,
  });
}

describe('Encounter update', () => {
  let mock: BootedMock;
  let token: string;

  beforeAll(async () => {
    mock = await bootMock();
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => {
    await mock.client.reset();
    token = await accessToken(mock.baseUrl);
  });

  const put = (id: string, body: unknown, bearer: string | null = token) =>
    fetch(new URL(`fhir-r4/v1/Encounter/${id}`, mock.baseUrl), {
      method: 'PUT',
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const create = (visitKey: string) => fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey)).then(createdId);

  it('applies a valid PUT: answers 200 with the stored Encounter, its meta.versionId bumped, and logs it as updated', async () => {
    const id = await create('V-put');

    const res = await put(id, finished(id, 'V-put'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: 'finished', meta: { versionId: '2', lastUpdated: expect.any(String) } });
    const search = await fhir(mock.baseUrl, token, `Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/${world.organization.id}|V-put`);
    expect(await search.json()).toMatchObject({ total: 1, entry: [{ resource: { id, status: 'finished', meta: { versionId: '2' } } }] });
    const [logged] = await mock.client.log({ visitKey: 'V-put', resourceType: 'Encounter', afterSeq: 2 });
    expect(logged).toMatchObject({
      method: 'PUT',
      effect: 'updated',
      businessIdentifier: `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}|V-put`,
    });
    expect((await mock.client.report()).duplicates).toEqual([]);
  });

  it('counts every applied PUT: a second bumps the version again and the report shows a duplicate submission', async () => {
    const id = await create('V-put-twice');
    await put(id, finished(id, 'V-put-twice'));

    const again = await put(id, finished(id, 'V-put-twice'));

    expect(await again.json()).toMatchObject({ meta: { versionId: '3' } });
    const updates = (await mock.client.log({ visitKey: 'V-put-twice' })).filter((e) => e.effect === 'updated');
    expect((await mock.client.report()).duplicates).toEqual([
      {
        resourceType: 'Encounter',
        effect: 'updated',
        businessIdentifier: `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}|V-put-twice`,
        visitKey: 'V-put-twice',
        seqs: updates.map((e) => e.seq),
      },
    ]);
  });

  it.each([
    ['a finished Encounter with no period.end', (id: string) => finished(id, 'V-bad', { period: { start: '2026-03-02T01:00:00+00:00' } }), 'Encounter.period.end'],
    ['a body whose id is not the record’s', () => finished('another-id', 'V-bad'), 'Encounter.id'],
    ['a body that changes the visit identifier', (id: string) => finished(id, 'V-other'), 'Encounter.identifier'],
  ])('rejects %s with 400 PAYLOAD_INVALID and changes nothing', async (_, body, path) => {
    const id = await create('V-bad');

    const res = await put(id, body(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ issue: [{ details: { coding: [{ code: 'PAYLOAD_INVALID' }] }, expression: [path] }] });
    const search = await fhir(mock.baseUrl, token, `Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/${world.organization.id}|V-bad`);
    expect(await search.json()).toMatchObject({ entry: [{ resource: { status: 'arrived', meta: { versionId: '1' } } }] });
  });

  it('answers 404 to a PUT of an Encounter it does not hold', async () => {
    const id = crypto.randomUUID();

    const res = await put(id, finished(id, 'V-unknown'));

    expect(res.status).toBe(404);
  });

  it('answers 401 to a PUT without a valid token and changes nothing', async () => {
    const id = await create('V-noauth');

    const res = await put(id, finished(id, 'V-noauth'), null);

    expect(res.status).toBe(401);
    expect((await mock.client.log({ visitKey: 'V-noauth' })).filter((e) => e.effect === 'updated')).toEqual([]);
  });
});
