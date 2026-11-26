import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, bootMock, fhir, manualClock, requestToken, world, type BootedMock } from './support/boot-mock.js';

const patientSearch = `Patient?identifier=https://fhir.kemkes.go.id/id/nik|${world.patients[0]?.nik}`;

describe('token endpoint', () => {
  const clock = manualClock();
  let mock: BootedMock;

  beforeAll(async () => {
    mock = await bootMock({ MOCK_TOKEN_EXPIRES_IN_SECONDS: '600' }, clock);
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => mock.client.reset());

  it('issues a token for the client credentials, with expires_in as a string', async () => {
    const res = await requestToken(mock.baseUrl);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      access_token: expect.any(String),
      token_type: 'BearerToken',
      expires_in: '600',
      client_id: world.organization.clientId,
    });
  });

  it('answers a FHIR call with a valid token, and 401 without one or with a made-up one', async () => {
    const token = await accessToken(mock.baseUrl);

    expect((await fhir(mock.baseUrl, token, patientSearch)).status).toBe(200);
    expect((await fhir(mock.baseUrl, null, patientSearch)).status).toBe(401);
    const bogus = await fhir(mock.baseUrl, 'not-a-token', patientSearch);
    expect(bogus.status).toBe(401);
    expect(await bogus.json()).toMatchObject({ resourceType: 'OperationOutcome' });
  });

  it('rejects a token once expires_in has passed', async () => {
    const token = await accessToken(mock.baseUrl);

    clock.advance(599_000);
    expect((await fhir(mock.baseUrl, token, patientSearch)).status).toBe(200);
    clock.advance(1_000);
    expect((await fhir(mock.baseUrl, token, patientSearch)).status).toBe(401);
  });

  it('revoking invalidates every issued token; a reissued one works', async () => {
    const first = await accessToken(mock.baseUrl);
    const second = await accessToken(mock.baseUrl);

    await mock.client.revokeTokens();

    expect((await fhir(mock.baseUrl, first, patientSearch)).status).toBe(401);
    expect((await fhir(mock.baseUrl, second, patientSearch)).status).toBe(401);
    expect((await fhir(mock.baseUrl, await accessToken(mock.baseUrl), patientSearch)).status).toBe(200);
  });

  it('reissuing a token leaves older tokens valid', async () => {
    const first = await accessToken(mock.baseUrl);
    await accessToken(mock.baseUrl);

    expect((await fhir(mock.baseUrl, first, patientSearch)).status).toBe(200);
  });

  it('rejects wrong credentials with 401 and a wrong grant_type with 400', async () => {
    const wrong = await requestToken(mock.baseUrl, { clientId: world.organization.clientId, clientSecret: 'wrong' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ resourceType: 'OperationOutcome' });

    await mock.client.reset();
    expect((await requestToken(mock.baseUrl, undefined, 'password')).status).toBe(400);
  });

  it('after a failed token request, answers 429 for the 60s window, then issues again', async () => {
    await requestToken(mock.baseUrl, { clientId: 'nobody', clientSecret: 'wrong' });

    clock.advance(59_999);
    const throttled = await requestToken(mock.baseUrl);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'throttled' }] });

    clock.advance(1);
    expect((await requestToken(mock.baseUrl)).status).toBe(200);
  });

  it('reset clears the throttle and every issued token', async () => {
    const token = await accessToken(mock.baseUrl);
    await requestToken(mock.baseUrl, { clientId: 'nobody', clientSecret: 'wrong' });

    await mock.client.reset();

    expect((await fhir(mock.baseUrl, token, patientSearch)).status).toBe(401);
    expect((await requestToken(mock.baseUrl)).status).toBe(200);
  });
});

describe('token endpoint with a configured throttle window', () => {
  const clock = manualClock();
  let mock: BootedMock;

  beforeAll(async () => {
    mock = await bootMock({ MOCK_TOKEN_THROTTLE_WINDOW_SECONDS: '5' }, clock);
  });
  afterAll(async () => mock?.close());

  it('throttles for the configured window and sends the default expires_in', async () => {
    await requestToken(mock.baseUrl, { clientId: 'nobody', clientSecret: 'wrong' });
    clock.advance(4_999);
    expect((await requestToken(mock.baseUrl)).status).toBe(429);
    clock.advance(1);
    const issued = await requestToken(mock.baseUrl);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({ expires_in: '3599' });
  });
});
