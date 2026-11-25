import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { getCase, newVisitId, postEvent, TEST_SOURCES, visitFinished, visitStarted, type CaseView } from './support/events.js';

describe('ingest: visit.finished', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  async function problem(body: unknown) {
    const res = await postEvent(hub.baseUrl, { body });
    expect(res.status).toBe(422);
    const p = (await res.json()) as { code: string; errors: { path: string; code: string }[] };
    return { code: p.code, errors: p.errors.map(({ path, code }) => ({ path, code })) };
  }

  const view = async (location: string) => (await (await getCase(hub.baseUrl, location)).json()) as CaseView;

  it('accepts a valid visit.finished and stores it blocked behind its predecessors', async () => {
    const res = await postEvent(hub.baseUrl, { body: visitFinished() });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ type: 'visit.finished', caseStatus: 'waiting' });
    const v = await view(res.headers.get('location') as string);
    expect(v).toMatchObject({ waitingFor: 'visit.started' });
    expect(v.steps.map((s) => s.state)).toEqual(['awaiting_event', 'awaiting_event', 'awaiting_event', 'blocked']);
  });

  it('finishedAt is required, needs an offset and respects the floor', async () => {
    expect(await problem({ ...visitFinished(), data: {} })).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/data/finishedAt', code: 'REQUIRED' }],
    });
    expect(await problem(visitFinished({ data: { finishedAt: '2026-03-02T09:30:00' } }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/data/finishedAt', code: 'TIME_OFFSET_MISSING' }],
    });
    expect(await problem(visitFinished({ data: { finishedAt: '2014-06-03T05:00:00+07:00' } }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: '/data/finishedAt', code: 'DATE_BEFORE_FLOOR' }],
    });
  });

  describe('finishedAt > startedAt, checked when the second of the pair arrives (#9)', () => {
    // visitStarted(): startedAt 2026-03-02T08:00:00+07:00 = 01:00:00Z.
    it('finished second, at or before startedAt (compared as instants) → 422 FINISHED_BEFORE_STARTED, nothing stored', async () => {
      const visitId = newVisitId();
      const started = await postEvent(hub.baseUrl, { body: visitStarted({ visitId }) });
      expect(started.status).toBe(202);

      // 00:59:59Z, written in another offset than startedAt.
      expect(await problem(visitFinished({ visitId, data: { finishedAt: '2026-03-02T00:59:59Z' } }))).toEqual({
        code: 'FINISHED_BEFORE_STARTED',
        errors: [{ path: '/data/finishedAt', code: 'FINISHED_BEFORE_STARTED' }],
      });
      // Equal is not after.
      expect((await problem(visitFinished({ visitId, data: { finishedAt: '2026-03-02T01:00:00+00:00' } }))).code).toBe(
        'FINISHED_BEFORE_STARTED',
      );

      const v = await view(started.headers.get('location') as string);
      expect(v.steps[3]!.state).toBe('awaiting_event');
      expect(v.rejections).toMatchObject([
        { code: 'FINISHED_BEFORE_STARTED', eventType: 'visit.finished' },
        { code: 'FINISHED_BEFORE_STARTED', eventType: 'visit.finished' },
      ]);
      // One second later is accepted.
      const later = await postEvent(hub.baseUrl, { body: visitFinished({ visitId, data: { finishedAt: '2026-03-02T01:00:01Z' } }) });
      expect(later.status).toBe(202);
    });

    it('started second, not before finishedAt → 422 FINISHED_BEFORE_STARTED at /data/startedAt', async () => {
      const visitId = newVisitId();
      const finished = await postEvent(hub.baseUrl, { body: visitFinished({ visitId, data: { finishedAt: '2026-03-02T07:59:00+07:00' } }) });
      expect(finished.status).toBe(202);

      expect(await problem(visitStarted({ visitId }))).toEqual({
        code: 'FINISHED_BEFORE_STARTED',
        errors: [{ path: '/data/startedAt', code: 'FINISHED_BEFORE_STARTED' }],
      });
      const earlier = await postEvent(hub.baseUrl, { body: visitStarted({ visitId, data: { startedAt: '2026-03-02T07:58:00+07:00' } }) });
      expect(earlier.status).toBe(202);
    });
  });
});
