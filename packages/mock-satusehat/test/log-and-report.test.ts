import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, createdId, encounter, fhir, requestToken, world, type BootedMock } from './support/boot-mock.js';

const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

describe('submission log and report', () => {
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

  it('logs every request with what it was about and its effect', async () => {
    const id = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-log')));
    await fhir(mock.baseUrl, token, `Encounter?identifier=${ENCOUNTER_SYSTEM}|V-log`);

    const entries = await mock.client.log();

    expect(entries).toEqual([
      expect.objectContaining({
        seq: 1, method: 'POST', path: '/oauth2/v1/accesstoken?grant_type=client_credentials',
        resourceType: null, visitKey: null, effect: 'none', fault: null, response: expect.objectContaining({ status: 200 }),
      }),
      expect.objectContaining({
        seq: 2, method: 'POST', path: '/fhir-r4/v1/Encounter', resourceType: 'Encounter', visitKey: 'V-log',
        businessIdentifier: `${ENCOUNTER_SYSTEM}|V-log`, effect: 'created', fault: null,
        request: { body: expect.objectContaining({ resourceType: 'Encounter' }) },
        response: { status: 201, body: expect.objectContaining({ id }) },
      }),
      expect.objectContaining({
        seq: 3, method: 'GET', resourceType: 'Encounter', visitKey: 'V-log', effect: 'none',
        response: expect.objectContaining({ status: 200 }),
      }),
    ]);
    for (const e of entries) {
      expect(Date.parse(e.receivedAt)).not.toBeNaN();
      expect(e.respondedAt >= e.receivedAt).toBe(true);
    }
  });

  it('logs rejected, unauthorized and unknown-path requests as effect none', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-rej', { status: undefined }));
    await fhir(mock.baseUrl, null, 'Encounter', encounter('V-rej'));
    await fhir(mock.baseUrl, token, 'Patient?name=x');
    await fetch(new URL('nowhere', mock.baseUrl));

    const entries = await mock.client.log({ afterSeq: 1 });

    expect(entries.map((e) => [e.response.status, e.effect, e.visitKey])).toEqual([
      [400, 'none', 'V-rej'],
      [401, 'none', null],
      [400, 'none', null],
      [404, 'none', null],
    ]);
  });

  it('never logs the client secret', async () => {
    await requestToken(mock.baseUrl);
    const ndjson = await (await fetch(new URL('__mock/log.ndjson', mock.baseUrl))).text();
    expect(ndjson).not.toContain(world.organization.clientSecret);
  });

  it('filters the log by visitKey, resourceType, afterSeq and limit', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-a'));
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-b'));
    await fhir(mock.baseUrl, token, `Encounter?identifier=${ENCOUNTER_SYSTEM}|V-a`);
    await fhir(mock.baseUrl, token, `Patient?identifier=https://fhir.kemkes.go.id/id/nik|${world.patients[0]?.nik}`);

    expect((await mock.client.log({ visitKey: 'V-a' })).map((e) => e.seq)).toEqual([2, 4]);
    expect((await mock.client.log({ resourceType: 'Patient' })).map((e) => e.seq)).toEqual([5]);
    expect((await mock.client.log({ afterSeq: 2, limit: 2 })).map((e) => e.seq)).toEqual([3, 4]);
    expect((await mock.client.log({ resourceType: 'Encounter', afterSeq: 3 })).map((e) => e.seq)).toEqual([4]);
  });

  it('answers 400 to an invalid log query', async () => {
    await expect(mock.client.log({ limit: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it('streams the whole log as NDJSON, the same entries as the JSON log', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-nd'));

    const res = await fetch(new URL('__mock/log.ndjson', mock.baseUrl));

    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await mock.client.logNdjson()).toEqual(await mock.client.log());
  });

  it('reset empties the log and restarts seq', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-r'));
    await mock.client.reset();
    await requestToken(mock.baseUrl);

    expect((await mock.client.log()).map((e) => e.seq)).toEqual([1]);
  });

  it('reports no violations for a single create', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-ok'));

    expect(await mock.client.report()).toEqual({ faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] });
  });

  it('reports a second create for the same identifier as a duplicate submission', async () => {
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-twice'));
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-twice', { subject: undefined })); // rejected: no effect
    await fhir(mock.baseUrl, token, 'Encounter', encounter('V-twice'));

    expect((await mock.client.report()).duplicates).toEqual([
      { resourceType: 'Encounter', effect: 'created', businessIdentifier: `${ENCOUNTER_SYSTEM}|V-twice`, visitKey: 'V-twice', seqs: [2, 4] },
    ]);
  });
});
