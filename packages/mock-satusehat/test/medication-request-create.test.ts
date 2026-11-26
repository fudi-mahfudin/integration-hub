import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, createdId, encounter, fhir, medicationRequest, type BootedMock } from './support/boot-mock.js';

const PRESCRIPTION_SYSTEM = 'http://sys-ids.kemkes.go.id/prescription/99000001';

describe('MedicationRequest create and search', () => {
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

  it('stores a valid MedicationRequest on a held Encounter and logs it under that visit and its prescription identifier', async () => {
    const encounterId = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-rx')));
    const body = medicationRequest(encounterId, 'RX-1');

    const res = await fhir(mock.baseUrl, token, 'MedicationRequest', body);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ...body,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      meta: { versionId: '1', lastUpdated: expect.any(String) },
    });
    const [entry] = await mock.client.log({ resourceType: 'MedicationRequest' });
    expect(entry).toMatchObject({
      method: 'POST',
      visitKey: 'V-rx',
      businessIdentifier: `${PRESCRIPTION_SYSTEM}|RX-1`,
      effect: 'created',
    });
    expect((await mock.client.report()).outOfOrder).toEqual([]);
  });

  it('finds stored MedicationRequests by their prescription identifier, logged under their visit', async () => {
    const encounterId = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-search')));
    await fhir(mock.baseUrl, token, 'MedicationRequest', medicationRequest(encounterId, 'RX-2'));

    const hit = await fhir(mock.baseUrl, token, `MedicationRequest?identifier=${PRESCRIPTION_SYSTEM}|RX-2`);
    const miss = await fhir(mock.baseUrl, token, `MedicationRequest?identifier=${PRESCRIPTION_SYSTEM}|RX-none`);

    expect(hit.status).toBe(200);
    expect(await hit.json()).toMatchObject({ resourceType: 'Bundle', total: 1, entry: [{ resource: { resourceType: 'MedicationRequest' } }] });
    expect(await miss.json()).toMatchObject({ total: 0 });
    const searches = (await mock.client.log({ resourceType: 'MedicationRequest' })).filter((e) => e.method === 'GET');
    expect(searches.map((e) => e.visitKey)).toEqual(['V-search', null]);
    expect(searches.map((e) => e.businessIdentifier)).toEqual([`${PRESCRIPTION_SYSTEM}|RX-2`, `${PRESCRIPTION_SYSTEM}|RX-none`]);
  });

  it('rejects a MedicationRequest on an Encounter it does not hold with 400 REFERENCE_NOT_FOUND, storing nothing', async () => {
    const res = await fhir(mock.baseUrl, token, 'MedicationRequest', medicationRequest('00000000-0000-4000-8000-000000000000', 'RX-3'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      resourceType: 'OperationOutcome',
      issue: [{ details: { coding: [{ code: 'REFERENCE_NOT_FOUND' }] }, expression: ['MedicationRequest.encounter'] }],
    });
    const [entry] = await mock.client.log({ resourceType: 'MedicationRequest' });
    expect(entry).toMatchObject({ effect: 'none', businessIdentifier: `${PRESCRIPTION_SYSTEM}|RX-3` });
    const search = await fhir(mock.baseUrl, token, `MedicationRequest?identifier=${PRESCRIPTION_SYSTEM}|RX-3`);
    expect(await search.json()).toMatchObject({ total: 0 });
  });

  it('answers 401 to a create without a valid token', async () => {
    const encounterId = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-noauth')));

    expect((await fhir(mock.baseUrl, null, 'MedicationRequest', medicationRequest(encounterId))).status).toBe(401);
  });
});
