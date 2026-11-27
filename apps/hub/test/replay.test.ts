import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, caseViewSchema, postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  bootMock,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisitFinished,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

/** A hub and worker delivering to a fresh mock and database, with `env` on top of the world's. */
function deliveringHub(env: Record<string, string> = {}) {
  const booted: { mock?: BootedMock; database?: FreshDatabase; hub?: BootedHub; worker?: BootedWorker } = {};
  beforeAll(async () => {
    booted.mock = await bootMock();
    booted.database = await createFreshDatabase();
    const fullEnv = { ...worldEnv(booted.mock.baseUrl, booted.database.url), ...env };
    booted.hub = await bootHub(fullEnv);
    booted.worker = await bootWorker(fullEnv);
  });
  afterAll(async () => {
    await booted.worker?.close();
    await booted.hub?.close();
    await booted.database?.drop();
    await booted.mock?.close();
  });
  const hub = () => {
    if (!booted.hub || !booted.mock) throw new Error('the hub is not booted');
    return { baseUrl: booted.hub.baseUrl, mock: booted.mock };
  };
  const send = async (body: unknown) => {
    const res = await postEvent(hub().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    expect(res.status).toBe(202);
    return res.headers.get('location')?.split('/').at(-1) ?? '';
  };
  const until = (caseId: string, done: (v: CaseView) => boolean) =>
    waitForCase(hub().baseUrl, `/v1/cases/${caseId}`, done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
  const replay = (caseId: string, body?: unknown) => adminRequest(hub().baseUrl, 'POST', `v1/cases/${caseId}/replay`, { body });
  return { hub, send, until, replay };
}

/** A case whose current step is dead-lettered after `attempts` attempts, or that has completed. */
const deadLetteredAfter = (attempts: number) => (v: CaseView) =>
  v.status === 'dead_lettered' && v.steps.some((s) => s.state === 'dead_lettered' && s.attempts === attempts);
const completed = (v: CaseView) => v.status === 'completed';

describe('replay: an operator resumes a dead-lettered case from its failed step (#37)', () => {
  const { hub, send, until, replay } = deliveringHub();

  it('MAPPING_MISSING → PUT the mapping → replay → the case completes, keeping its history', async () => {
    const drugCode = `UNMAPPED-${crypto.randomUUID()}`;
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId, { item: { drugCode } });
    const caseId = await send(visit);
    await send(prescription);
    await send(worldDrugDispensed(prescription, { drugCode: 'PCT500-FFA' }));
    await send(worldVisitFinished(visit));

    const dead = await until(caseId, deadLetteredAfter(1));
    expect(dead).toMatchObject({ deadLetterReason: 'MAPPING_MISSING', reasonClass: 'replayable', deadLetteredSince: expect.stringMatching(/Z$/) });
    expect(dead.steps.map((s) => s.state)).toEqual(['completed', 'dead_lettered', 'blocked', 'blocked']);

    const mapped = await adminRequest(hub().baseUrl, 'PUT', `v1/admin/mappings/drugs/${drugCode}`, {
      body: { source: 'simulator', kfaCode: '92000001', note: 'mapped while fixing a dead letter' },
    });
    expect(mapped.status).toBe(200);
    const replayed = await replay(caseId, { note: 'drug mapping added' });
    expect(replayed.status).toBe(200);
    expect(caseViewSchema.parse(await replayed.json())).toMatchObject({
      status: 'active',
      deadLetterReason: null,
      reasonClass: null,
      deadLetteredSince: null,
      replays: [{ step: 'submit_prescription', reason: 'MAPPING_MISSING', note: 'drug mapping added', replayedAt: expect.any(String) }],
    });

    const done = await until(caseId, completed);
    expect(done.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    // The completed step and its remote id are untouched; the failed step's attempts keep their numbers.
    expect(done.steps[0]).toMatchObject({ attempts: 1, remote: dead.steps[0]?.remote });
    expect(done.steps[1]?.attemptLog).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'dead_lettered', errorCode: 'MAPPING_MISSING' }),
      expect.objectContaining({ attempt: 2, outcome: 'completed', errorCode: null }),
    ]);
    expect(done).toMatchObject({ replayCount: 1 });
    expect(done.replays).toHaveLength(1);
    const effects = (await hub().mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
    expect(await hub().mock.client.report()).toMatchObject({ duplicates: [], outOfOrder: [] });
    expectAtMostOneStepInMotion(done);
  });

  it('answers 409 CASE_NOT_DEAD_LETTERED for a case that is not dead-lettered', async () => {
    const visit = worldVisitStarted();
    const caseId = await send(visit);
    await until(caseId, (v) => v.status === 'waiting');

    const res = await replay(caseId);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CASE_NOT_DEAD_LETTERED' });
  });

  it('re-fetches the KFA details of the failed step’s code on replay, and the step dead-letters again with its reason', async () => {
    // PCT-ZAT-AKTIF maps to the ingredient 91000001: KFA_LEVEL_INVALID. No other test here prescribes it.
    const visit = worldVisitStarted();
    const caseId = await send(visit);
    await send(worldPrescriptionWritten(visit.visitId, { item: { drugCode: 'PCT-ZAT-AKTIF' } }));
    await until(caseId, deadLetteredAfter(1));
    const lookups = async () => (await hub().mock.client.log({ resourceType: 'KfaProduct' })).filter((e) => e.path.includes('code=91000001')).length;
    expect(await lookups()).toBe(1);

    expect((await replay(caseId)).status).toBe(200);

    const again = await until(caseId, deadLetteredAfter(2));
    expect(await lookups()).toBe(2);
    expect(again).toMatchObject({ deadLetterReason: 'KFA_LEVEL_INVALID', reasonClass: 'replayable', replays: [{ reason: 'KFA_LEVEL_INVALID', note: null }] });
    expect(again.steps[1]?.attemptLog.map((a) => [a.attempt, a.errorCode])).toEqual([
      [1, 'KFA_LEVEL_INVALID'],
      [2, 'KFA_LEVEL_INVALID'],
    ]);
  });

  it('replays a case dead-lettered by its source data too: the class suggests abandoning, never refuses the replay', async () => {
    const visit = worldVisitStarted();
    const prescription = worldPrescriptionWritten(visit.visitId);
    const caseId = await send(visit);
    await send(prescription);
    // PCT500-FFB derives from the prescribed 92000001: declaring it a substitution is SUBSTITUTION_MISMATCH.
    await send(worldDrugDispensed(prescription, { drugCode: 'PCT500-FFB', substitution: { reasonCode: 'OS' } }));
    const dead = await until(caseId, deadLetteredAfter(1));
    expect(dead).toMatchObject({ deadLetterReason: 'SUBSTITUTION_MISMATCH', reasonClass: 'source_data' });

    expect((await replay(caseId, { note: 'trying anyway' })).status).toBe(200);

    const again = await until(caseId, deadLetteredAfter(2));
    expect(again).toMatchObject({ deadLetterReason: 'SUBSTITUTION_MISMATCH', reasonClass: 'source_data', replays: [{ step: 'submit_dispense' }] });
  });

  it('of two concurrent replays of one case, exactly one replays it; the other is 409 CASE_NOT_DEAD_LETTERED', async () => {
    const visit = worldVisitStarted();
    const caseId = await send(visit);
    await send(worldPrescriptionWritten(visit.visitId, { item: { drugCode: `UNMAPPED-${crypto.randomUUID()}` } }));
    await until(caseId, deadLetteredAfter(1));

    const answers = await Promise.all([replay(caseId), replay(caseId)]);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const again = await until(caseId, deadLetteredAfter(2));
    expect(again.replays).toHaveLength(1);
  });

  it('abandons a dead-lettered case, recording its reason and the records completed steps left at SATUSEHAT, and sends nothing', async () => {
    const visit = worldVisitStarted();
    const caseId = await send(visit);
    await send(worldPrescriptionWritten(visit.visitId, { item: { drugCode: `UNMAPPED-${crypto.randomUUID()}` } }));
    const dead = await until(caseId, deadLetteredAfter(1));
    const logged = (await hub().mock.client.log({ visitKey: visit.visitId })).length;

    const res = await adminRequest(hub().baseUrl, 'POST', `v1/cases/${caseId}/abandon`, { body: { note: 'the drug was never stocked' } });

    expect(res.status).toBe(200);
    const view = caseViewSchema.parse(await res.json());
    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'abandoned', 'abandoned', 'abandoned']);
    expect(view).toMatchObject({ status: 'abandoned', deadLetterReason: null, deadLetteredSince: null });
    expect(view.abandonment).toMatchObject({
      note: 'the drug was never stocked',
      previousStatus: 'dead_lettered',
      waitingFor: null,
      deadLetterReason: 'MAPPING_MISSING',
      remoteRecordsLeft: [{ step: 'create_visit', ...dead.steps[0]?.remote }],
    });
    // Give a worker the time to send anything it would: it must not.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await hub().mock.client.log({ visitKey: visit.visitId })).length).toBe(logged);
    expect((await replay(caseId)).status).toBe(409);
  });
});

