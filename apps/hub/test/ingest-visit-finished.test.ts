import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { caseViewSchema, getCase, newVisitId, postEvent, TEST_SOURCES, visitFinished, visitStarted } from './support/events.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';

const problemSchema = z.object({
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
});

/** Ingest of visit.finished. No worker runs, so no step leaves `ready`. */
describe('ingest: visit.finished', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });
  afterAll(async () => {
    await hub?.close();
  });

  const caseOf = async (res: Response) => {
    const caseId = res.headers.get('location')?.split('/').at(-1) ?? '';
    return caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId)).json());
  };
  const problemOf = async (res: Response) => problemSchema.parse(await res.json());

  it('accepts a visit.finished after its visit started, its step blocked behind the earlier steps', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });

    const res = await postEvent(hub.baseUrl, { body: visitFinished({ visitId }) });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ visitId, type: 'visit.finished', caseStatus: 'active' });
    const view = await caseOf(res);
    expect(view.steps.map((s) => s.state)).toEqual(['ready', 'awaiting_event', 'awaiting_event', 'blocked']);
    expectAtMostOneStepInMotion(view);
  });

  it('accepts a visit.finished that arrives first, and opens a case waiting for visit.started', async () => {
    const res = await postEvent(hub.baseUrl, { body: visitFinished() });

    expect(res.status).toBe(202);
    expect(await caseOf(res)).toMatchObject({ status: 'waiting', waitingFor: 'visit.started' });
  });

  it.each([
    ['no finishedAt', {}, '/data/finishedAt', 'REQUIRED'],
    ['a finishedAt without an offset', { finishedAt: '2026-03-02T09:00:00' }, '/data/finishedAt', 'TIME_OFFSET_MISSING'],
    ['a finishedAt before the date floor in UTC', { finishedAt: '2014-06-03T05:00:00+07:00' }, '/data/finishedAt', 'DATE_BEFORE_FLOOR'],
    ['a finishedAt that is not a time', { finishedAt: 'tomorrow' }, '/data/finishedAt', 'INVALID_FORMAT'],
  ])('rejects %s as VALIDATION_FAILED', async (_, data, path, code) => {
    const event = visitFinished();
    const res = await postEvent(hub.baseUrl, { body: { ...event, data } });

    expect(res.status).toBe(422);
    expect(await problemOf(res)).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path, code }] });
  });

  it.each([
    ['before', '2026-03-02T07:59:59+07:00'],
    ['at the same instant as', '2026-03-02T01:00:00+00:00'],
  ])('rejects a visit.finished %s its startedAt as 422 FINISHED_BEFORE_STARTED, recording nothing', async (_, finishedAt) => {
    const visitId = newVisitId();
    const started = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });

    const rejected = await postEvent(hub.baseUrl, { body: visitFinished({ visitId, data: { finishedAt } }) });

    expect(rejected.status).toBe(422);
    expect(await problemOf(rejected)).toMatchObject({
      code: 'FINISHED_BEFORE_STARTED',
      errors: [{ path: '/data/finishedAt', code: 'FINISHED_BEFORE_STARTED' }],
    });
    const view = await caseOf(started);
    expect(view.steps[3]).toMatchObject({ step: 'update_visit', state: 'awaiting_event' });
    expect(view.rejections).toEqual([expect.objectContaining({ code: 'FINISHED_BEFORE_STARTED', eventType: 'visit.finished' })]);
    // With a later finishedAt, the event is then accepted.
    expect((await postEvent(hub.baseUrl, { body: visitFinished({ visitId }) })).status).toBe(202);
  });

  it('compares instants, not local times: 08:30+07:00 is before a start of 02:00+00:00', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: visitStarted({ visitId, data: { startedAt: '2026-03-02T02:00:00+00:00' } }) });

    const rejected = await postEvent(hub.baseUrl, { body: visitFinished({ visitId, data: { finishedAt: '2026-03-02T08:30:00+07:00' } }) });

    expect((await problemOf(rejected)).code).toBe('FINISHED_BEFORE_STARTED');
  });

  it('rejects a visit.started arriving after a visit.finished that is not later than it, naming startedAt', async () => {
    const visitId = newVisitId();
    const finished = await postEvent(hub.baseUrl, { body: visitFinished({ visitId }) });

    const rejected = await postEvent(hub.baseUrl, { body: visitStarted({ visitId, data: { startedAt: '2026-03-02T09:30:00+07:00' } }) });

    expect(rejected.status).toBe(422);
    expect(await problemOf(rejected)).toMatchObject({
      code: 'FINISHED_BEFORE_STARTED',
      errors: [{ path: '/data/startedAt', code: 'FINISHED_BEFORE_STARTED' }],
    });
    expect((await caseOf(finished)).steps[0]).toMatchObject({ step: 'create_visit', state: 'awaiting_event' });
  });

  it('rejects a second visit.finished for the visit as 409 EVENT_ALREADY_RECORDED', async () => {
    const visitId = newVisitId();
    await postEvent(hub.baseUrl, { body: visitFinished({ visitId }) });

    const again = await postEvent(hub.baseUrl, { body: visitFinished({ visitId, data: { finishedAt: '2026-03-02T10:00:00+07:00' } }) });

    expect(again.status).toBe(409);
  });
});
