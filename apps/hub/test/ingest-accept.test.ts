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
  });

  it('GET /v1/cases/{id} shows the case status and all four step states', async () => {
    const event = visitStarted();
    const accepted = await postEvent(hub.baseUrl, { body: event });
    const location = accepted.headers.get('location');
    expect(location).toMatch(/^\/v1\/cases\/[0-9a-f-]{36}$/);

    const res = await getCase(hub.baseUrl, location?.split('/').at(-1) ?? '');
    // No worker runs against this database, so no step has been claimed.
    const unworked = { attempts: 0, deadLetterReason: null, remote: null };

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caseId: location?.split('/').at(-1),
      visitId: event.visitId,
      status: 'active',
      waitingFor: null,
      waitingSince: null,
      steps: [
        { step: 'create_visit', eventType: 'visit.started', state: 'ready', ...unworked },
        { step: 'submit_prescription', eventType: 'prescription.written', state: 'awaiting_event', ...unworked },
        { step: 'submit_dispense', eventType: 'drug.dispensed', state: 'awaiting_event', ...unworked },
        { step: 'update_visit', eventType: 'visit.finished', state: 'awaiting_event', ...unworked },
      ],
    });
  });

  it("a source system cannot read another source system's case", async () => {
    const accepted = await postEvent(hub.baseUrl);
    const caseId = accepted.headers.get('location')?.split('/').at(-1) ?? '';

    const res = await getCase(hub.baseUrl, caseId, OTHER_SOURCE_API_KEY);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  });

  it('two source systems may use the same visitId: each gets its own case', async () => {
    const event = visitStarted();

    const ours = await postEvent(hub.baseUrl, { body: event });
    const theirs = await postEvent(hub.baseUrl, { body: event, apiKey: OTHER_SOURCE_API_KEY });

    expect(ours.status).toBe(202);
    expect(theirs.status).toBe(202);
    expect(theirs.headers.get('location')).not.toBe(ours.headers.get('location'));
  });
});
