import { randomUUID } from 'node:crypto';
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

  it('rejects a request without an API key with 401 problem+json', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: null });

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await res.json()).toMatchObject({
      type: expect.any(String),
      title: expect.any(String),
      status: 401,
      code: 'UNAUTHENTICATED',
      errors: [],
    });
  });

  it('rejects an unknown API key with 401', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: 'not-a-registered-key' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('authenticates before looking at the Idempotency-Key or the body', async () => {
    const res = await postEvent(hub.baseUrl, { apiKey: 'wrong', idempotencyKey: null, body: '{not json' });

    expect(res.status).toBe(401);
  });

  it('rejects a missing Idempotency-Key with 400', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: null });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await res.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_MISSING', errors: [] });
  });

  it('accepts a 255-character Idempotency-Key and rejects a 256-character one with 400', async () => {
    // Unique per run: the suite shares one database across runs.
    const ok = await postEvent(hub.baseUrl, { idempotencyKey: randomUUID().padEnd(255, 'k') });
    const tooLong = await postEvent(hub.baseUrl, { idempotencyKey: 'k'.repeat(256) });

    expect(ok.status).toBe(202);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
  });

  it('checks the Idempotency-Key before the body', async () => {
    const res = await postEvent(hub.baseUrl, { idempotencyKey: null, body: '{not json' });

    expect(res.status).toBe(400);
  });
});
