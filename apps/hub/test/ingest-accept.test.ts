import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { getCase, OTHER_SOURCE_API_KEY, postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

describe('ingest: accepting visit.started', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('answers 202 { visitId, type, caseStatus } and opens an active case', async () => {
    const event = visitStarted();

    const res = await postEvent(hub.baseUrl, { body: event });

    expect(res.status).toBe(202);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(await res.json()).toEqual({ visitId: event.visitId, type: 'visit.started', caseStatus: 'active' });
    expect(res.headers.get('location')).toMatch(/^\/v1\/cases\/[0-9a-f-]{36}$/);
  });

  it('GET /v1/cases/{id} shows the case with all four steps, create visit ready', async () => {
    const event = visitStarted();
    const accepted = await postEvent(hub.baseUrl, { body: event });
    const location = accepted.headers.get('location') as string;

    const res = await getCase(hub.baseUrl, location);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caseId: location.split('/').pop(),
      source: 'test-source',
      visitId: event.visitId,
      status: 'active',
      waitingFor: null,
      waitingSince: null,
      rejections: [],
      steps: [
        { step: 'create_visit', eventType: 'visit.started', state: 'ready', attempts: 0, deadLetterReason: null, remote: null, pins: null, attemptLog: [] },
        { step: 'submit_prescription', eventType: 'prescription.written', state: 'awaiting_event', attempts: 0, deadLetterReason: null, remote: null, pins: null, attemptLog: [] },
        { step: 'submit_dispense', eventType: 'drug.dispensed', state: 'awaiting_event', attempts: 0, deadLetterReason: null, remote: null, pins: null, attemptLog: [] },
        { step: 'update_visit', eventType: 'visit.finished', state: 'awaiting_event', attempts: 0, deadLetterReason: null, remote: null, pins: null, attemptLog: [] },
      ],
    });
  });

  it("does not show one source system's case to another (404)", async () => {
    const accepted = await postEvent(hub.baseUrl);
    const location = accepted.headers.get('location') as string;

    const res = await getCase(hub.baseUrl, location, OTHER_SOURCE_API_KEY);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('GET /v1/cases/{id} needs an API key (401) and answers 404 for an unknown id', async () => {
    const noKey = await fetch(`${hub.baseUrl}/v1/cases/00000000-0000-4000-8000-000000000000`);
    const unknown = await getCase(hub.baseUrl, '/v1/cases/00000000-0000-4000-8000-000000000000');
    const notUuid = await getCase(hub.baseUrl, '/v1/cases/nope');

    expect(noKey.status).toBe(401);
    expect(unknown.status).toBe(404);
    expect(notUuid.status).toBe(404);
  });

  it('keys cases by (source, visitId): the same visitId from another source is a separate case', async () => {
    const event = visitStarted();

    const ours = await postEvent(hub.baseUrl, { body: event });
    const theirs = await postEvent(hub.baseUrl, { body: event, apiKey: OTHER_SOURCE_API_KEY });

    expect(ours.status).toBe(202);
    expect(theirs.status).toBe(202);
    expect(theirs.headers.get('location')).not.toBe(ours.headers.get('location'));
  });

  it('a second visit.started for the same visit with a different key is 409 EVENT_ALREADY_RECORDED', async () => {
    const event = visitStarted();
    await postEvent(hub.baseUrl, { body: event });

    const res = await postEvent(hub.baseUrl, { body: event });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 409, code: 'EVENT_ALREADY_RECORDED', errors: [] });
  });
});
