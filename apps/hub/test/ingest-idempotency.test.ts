import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { getCase, OTHER_SOURCE_API_KEY, postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

describe('ingest: duplicate ingest and key reuse', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('a resend with the same key and body replays the original status and body verbatim, flagged Idempotent-Replayed', async () => {
    const key = randomUUID();
    const event = visitStarted();
    const first = await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });
    const firstBody = await first.text();

    const resend = await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });

    expect(resend.status).toBe(202);
    expect(await resend.text()).toBe(firstBody);
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
    expect(resend.headers.get('location')).toBe(first.headers.get('location'));
  });

  it('recognises the resend whatever its key order and whitespace (RFC 8785 fingerprint)', async () => {
    const key = randomUUID();
    const event = visitStarted();
    await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });
    const { data, occurredAt, visitId, type } = event;
    const reordered = `{ "data": ${JSON.stringify(data, null, 2)},\n "occurredAt": "${occurredAt}", "visitId": "${visitId}", "type": "${type}" }`;

    const resend = await postEvent(hub.baseUrl, { idempotencyKey: key, body: reordered });

    expect(resend.status).toBe(202);
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
  });

  it('the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED and records nothing', async () => {
    const key = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey: key });
    const other = visitStarted();

    const reused = await postEvent(hub.baseUrl, { idempotencyKey: key, body: other });
    const otherWithFreshKey = await postEvent(hub.baseUrl, { body: other });

    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED', errors: [] });
    // Nothing was recorded for `other`: its visit opens normally afterwards.
    expect(otherWithFreshKey.status).toBe(202);
  });

  it('a duplicate is replayed, never re-validated: key lookup comes before the event schema', async () => {
    const key = randomUUID();
    await postEvent(hub.baseUrl, { idempotencyKey: key });

    const res = await postEvent(hub.baseUrl, { idempotencyKey: key, body: '{not json' });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('the replay keeps the caseStatus snapshot taken at first acceptance', async () => {
    const key = randomUUID();
    const event = visitStarted();
    const first = await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });

    const resend = await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });

    expect(await resend.json()).toEqual(await first.json());
  });

  it('only a 202 consumes a key: after a 422 the same key is accepted with a corrected body', async () => {
    const key = randomUUID();
    const bad = visitStarted({ data: { encounterClass: 'NOPE' } });
    const corrected = { ...bad, data: { ...bad.data, encounterClass: 'AMB' } };

    const rejected = await postEvent(hub.baseUrl, { idempotencyKey: key, body: bad });
    const accepted = await postEvent(hub.baseUrl, { idempotencyKey: key, body: corrected });
    const rejectedAgain = await postEvent(hub.baseUrl, { idempotencyKey: key, body: bad });

    expect(rejected.status).toBe(422);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('idempotent-replayed')).toBeNull();
    // The bad body now meets a consumed key with a different fingerprint.
    expect(await rejectedAgain.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('a 409 does not consume its key either', async () => {
    const event = visitStarted();
    await postEvent(hub.baseUrl, { body: event });
    const key = randomUUID();

    const conflict = await postEvent(hub.baseUrl, { idempotencyKey: key, body: event });
    const fresh = await postEvent(hub.baseUrl, { idempotencyKey: key });

    expect(conflict.status).toBe(409);
    expect(fresh.status).toBe(202);
    expect(fresh.headers.get('idempotent-replayed')).toBeNull();
  });

  it('keys are per source system: another source may use the same key', async () => {
    const key = randomUUID();
    const ours = await postEvent(hub.baseUrl, { idempotencyKey: key });

    const theirs = await postEvent(hub.baseUrl, { idempotencyKey: key, apiKey: OTHER_SOURCE_API_KEY });

    expect(ours.status).toBe(202);
    expect(theirs.status).toBe(202);
    expect(theirs.headers.get('idempotent-replayed')).toBeNull();
    const theirCase = await getCase(hub.baseUrl, theirs.headers.get('location') as string, OTHER_SOURCE_API_KEY);
    expect(theirCase.status).toBe(200);
  });
});
