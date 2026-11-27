import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { awaitRun as awaitRunAt, listRuns, readRun, requestRun, type Run } from './support/reconciliation.js';
import {
  bootMock,
  createEncounterAtMock,
  createMedicationRequestAtMock,
  WORLD_SOURCE_API_KEY,
  worldEnv,
  worldPrescriptionWritten,
  worldVisit,
  worldVisitEvents,
  worldVisitFinished,
  worldVisitStarted,
  worldDrugDispensed,
  type BootedMock,
} from './support/satusehat.js';

describe('reconciliation: compares cases at rest with their records at SATUSEHAT (#39)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = async (body: unknown) => {
    const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    expect(res.status).toBe(202);
    return res.headers.get('location');
  };
  const until = (location: string | null, done: (v: CaseView) => boolean) =>
    waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

  /** Delivers a whole world visit; resolves to its completed case. */
  async function completedCase() {
    const { events } = worldVisitEvents();
    let location: string | null = null;
    for (const event of events) location = await send(event);
    return until(location, (v) => v.status === 'completed');
  }

  /** Starts a run over `caseIds` and long-polls it until it ends. */
  const reconcile = async (caseIds: string[]): Promise<Run> => awaitRun(await requestRun(hub.baseUrl, { caseIds }));
  const awaitRun = (runId: string) => awaitRunAt(hub.baseUrl, runId);

  it('a clean scenario: a completed case matches SATUSEHAT, and the run finds nothing', async () => {
    const kase = await completedCase();

    const run = await reconcile([kase.caseId]);

    expect(run).toMatchObject({ status: 'completed', trigger: 'operator', findings: [], nextCursor: null });
    expect(run.counts).toEqual({ cases: 1, clean: 1, divergent: 0, skipped: 0, unchecked: 0 });
  });

  it('DELETE of a completed step’s record → REMOTE_MISSING, shown on the case view', async () => {
    const kase = await completedCase();
    const dispense = kase.steps[2]?.remote;
    await mock.client.deleteRecord('MedicationDispense', dispense?.id ?? '');

    const run = await reconcile([kase.caseId]);

    expect(run.status).toBe('completed');
    expect(run.findings).toEqual([
      expect.objectContaining({
        caseId: kase.caseId,
        kind: 'divergence',
        class: 'REMOTE_MISSING',
        step: 'submit_dispense',
        resourceType: 'MedicationDispense',
        field: null,
        snapshot: { expected: dispense, found: [] },
      }),
    ]);
    const view = await until(`/v1/cases/${kase.caseId}`, () => true);
    expect(view.divergences).toEqual([
      expect.objectContaining({ runId: run.runId, class: 'REMOTE_MISSING', step: 'submit_dispense', resourceType: 'MedicationDispense' }),
    ]);
    // Reconciliation only reports: the case is as it was.
    expect(view).toMatchObject({ status: 'completed', updatedAt: kase.updatedAt });
  });

  it('a record inserted for a step an operator abandoned → REMOTE_UNEXPECTED (ADR 0007)', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId, { item: { drugCode: `UNMAPPED-${crypto.randomUUID()}` } });
    const location = await send(visit);
    await send(prescription);
    const deadLettered = await until(location, (v) => v.status === 'dead_lettered');
    expect((await adminRequest(hub.baseUrl, 'POST', `v1/cases/${deadLettered.caseId}/abandon`, { body: { note: 'wrong drug' } })).status).toBe(200);
    const encounterId = deadLettered.steps[0]?.remote?.id ?? '';
    const plantedId = await createMedicationRequestAtMock(mock.baseUrl, encounterId, prescription.data.prescriptionId);

    const run = await reconcile([deadLettered.caseId]);

    expect(run.findings).toEqual([
      expect.objectContaining({
        kind: 'divergence',
        class: 'REMOTE_UNEXPECTED',
        step: 'submit_prescription',
        resourceType: 'MedicationRequest',
        snapshot: { expected: null, found: [{ type: 'MedicationRequest', id: plantedId, version: '1' }] },
      }),
    ]);
    // The Encounter its completed create visit left is expected, and there.
    expect(run.counts).toMatchObject({ cases: 1, divergent: 1 });
  });

  it('a second record under a completed step’s identifier → REMOTE_DUPLICATE', async () => {
    const kase = await completedCase();
    await createEncounterAtMock(mock.baseUrl, kase.visitId);

    const run = await reconcile([kase.caseId]);

    expect(run.findings).toEqual([
      expect.objectContaining({ class: 'REMOTE_DUPLICATE', step: 'create_visit', resourceType: 'Encounter', field: null }),
    ]);
    const { found } = z.object({ found: z.array(z.object({ id: z.string() })) }).parse(run.findings[0]?.snapshot);
    expect(found.map((r) => r.id)).toContain(kase.steps[0]?.remote?.id);
    expect(found).toHaveLength(2);
  });

  it('the stored record deleted and another inserted under the same identifier → REMOTE_ID_MISMATCH', async () => {
    const kase = await completedCase();
    const stored = kase.steps[0]?.remote;
    await mock.client.deleteRecord('Encounter', stored?.id ?? '');
    await createEncounterAtMock(mock.baseUrl, kase.visitId);

    const run = await reconcile([kase.caseId]);

    expect(run.findings).toEqual([
      expect.objectContaining({
        class: 'REMOTE_ID_MISMATCH',
        step: 'create_visit',
        resourceType: 'Encounter',
        snapshot: { expected: stored, found: [expect.objectContaining({ type: 'Encounter', id: expect.not.stringMatching(stored?.id ?? '') })] },
      }),
    ]);
  });

  it('PATCH of a stored record → FIELD_MISMATCH by field; a person’s IHS number only as differs: true', async () => {
    const kase = await completedCase();
    const encounter = kase.steps[0]?.remote;
    const medicationRequest = kase.steps[1]?.remote;
    await mock.client.patchRecord('Encounter', encounter?.id ?? '', { status: 'cancelled' });
    await mock.client.patchRecord('MedicationRequest', medicationRequest?.id ?? '', { subject: { reference: 'Patient/P99999999999' } });

    const run = await reconcile([kase.caseId]);

    expect(run.findings.map((f) => [f.class, f.step, f.resourceType, f.field, f.snapshot])).toEqual([
      ['FIELD_MISMATCH', 'update_visit', 'Encounter', 'status', { expected: 'finished', actual: 'cancelled' }],
      ['FIELD_MISMATCH', 'update_visit', 'Encounter', 'meta.versionId', { expected: kase.steps[3]?.remote?.version, actual: '3' }],
      ['FIELD_MISMATCH', 'submit_prescription', 'MedicationRequest', 'subject', { differs: true }],
    ]);
    const body = JSON.stringify(run);
    expect(body).not.toContain('P99999999999');
    expect(body).not.toContain(worldVisit.patient.ihsNumber);

    // Findings come a page at a time, in the order they were found.
    const page = (query: string) => readRun(hub.baseUrl, run.runId, query);
    const first = await page('limit=2');
    expect(first.findings.map((f) => f.field)).toEqual(['status', 'meta.versionId']);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(`limit=2&cursor=${first.nextCursor}`);
    expect(second).toMatchObject({ findings: [expect.objectContaining({ field: 'subject' })], nextCursor: null });
  });

  it('a case that changes during its check (held search, an event arrives) → skipped, and nothing compared', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);
    const location = await send(visit);
    await send(prescription);
    await send(worldDrugDispensed(prescription));
    const waiting = await until(location, (v) => v.status === 'waiting' && v.waitingFor === 'visit.finished');
    await mock.client.setFaults({ seed: 39, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    try {
      const runId = await requestRun(hub.baseUrl, { caseIds: [waiting.caseId] });
      const [hold] = await mock.client.holds(10_000);
      await send(worldVisitFinished(visit));
      await mock.client.releaseHold(hold?.id ?? '');

      const run = await awaitRun(runId);

      expect(run.status).toBe('completed');
      expect(run.counts).toEqual({ cases: 1, clean: 0, divergent: 0, skipped: 1, unchecked: 0 });
      expect(run.findings).toEqual([expect.objectContaining({ caseId: waiting.caseId, kind: 'skipped', class: null })]);
    } finally {
      await mock.client.setFaults({ seed: 39, rules: [] });
    }
    // A skipped check covers nothing: the case view shows no divergences from it.
    const done = await until(location, (v) => v.status === 'completed');
    expect(done.divergences).toEqual([]);
  });

  it('a search that still fails after its read retries → unchecked, and the run ends completed_with_errors', async () => {
    const kase = await completedCase();
    await mock.client.setFaults({ seed: 39, rules: [{ id: 'search-down', match: { method: 'GET', resourceType: 'MedicationRequest' }, rate: 1, kind: 'http_503' }] });
    let run: Run;
    try {
      run = await reconcile([kase.caseId]);
    } finally {
      await mock.client.setFaults({ seed: 39, rules: [] });
    }

    expect(run.status).toBe('completed_with_errors');
    expect(run.counts).toEqual({ cases: 1, clean: 0, divergent: 0, skipped: 0, unchecked: 1 });
    expect(run.findings).toEqual([
      expect.objectContaining({ caseId: kase.caseId, kind: 'unchecked', snapshot: expect.objectContaining({ error: expect.stringContaining('503') }) }),
    ]);
    // Three tries in all: no more than the read retries.
    const searches = (await mock.client.log({ resourceType: 'MedicationRequest' })).filter((e) => e.method === 'GET' && e.fault === 'search-down');
    expect(searches).toHaveLength(3);
  });

  it('one run at a time: a request while one runs is 409 RECONCILIATION_RUNNING naming it; the list shows the latest first', async () => {
    const kase = await completedCase();
    await mock.client.setFaults({ seed: 39, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    try {
      const runId = await requestRun(hub.baseUrl, { caseIds: [kase.caseId] });
      const [hold] = await mock.client.holds(10_000);

      const second = await adminRequest(hub.baseUrl, 'POST', 'v1/admin/reconciliation/runs', { body: {} });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: 'RECONCILIATION_RUNNING', runId });
      expect(await readRun(hub.baseUrl, runId, 'wait=0')).toMatchObject({ runId, status: 'running' });

      await mock.client.releaseHold(hold?.id ?? '');
      expect(await awaitRun(runId)).toMatchObject({ status: 'completed' });
      const list = await listRuns(hub.baseUrl, 1);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ runId, status: 'completed', scope: { caseIds: [kase.caseId], since: null } });
    } finally {
      await mock.client.setFaults({ seed: 39, rules: [] });
    }
  });

  it('is for the admin key only; an unknown run is 404; a bad body or query is 422', async () => {
    const path = 'v1/admin/reconciliation/runs';
    expect((await adminRequest(hub.baseUrl, 'POST', path, { body: {}, apiKey: null })).status).toBe(401);
    expect((await adminRequest(hub.baseUrl, 'POST', path, { body: {}, apiKey: WORLD_SOURCE_API_KEY })).status).toBe(403);
    expect((await adminRequest(hub.baseUrl, 'GET', path, { apiKey: WORLD_SOURCE_API_KEY })).status).toBe(403);
    expect((await adminRequest(hub.baseUrl, 'GET', `${path}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await adminRequest(hub.baseUrl, 'GET', `${path}/not-a-run`)).status).toBe(404);

    const badBody = await adminRequest(hub.baseUrl, 'POST', path, { body: { caseIds: ['x'], since: '2026-03-02' } });
    expect(badBody.status).toBe(422);
    expect(await badBody.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: '/caseIds/0' }), expect.objectContaining({ path: '/since' })],
    });
    const badQuery = await adminRequest(hub.baseUrl, 'GET', `${path}/${crypto.randomUUID()}?wait=70000`);
    expect(badQuery.status).toBe(422);
  });

  it('scope: only cases at rest; caseIds and since narrow it', async () => {
    const atRest = await completedCase();
    await mock.client.setFaults({ seed: 39, rules: [{ id: 'park-create', match: { method: 'POST', resourceType: 'MedicationRequest' }, firstN: 1, kind: 'hold' }] });
    try {
      const visit = worldVisitStarted();
      const location = await send(visit);
      await send(worldPrescriptionWritten(visit.visitId));
      const [hold] = await mock.client.holds(10_000);
      const active = await until(location, (v) => v.status === 'active');

      const both = await reconcile([atRest.caseId, active.caseId]);
      expect(both.counts).toEqual({ cases: 1, clean: 1, divergent: 0, skipped: 0, unchecked: 0 });

      const runId = await requestRun(hub.baseUrl, { caseIds: [atRest.caseId], since: new Date(Date.now() + 3_600_000).toISOString() });
      expect((await awaitRun(runId)).counts.cases).toBe(0);
      await mock.client.releaseHold(hold?.id ?? '');
    } finally {
      await mock.client.setFaults({ seed: 39, rules: [] });
    }
  });
});
