import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import {
  ADMIN_API_KEY,
  adminRequest,
  caseViewSchema,
  getCase,
  OTHER_SOURCE_API_KEY,
  postEvent,
  prescriptionWritten,
  SOURCE_API_KEY,
  TEST_SOURCES,
  visitStarted,
} from './support/events.js';

describe('abandonment: an operator ends a case that can never complete (ADR 0007)', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, HUB_ADMIN_API_KEY: ADMIN_API_KEY });
  });
  afterAll(async () => {
    await hub?.close();
  });

  const caseIdOf = (res: Response) => res.headers.get('location')?.split('/').at(-1) ?? '';
  const abandon = (caseId: string, body: unknown, apiKey?: string | null) =>
    adminRequest(hub.baseUrl, 'POST', `v1/cases/${caseId}/abandon`, { body, apiKey });

  /** A case waiting for its visit.started: only its prescription has arrived. */
  async function waitingCase() {
    const prescription = prescriptionWritten();
    const key = crypto.randomUUID();
    const res = await postEvent(hub.baseUrl, { body: prescription, idempotencyKey: key });
    expect(res.status).toBe(202);
    return { caseId: caseIdOf(res), prescription, key };
  }

  it('abandons a waiting case with a note: every step not completed is abandoned, and the abandonment records what the case waited for', async () => {
    const { caseId } = await waitingCase();

    const res = await abandon(caseId, { note: 'The hospital confirmed the visit was registered by mistake' });

    expect(res.status).toBe(200);
    const view = caseViewSchema.parse(await res.json());
    expect(view).toMatchObject({ caseId, status: 'abandoned', waitingFor: null, waitingSince: null, stalled: false });
    expect(view.steps.map((s) => s.state)).toEqual(['abandoned', 'abandoned', 'abandoned', 'abandoned']);
    expect(view.abandonment).toEqual({
      note: 'The hospital confirmed the visit was registered by mistake',
      abandonedAt: expect.stringMatching(/Z$/),
      previousStatus: 'waiting',
      waitingFor: 'visit.started',
      deadLetterReason: null,
      remoteRecordsLeft: [],
    });
    // The source system sees the same case.
    const seen = caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json());
    expect(seen).toMatchObject({ status: 'abandoned', abandonment: view.abandonment });
  });

  it.each([
    ['no note', {}],
    ['an empty note', { note: '' }],
    ['a blank note', { note: '   ' }],
    ['no body', undefined],
  ])('rejects %s with 422 VALIDATION_FAILED and changes nothing', async (_, body) => {
    const { caseId } = await waitingCase();

    const res = await abandon(caseId, body);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ path: '/note' })] });
    const view = caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json());
    expect(view).toMatchObject({ status: 'waiting', abandonment: null });
  });

  it('answers 409 CASE_NOT_ABANDONABLE for an active case, and for a case already abandoned', async () => {
    const active = caseIdOf(await postEvent(hub.baseUrl, { body: visitStarted() }));
    const notActive = await abandon(active, { note: 'x' });
    expect(notActive.status).toBe(409);
    expect(await notActive.json()).toMatchObject({ code: 'CASE_NOT_ABANDONABLE' });

    const { caseId } = await waitingCase();
    expect((await abandon(caseId, { note: 'first' })).status).toBe(200);
    const again = await abandon(caseId, { note: 'second' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'CASE_NOT_ABANDONABLE' });
  });

  it('on an abandoned case a duplicate ingest still gets its original 202; any other event is 409 CASE_ABANDONED, in the rejection log', async () => {
    const { caseId, prescription, key } = await waitingCase();
    await abandon(caseId, { note: 'never coming' });

    const duplicate = await postEvent(hub.baseUrl, { body: prescription, idempotencyKey: key });
    expect(duplicate.status).toBe(202);
    expect(duplicate.headers.get('idempotent-replayed')).toBe('true');
    expect(await duplicate.json()).toMatchObject({ caseStatus: 'waiting' });

    const late = await postEvent(hub.baseUrl, { body: visitStarted({ visitId: prescription.visitId }) });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'CASE_ABANDONED' });
    const resent = await postEvent(hub.baseUrl, { body: prescription });
    expect(resent.status).toBe(409);
    expect(await resent.json()).toMatchObject({ code: 'CASE_ABANDONED' });

    const view = caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json());
    expect(view.rejections).toEqual([
      expect.objectContaining({ code: 'CASE_ABANDONED', eventType: 'visit.started' }),
      expect.objectContaining({ code: 'CASE_ABANDONED', eventType: 'prescription.written' }),
    ]);
    expect(view.steps.map((s) => s.state)).toEqual(['abandoned', 'abandoned', 'abandoned', 'abandoned']);
  });

  it('is for the admin key only: 401 without a key, 403 for a source system’s key; an unknown case is 404', async () => {
    const { caseId } = await waitingCase();
    expect((await abandon(caseId, { note: 'x' }, null)).status).toBe(401);
    expect((await abandon(caseId, { note: 'x' }, SOURCE_API_KEY)).status).toBe(403);
    expect((await abandon(crypto.randomUUID(), { note: 'x' })).status).toBe(404);
    expect((await abandon('not-a-uuid', { note: 'x' })).status).toBe(404);
  });

  it('lets the admin key read any source system’s case, which other source systems still cannot', async () => {
    const { caseId } = await waitingCase();
    expect((await getCase(hub.baseUrl, caseId, ADMIN_API_KEY)).status).toBe(200);
    expect((await getCase(hub.baseUrl, caseId, OTHER_SOURCE_API_KEY)).status).toBe(404);
  });
});
