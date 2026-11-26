import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, createdId, encounter, fhir, medicationRequest, world, type BootedMock } from './support/boot-mock.js';

const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

describe('record mutations behind the hub’s back', () => {
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

  const search = async (visitKey: string): Promise<unknown> =>
    (await fhir(mock.baseUrl, token, `Encounter?identifier=${ENCOUNTER_SYSTEM}|${visitKey}`)).json();
  const create = (visitKey: string) => fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey)).then(createdId);
  const put = (id: string, body: unknown) =>
    fetch(new URL(`fhir-r4/v1/Encounter/${id}`, mock.baseUrl), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a deleted record is gone: searches miss it and a PUT gets 404; the delete is logged as admin', async () => {
    const id = await create('V-del');

    await mock.client.deleteRecord('Encounter', id);

    expect(await search('V-del')).toMatchObject({ total: 0 });
    expect((await put(id, encounter('V-del', { id }))).status).toBe(404);
    const admin = (await mock.client.log({ visitKey: 'V-del' })).filter((e) => e.effect === 'admin');
    expect(admin).toEqual([expect.objectContaining({ method: 'DELETE', path: `/__mock/records/Encounter/${id}`, resourceType: 'Encounter', fault: null })]);
    expect(await mock.client.report()).toMatchObject({ duplicates: [], outOfOrder: [], overlap: [] });
  });

  it('a prescription on a deleted Encounter is rejected as REFERENCE_NOT_FOUND', async () => {
    const id = await create('V-del-ref');
    await mock.client.deleteRecord('Encounter', id);

    const res = await fhir(mock.baseUrl, token, 'MedicationRequest', medicationRequest(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ issue: [{ details: { coding: [{ code: 'REFERENCE_NOT_FOUND' }] } }] });
  });

  it('answers 404 to deleting or patching a record it does not hold, and 400 to a type it does not store', async () => {
    await expect(mock.client.deleteRecord('Encounter', 'no-such-id')).rejects.toMatchObject({ status: 404 });
    await expect(mock.client.patchRecord('MedicationDispense', 'no-such-id', { status: 'cancelled' })).rejects.toMatchObject({ status: 404 });
    const res = await fetch(new URL('__mock/records/Patient/x', mock.baseUrl), { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('a JSON merge patch changes fields, removes those set to null, and bumps versionId', async () => {
    const id = await create('V-patch');

    const patched = await mock.client.patchRecord('Encounter', id, { status: 'cancelled', statusHistory: null, class: { display: 'rawat jalan' } });

    expect(patched).toMatchObject({ id, status: 'cancelled', meta: { versionId: '2' } });
    expect(patched).not.toHaveProperty('statusHistory');
    expect(await search('V-patch')).toMatchObject({
      entry: [{ resource: { status: 'cancelled', class: { code: 'AMB', display: 'rawat jalan' }, meta: { versionId: '2' } } }],
    });
    const [admin] = (await mock.client.log({ visitKey: 'V-patch' })).filter((e) => e.effect === 'admin');
    expect(admin).toMatchObject({ method: 'PATCH', request: { body: { status: 'cancelled' } }, response: { status: 200 } });
  });

  it('refuses a patch that would change a record’s id or resourceType', async () => {
    const id = await create('V-patch-id');

    await expect(mock.client.patchRecord('Encounter', id, { id: 'other' })).rejects.toMatchObject({ status: 400 });
    expect(await search('V-patch-id')).toMatchObject({ entry: [{ resource: { id, meta: { versionId: '1' } } }] });
  });

  it('inserts a record directly, unvalidated, so a search can match two; not counted as a duplicate submission', async () => {
    await create('V-twice');

    const inserted = await mock.client.insertRecord(encounter('V-twice', { status: 'planned', subject: undefined }));

    expect(inserted).toMatchObject({ resourceType: 'Encounter', id: expect.any(String), meta: { versionId: '1' } });
    expect(await search('V-twice')).toMatchObject({ total: 2 });
    expect((await mock.client.log({ visitKey: 'V-twice' })).filter((e) => e.method === 'POST').map((e) => [e.path, e.effect])).toEqual([
      ['/fhir-r4/v1/Encounter', 'created'],
      ['/__mock/records', 'admin'],
    ]);
    expect((await mock.client.report()).duplicates).toEqual([]);
  });

  it('inserts under a given id, so the hub finds a record it never created, and refuses an id already held', async () => {
    const id = crypto.randomUUID();

    await mock.client.insertRecord(encounter('V-remote-only', { id }));

    expect(await search('V-remote-only')).toMatchObject({ entry: [{ resource: { id } }] });
    await expect(mock.client.insertRecord(encounter('V-other', { id }))).rejects.toMatchObject({ status: 409 });
  });
});
