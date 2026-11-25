import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { OTHER_SOURCE_API_KEY, postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

describe('ingest: duplicate ingest and idempotency keys', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('a resend with the same key and body replays the original status and body verbatim, flagged Idempotent-Replayed', async () => {
    const idempotencyKey = randomUUID();
    const body = visitStarted();
    const first = await postEvent(hub.baseUrl, { idempotencyKey, body });
    const firstBody = await first.text();

    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body });

    expect(resend.status).toBe(first.status);
    expect(await resend.text()).toBe(firstBody);
    expect(resend.headers.get('location')).toBe(first.headers.get('location'));
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
  });

  it('the fingerprint ignores key order and whitespace: a reordered, reformatted body is the same request', async () => {
    const idempotencyKey = randomUUID();
    const event = visitStarted();
    await postEvent(hub.baseUrl, { idempotencyKey, body: event });
    const { data, occurredAt, visitId, type } = event;
    const reordered = JSON.stringify({ data, occurredAt, visitId, type }, null, 2);

    const resend = await postEvent(hub.baseUrl, { idempotencyKey, body: reordered });

    expect(resend.status).toBe(202);
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
  });

  it('the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED and records nothing', async () => {
    const idempotencyKey = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey, body: visitStarted() });
    const other = visitStarted();

    const reuse = await postEvent(hub.baseUrl, { idempotencyKey, body: other });
    // Nothing was recorded for the other visit: it can still be accepted with a fresh key.
    const later = await postEvent(hub.baseUrl, { body: other });

    expect(reuse.status).toBe(422);
    expect(reuse.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await reuse.json()).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(later.status).toBe(202);
  });

  it('the key is looked up before the schema: reusing it for an invalid body is still IDEMPOTENCY_KEY_REUSED', async () => {
    const idempotencyKey = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey });

    const reuse = await postEvent(hub.baseUrl, { idempotencyKey, body: { type: 'nonsense' } });

    expect(reuse.status).toBe(422);
    expect(await reuse.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('a second visit.started for the same visit with a different key is 409 EVENT_ALREADY_RECORDED', async () => {
    const body = visitStarted();
    await postEvent(hub.baseUrl, { body });

    const again = await postEvent(hub.baseUrl, { body });

    expect(again.status).toBe(409);
    expect(again.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(await again.json()).toMatchObject({ status: 409, code: 'EVENT_ALREADY_RECORDED' });
  });

  it('a 409 consumes no key: the key stays free for another event', async () => {
    const body = visitStarted();
    await postEvent(hub.baseUrl, { body });
    const idempotencyKey = randomUUID();

    const conflict = await postEvent(hub.baseUrl, { idempotencyKey, body });
    const fresh = await postEvent(hub.baseUrl, { idempotencyKey, body: visitStarted() });

    expect(conflict.status).toBe(409);
    expect(fresh.status).toBe(202);
    expect(fresh.headers.get('idempotent-replayed')).toBeNull();
  });

  it('keys are scoped to the source system: another source system may use the same key', async () => {
    const idempotencyKey = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey, body: visitStarted() });

    const theirs = await postEvent(hub.baseUrl, { idempotencyKey, body: visitStarted(), apiKey: OTHER_SOURCE_API_KEY });

    expect(theirs.status).toBe(202);
    expect(theirs.headers.get('idempotent-replayed')).toBeNull();
  });
});
