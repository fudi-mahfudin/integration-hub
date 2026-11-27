import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import {
  ADMIN_API_KEY,
  adminRequest,
  OTHER_SOURCE_API_KEY,
  postEvent,
  prescriptionWritten,
  SOURCE_API_KEY,
  TEST_SOURCES,
  visitStarted,
} from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';

const caseRowSchema = z.object({
  caseId: z.string(),
  source: z.string(),
  visitId: z.string(),
  status: z.string(),
  currentStep: z.string().nullable(),
  waitingFor: z.string().nullable(),
  waitingSince: z.string().nullable(),
  stalled: z.boolean(),
  deadLetterReason: z.string().nullable(),
  reasonClass: z.string().nullable(),
  deadLetteredSince: z.string().nullable(),
  attempts: z.number().int(),
  updatedAt: z.string(),
});
const caseListSchema = z.object({ cases: z.array(caseRowSchema), nextCursor: z.string().nullable() });

describe('the case list: GET /v1/cases (#38)', () => {
  let database: FreshDatabase;
  let hub: BootedHub;
  let offsetMs = 0;
  /** The hub's clock, moved forward by `offsetMs`. */
  const clock = () => new Date(Date.now() + offsetMs);

  beforeAll(async () => {
    database = await createFreshDatabase();
    hub = await bootHub({ DATABASE_URL: database.url, HUB_SOURCES: TEST_SOURCES, HUB_ADMIN_API_KEY: ADMIN_API_KEY }, clock);
  });
  afterAll(async () => {
    await hub?.close();
    await database?.drop();
  });

  const caseIdOf = (res: Response) => res.headers.get('location')?.split('/').at(-1) ?? '';
  const list = async (query = '', apiKey?: string) => {
    const res = await adminRequest(hub.baseUrl, 'GET', `v1/cases${query}`, { apiKey });
    expect(res.status).toBe(200);
    return caseListSchema.parse(await res.json());
  };

  it('lists cases newest first, each as a summary row', async () => {
    const waiting = prescriptionWritten();
    const waitingId = caseIdOf(await postEvent(hub.baseUrl, { body: waiting }));
    const active = visitStarted();
    const activeId = caseIdOf(await postEvent(hub.baseUrl, { body: active }));

    const { cases, nextCursor } = await list();

    expect(nextCursor).toBeNull();
    expect(cases.map((c) => c.caseId)).toEqual([activeId, waitingId]);
    expect(cases[0]).toEqual({
      caseId: activeId,
      source: 'test-source',
      visitId: active.visitId,
      status: 'active',
      currentStep: 'create_visit',
      waitingFor: null,
      waitingSince: null,
      stalled: false,
      deadLetterReason: null,
      reasonClass: null,
      deadLetteredSince: null,
      attempts: 0,
      updatedAt: expect.stringMatching(/Z$/),
    });
    expect(cases[1]).toMatchObject({
      caseId: waitingId,
      visitId: waiting.visitId,
      status: 'waiting',
      currentStep: 'create_visit',
      waitingFor: 'visit.started',
      waitingSince: expect.stringMatching(/Z$/),
    });
  });

  it('pages with a cursor that holds its place while cases change and new ones open', async () => {
    const visits = Array.from({ length: 5 }, () => prescriptionWritten());
    const ids: string[] = [];
    for (const v of visits) ids.push(caseIdOf(await postEvent(hub.baseUrl, { body: v })));
    const newestFirst = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(`?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...page.cases.map((c) => c.caseId).filter((id) => ids.includes(id)));
      cursor = page.nextCursor;
      pages += 1;
      // Between pages: every case of the five changes (its visit starts), and a new case opens.
      if (pages === 1) {
        for (const v of visits) expect((await postEvent(hub.baseUrl, { body: visitStarted({ visitId: v.visitId }) })).status).toBe(202);
        await postEvent(hub.baseUrl, { body: visitStarted() });
      }
    } while (cursor !== null && seen.length < ids.length);

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toEqual(newestFirst);
  });

  it.each([
    ['a limit of 0', '?limit=0', '/limit'],
    ['a limit over 500', '?limit=501', '/limit'],
    ['a limit that is not a number', '?limit=ten', '/limit'],
    ['a cursor the hub never gave', '?cursor=not-a-cursor', '/cursor'],
    ['a cursor past any case', `?cursor=${Buffer.from('c1:9999999999999999999').toString('base64url')}`, '/cursor'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_, query, path) => {
    const res = await adminRequest(hub.baseUrl, 'GET', `v1/cases${query}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ path })] });
  });

  it('filters by status, visitId and source', async () => {
    const waiting = prescriptionWritten();
    const waitingId = caseIdOf(await postEvent(hub.baseUrl, { body: waiting }));
    const activeId = caseIdOf(await postEvent(hub.baseUrl, { body: visitStarted() }));
    const otherId = caseIdOf(await postEvent(hub.baseUrl, { body: visitStarted(), apiKey: OTHER_SOURCE_API_KEY }));

    const waitingIds = (await list('?status=waiting&limit=500')).cases.map((c) => c.caseId);
    expect(waitingIds).toContain(waitingId);
    expect(waitingIds).not.toContain(activeId);
    expect((await list('?status=waiting&limit=500')).cases.every((c) => c.status === 'waiting')).toBe(true);

    expect((await list(`?visitId=${encodeURIComponent(waiting.visitId)}`)).cases.map((c) => c.caseId)).toEqual([waitingId]);

    const other = (await list('?source=other-source&limit=500')).cases;
    expect(other.map((c) => c.caseId)).toContain(otherId);
    expect(other.every((c) => c.source === 'other-source')).toBe(true);
  });

  it('filters by stalled, judged as of the read', async () => {
    const stalledId = caseIdOf(await postEvent(hub.baseUrl, { body: prescriptionWritten() }));
    try {
      expect((await list('?stalled=true&limit=500')).cases.map((c) => c.caseId)).not.toContain(stalledId);
      offsetMs = 25 * 3_600_000;
      const stalled = (await list('?stalled=true&limit=500')).cases;
      expect(stalled.map((c) => c.caseId)).toContain(stalledId);
      expect(stalled.every((c) => c.stalled)).toBe(true);
      expect((await list('?stalled=false&limit=500')).cases.map((c) => c.caseId)).not.toContain(stalledId);
    } finally {
      offsetMs = 0;
    }
  });

  it("shows a source system only its own cases, whatever it asks for", async () => {
    const ownId = caseIdOf(await postEvent(hub.baseUrl, { body: visitStarted() }));
    const otherId = caseIdOf(await postEvent(hub.baseUrl, { body: visitStarted(), apiKey: OTHER_SOURCE_API_KEY }));

    const own = (await list('?limit=500', SOURCE_API_KEY)).cases;
    expect(own.map((c) => c.caseId)).toContain(ownId);
    expect(own.map((c) => c.caseId)).not.toContain(otherId);
    expect((await list('?source=other-source&limit=500', SOURCE_API_KEY)).cases).toEqual([]);
  });

  it('answers 401 UNAUTHENTICATED without a known key', async () => {
    expect((await adminRequest(hub.baseUrl, 'GET', 'v1/cases', { apiKey: null })).status).toBe(401);
    expect((await adminRequest(hub.baseUrl, 'GET', 'v1/cases', { apiKey: 'nobody' })).status).toBe(401);
  });

  it.each([
    ['an unknown status', '?status=lost', '/status'],
    ['a stalled that is not true or false', '?stalled=yes', '/stalled'],
    ['an unknown step', '?step=send_invoice', '/step'],
    ['an unknown reason', '?reason=GREMLINS', '/reason'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_, query, path) => {
    const res = await adminRequest(hub.baseUrl, 'GET', `v1/cases${query}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ path })] });
  });

  it('the case view starts with the summary row, and adds the events with their duplicates, and divergences', async () => {
    const started = visitStarted();
    const key = crypto.randomUUID();
    const res = await postEvent(hub.baseUrl, { body: started, idempotencyKey: key });
    const caseId = caseIdOf(res);
    // Five duplicates at once, then one more: each is answered with the original 202, and counted.
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => postEvent(hub.baseUrl, { body: started, idempotencyKey: key })));
    expect(duplicates.map((d) => d.headers.get('idempotent-replayed'))).toEqual(Array(5).fill('true'));
    await postEvent(hub.baseUrl, { body: started, idempotencyKey: key });
    // Not a duplicate: another body under the same key is rejected, and not counted.
    expect((await postEvent(hub.baseUrl, { body: { ...started, occurredAt: '2026-03-02T08:00:01+07:00' }, idempotencyKey: key })).status).toBe(422);
    await postEvent(hub.baseUrl, { body: prescriptionWritten({ visitId: started.visitId }) });

    const viewRes = await adminRequest(hub.baseUrl, 'GET', `v1/cases/${caseId}`);
    expect(viewRes.status).toBe(200);
    const view: unknown = await viewRes.json();
    const [row] = (await list(`?visitId=${encodeURIComponent(started.visitId)}`)).cases;
    expect(view).toMatchObject({ ...row, divergences: [] });
    expect(view).toMatchObject({
      events: [
        { type: 'visit.started', receivedAt: expect.stringMatching(/Z$/), traceId: null, duplicates: 6 },
        { type: 'prescription.written', receivedAt: expect.stringMatching(/Z$/), traceId: null, duplicates: 0 },
      ],
    });
  });
});
