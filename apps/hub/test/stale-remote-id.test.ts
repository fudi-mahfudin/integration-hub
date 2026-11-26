import type { LogEntry } from '@integration-hub/mock-satusehat/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitEvents, type BootedMock } from './support/satusehat.js';
import { spawnWorker, type SpawnedWorker } from './support/spawn-worker.js';

const settled = (v: CaseView) => ['completed', 'dead_lettered'].includes(v.status);

describe('update visit on a stale stored Encounter id: re-search by the visit identifier (#10)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: SpawnedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    // A process of its own, so the test can read what it logs.
    worker = await spawnWorker(env);
  });
  afterAll(async () => {
    await worker?.stop();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });

  /** Delivers a visit up to its dispense; resolves to its case location, its visit.finished and its stored Encounter as created. */
  async function dispensedVisit() {
    const { visit, events } = worldVisitEvents();
    let location: string | null = null;
    for (const event of events.slice(0, -1)) location = (await send(event)).headers.get('location');
    const view = await waitForCase(hub.baseUrl, location, (v) => v.steps[2]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY });
    const [created] = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.effect === 'created');
    const storedId = view.steps[0]?.remote?.id ?? '';
    return { visit, location, finished: events.at(-1), storedId, createdBody: bodyOf(created) };
  }

  /** Stores a copy of `body` at the mock under a new id, as another client of the platform might; resolves to that id. */
  async function copyAtMock(body: Record<string, unknown>): Promise<string> {
    const { id: _id, meta: _meta, ...rest } = body;
    return (await mock.client.insertRecord(rest)).id;
  }

  it('one other Encounter under the identifier: the stored id is refreshed, the old one logged, and the next attempt PUTs the one found', async () => {
    const { visit, location, finished, storedId, createdBody } = await dispensedVisit();
    await mock.client.deleteRecord('Encounter', storedId);
    const replacementId = await copyAtMock(createdBody);

    await send(finished);
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.status).toBe('completed');
    expect(view.steps[0]?.remote).toMatchObject({ type: 'Encounter', id: replacementId });
    expect(view.steps[3]?.remote).toMatchObject({ type: 'Encounter', id: replacementId });
    expect(view.steps[3]?.attemptLog.map((a) => [a.attempt, a.outcome, a.errorCode])).toEqual([
      [1, 'failed', null],
      [2, 'completed', null],
    ]);
    const puts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'PUT');
    expect(puts.map((e) => [e.path, e.response.status])).toEqual([[`/fhir-r4/v1/Encounter/${replacementId}`, 200]]);
    expect(worker.logged().find((l) => l.caseId === view.caseId && l.staleId !== undefined)).toMatchObject({
      level: 'warn',
      step: 'update_visit',
      staleId: storedId,
      refreshedId: replacementId,
    });
    expectAtMostOneStepInMotion(view);
  });

  it('a PUT answered 404: the re-search finds the one Encounter, the id is refreshed, and the next attempt completes', async () => {
    const { visit, location, finished, storedId, createdBody } = await dispensedVisit();
    await mock.client.setFaults({ seed: 35, rules: [{ id: 'park-put', match: { method: 'PUT', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    await send(finished);
    const [hold] = await mock.client.holds(10_000);
    // Between the search and the PUT, the stored Encounter is replaced.
    await mock.client.deleteRecord('Encounter', storedId);
    const replacementId = await copyAtMock(createdBody);
    await mock.client.releaseHold(hold?.id ?? '');

    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });
    await mock.client.setFaults({ seed: 35, rules: [] });

    expect(view.status).toBe('completed');
    expect(view.steps[3]?.remote).toMatchObject({ id: replacementId });
    expect(view.steps[3]?.attemptLog.map((a) => [a.attempt, a.outcome, a.httpStatus])).toEqual([
      // The failed attempt's last answer read was its re-search's.
      [1, 'failed', 200],
      [2, 'completed', 200],
    ]);
    // The PUT of a deleted record is logged under no visit, so PUTs are found by path.
    const puts = (await mock.client.logNdjson()).filter((e) => e.method === 'PUT' && [storedId, replacementId].some((id) => e.path.endsWith(`/${id}`)));
    expect(puts.map((e) => [e.path, e.response.status])).toEqual([
      [`/fhir-r4/v1/Encounter/${storedId}`, 404],
      [`/fhir-r4/v1/Encounter/${replacementId}`, 200],
    ]);
  });

  it('no Encounter under the identifier: REMOTE_RECORD_MISSING, permanent, and no PUT', async () => {
    const { visit, location, finished, storedId } = await dispensedVisit();
    await mock.client.deleteRecord('Encounter', storedId);

    await send(finished);
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.status).toBe('dead_lettered');
    expect(view.steps[3]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'REMOTE_RECORD_MISSING', attempts: 1 });
    expect(view.steps[0]?.remote?.id).toBe(storedId);
    const puts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'PUT');
    expect(puts).toEqual([]);
  });

  it('more than one Encounter under the identifier: REMOTE_RECORD_AMBIGUOUS, and no PUT', async () => {
    const { visit, location, finished, createdBody } = await dispensedVisit();
    await copyAtMock(createdBody);

    await send(finished);
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.steps[3]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'REMOTE_RECORD_AMBIGUOUS' });
    const puts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'PUT');
    expect(puts).toEqual([]);
  });
});

function bodyOf(entry: LogEntry | undefined): Record<string, unknown> {
  const body = entry?.response.body;
  if (typeof body !== 'object' || body === null) throw new Error(`expected a created Encounter in the mock log, got ${JSON.stringify(entry)}`);
  return { ...body };
}
