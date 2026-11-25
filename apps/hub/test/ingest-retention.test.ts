import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

const HOUR = 3_600_000;

describe('ingest: idempotency key retention', () => {
  let hub: BootedHub;
  // The hub's injected clock, moved forward by each test. It starts a year in
  // the past so a purge here only reaches keys this clock wrote: other suites
  // write wall-clock keys, which stay newer than any cutoff this clock computes.
  let now = Date.now() - 365 * 24 * HOUR;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES }, () => new Date(now));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('after a purge past the 24h window, an identical resend is 409 EVENT_ALREADY_RECORDED', async () => {
    const idempotencyKey = randomUUID();
    const body = visitStarted();
    expect((await postEvent(hub.baseUrl, { idempotencyKey, body })).status).toBe(202);

    now += 24 * HOUR + 1000;
    await hub.purgeIdempotencyKeys();
    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body });

    expect(resend.status).toBe(409);
    expect(await resend.json()).toMatchObject({ code: 'EVENT_ALREADY_RECORDED' });
  });

  it('a purge keeps keys younger than 24h: an identical resend still gets the original answer', async () => {
    const idempotencyKey = randomUUID();
    const body = visitStarted();
    await postEvent(hub.baseUrl, { idempotencyKey, body });

    now += 24 * HOUR - 1000;
    await hub.purgeIdempotencyKeys();
    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body });

    expect(resend.status).toBe(202);
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
  });

  it('until the purge runs, an old key still gets the original answer', async () => {
    const idempotencyKey = randomUUID();
    const body = visitStarted();
    await postEvent(hub.baseUrl, { idempotencyKey, body });

    now += 48 * HOUR;
    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body });

    expect(resend.headers.get('idempotent-replayed')).toBe('true');
  });

  it('a purged key is free to carry a new event', async () => {
    const idempotencyKey = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey });

    now += 25 * HOUR;
    await hub.purgeIdempotencyKeys();
    const fresh = await postEvent(hub.baseUrl, { idempotencyKey });

    expect(fresh.status).toBe(202);
    expect(fresh.headers.get('idempotent-replayed')).toBeNull();
  });
});

describe('ingest: retention configuration', () => {
  it('refuses to boot with a retention window under 24h', async () => {
    await expect(bootHub({ IDEMPOTENCY_RETENTION_HOURS: '23' })).rejects.toThrow(/IDEMPOTENCY_RETENTION_HOURS.*at least 24/);
  });
});
