import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, TEST_SOURCES } from './support/events.js';

describe('ingest: authentication and the Idempotency-Key header', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('a missing API key is 401 UNAUTHENTICATED as an RFC 9457 problem', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: null });

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await res.json()).toEqual({
      type: expect.stringMatching(/^https:\/\/.+#unauthenticated$/),
      title: expect.any(String),
      status: 401,
      code: 'UNAUTHENTICATED',
      errors: [],
    });
  });

  it('a wrong API key is 401 UNAUTHENTICATED', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: 'not-a-registered-key' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('authentication is checked before the Idempotency-Key and the body', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: 'wrong', idempotencyKey: null, body: 'not json' });

    expect(res.status).toBe(401);
  });

  it('a missing Idempotency-Key is 400 IDEMPOTENCY_KEY_MISSING', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: null });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await res.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_MISSING', errors: [] });
  });

  it('an Idempotency-Key longer than 255 characters is 400 IDEMPOTENCY_KEY_INVALID', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: 'k'.repeat(256) });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
  });

  it('an Idempotency-Key of exactly 255 characters is accepted', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: `${crypto.randomUUID()}`.padEnd(255, 'k') });

    expect(res.status).toBe(202);
  });

  it('the Idempotency-Key is checked before the body', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: null, body: 'not json' });

    expect(res.status).toBe(400);
  });
});