describe('replay resets the attempt cap but keeps the attempt numbering (#37)', () => {
  const { hub, send, until, replay } = deliveringHub({ RETRY_MAX_ATTEMPTS: '2', RETRY_BACKOFF_BASE_MS: '1', RETRY_BACKOFF_CAP_MS: '5' });

  it('a replayed RETRIES_EXHAUSTED step gets the full cap again, numbered on from its last attempt', async () => {
    await hub().mock.client.setFaults({ seed: 37, rules: [{ id: 'down', match: { method: 'POST', resourceType: 'Encounter' }, rate: 1, kind: 'http_500' }] });
    const caseId = await send(worldVisitStarted());
    const exhausted = await until(caseId, deadLetteredAfter(2));
    expect(exhausted).toMatchObject({ deadLetterReason: 'RETRIES_EXHAUSTED', reasonClass: 'replayable' });

    expect((await replay(caseId)).status).toBe(200);
    const again = await until(caseId, deadLetteredAfter(4));
    expect(again.steps[0]?.attemptLog.map((a) => [a.attempt, a.outcome, a.errorCode])).toEqual([
      [1, 'failed', null],
      [2, 'failed', 'RETRIES_EXHAUSTED'],
      [3, 'failed', null],
      [4, 'failed', 'RETRIES_EXHAUSTED'],
    ]);

    await hub().mock.client.setFaults({ seed: 37, rules: [] });
    expect((await replay(caseId, { note: 'platform is back' })).status).toBe(200);
    const recovered = await until(caseId, (v) => v.status === 'waiting');
    expect(recovered.steps[0]).toMatchObject({ state: 'completed', attempts: 5 });
    expect(recovered.replayCount).toBe(2);
    expect(recovered.replays.map((r) => r.reason)).toEqual(['RETRIES_EXHAUSTED', 'RETRIES_EXHAUSTED']);
  });
});
