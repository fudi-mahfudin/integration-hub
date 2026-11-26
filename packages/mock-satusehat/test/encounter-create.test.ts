import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, createdId, encounter, fhir, type BootedMock } from './support/boot-mock.js';

describe('Encounter create', () => {
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

  it('stores a valid Encounter and answers 201 with an id and meta.versionId', async () => {
    const body = encounter('V-create');

    const res = await fhir(mock.baseUrl, token, 'Encounter', body);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ...body,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      meta: { versionId: '1', lastUpdated: expect.any(String) },
    });
  });

  it('stores a second create for the same identifier, with a new id, so the duplicate is visible', async () => {
    const first = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-dup')));
    const second = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-dup')));

    expect(second).not.toBe(first);
    const search = await fhir(mock.baseUrl, token, 'Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/99000001|V-dup');
    expect(await search.json()).toMatchObject({ total: 2 });
  });

  it('rejects an invalid Encounter with 400 OperationOutcome carrying the code in issue.details.coding', async () => {
    const res = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-bad', { period: { start: '2026-03-02T08:00:00+07:00' } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: 'invalid',
          details: { coding: [{ code: 'PAYLOAD_INVALID' }] },
          expression: ['Encounter.period.start'],
        },
      ],
    });
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await fetch(new URL('fhir-r4/v1/Encounter', mock.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('answers 401 to a create without a valid token and stores nothing', async () => {
    const res = await fhir(mock.baseUrl, null, 'Encounter', encounter('V-noauth'));

    expect(res.status).toBe(401);
    const search = await fhir(mock.baseUrl, token, 'Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/99000001|V-noauth');
    expect(await search.json()).toMatchObject({ total: 0 });
  });

  it('reset clears stored Encounters', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-reset'));

    await mock.client.reset();
    token = await accessToken(mock.baseUrl);

    const search = await fhir(mock.baseUrl, token, 'Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/99000001|V-reset');
    expect(await search.json()).toMatchObject({ total: 0 });
  });
});
