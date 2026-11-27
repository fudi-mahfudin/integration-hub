import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { DuplicateTiming, EventType, IdempotencyKey, Plan, PlannedSend, VisitId } from './plan.js';

/** The hub the simulator sends to, as its source system. */
export interface HubTarget {
  /** The hub service, e.g. `http://localhost:3000/`. */
  baseUrl: URL;
  /** The source system's API key. */
  apiKey: string;
}

/** How a batch is run to completion, and when waiting for it gives up. */
export interface RunOptions {
  /** How often the batch's cases are read while waiting for them. */
  pollIntervalMs: number;
  /** Give up once no step of the batch has completed for this long (fail-fast). */
  noProgressTimeoutMs: number;
  /** Give up once this long has passed since the first send (the hard deadline). */
  deadlineMs: number;
  /** Receives a line of progress now and then. */
  report: (line: string) => void;
}

/** The hub's id of a case, from the `Location` of a `202`. */
export type CaseId = string & { readonly __brand: 'CaseId' };

/** A visit's case as last read. */
export interface BatchCase {
  visitId: VisitId;
  caseId: CaseId;
  /** Its status (`completed`, `dead_lettered`, …), or `unread` when no read has shown it. */
  status: string;
  /** Its earliest step not completed, or null once completed (or unread). */
  currentStep: string | null;
}

/** One answer the hub gave the simulator, and when. */
export interface SendAnswer {
  visitId: VisitId;
  eventType: EventType;
  idempotencyKey: IdempotencyKey;
  /** `original`: the send that recorded the event; `duplicate`: its duplicate ingest. Of a concurrent pair, the one answered fresh is the original. */
  role: 'original' | 'duplicate';
  /** How the event's duplicate is timed, or null for an event without one. */
  timing: DuplicateTiming['kind'] | null;
  /** When the request went, in ms after the batch's first send. */
  sentAfterMs: number;
  /** How long the answer took, request to whole body. */
  latencyMs: number;
  /** The HTTP status, or null when the request failed without one. */
  status: number | null;
  replayed: boolean;
}

/**
 * How waiting for the batch ended: `completed` (every case completed and
 * every send answered), `settled` (every case completed, dead-lettered or
 * abandoned, so nothing more happens without an operator), `no_progress`
 * (no step completed for the no-progress timeout) or `deadline`.
 */
export type BatchEnding = 'completed' | 'settled' | 'no_progress' | 'deadline';

/** What running a batch showed. */
export interface BatchResult {
  /** Every check that failed: an unexpected answer, a send that failed, a case that did not complete. Empty when all held. */
  problems: string[];
  /** The case of each planned visit that has one, in plan order. */
  cases: BatchCase[];
  /** Every answer, in the order they arrived. */
  answers: SendAnswer[];
  ending: BatchEnding;
  /** Wall-clock time of the first send. */
  startedAt: Date;
  /** When every send but the late duplicates had been answered, in ms after the first send. */
  sendsEndedAfterMs: number;
  /** When waiting ended, in ms after the first send. */
  endedAfterMs: number;
}

/** An answer as the checks need it. */
interface Answer {
  status: number;
  replayed: boolean;
  body: string;
  location: string | null;
}

const casePage = z.object({
  cases: z.array(z.object({ caseId: z.string(), visitId: z.string(), status: z.string(), currentStep: z.string().nullable() })),
  nextCursor: z.string().nullable(),
});

/** A case's summary as one read of the case list shows it. */
type CaseRow = z.infer<typeof casePage>['cases'][number];

/**
 * Runs a planned batch against the hub, open loop: each original goes at its
 * planned time whatever the hub's pace. Checks every answer (an original gets
 * `202`, a duplicate `202` with `Idempotent-Replayed: true` and the original's
 * body), then reads the case list every poll until every case completes,
 * sending each case's late duplicates once it has. Gives up when no step
 * completes for `noProgressTimeoutMs`, or at `deadlineMs` after the first
 * send. Never throws for what the hub answers: it collects problems.
 */
export async function runBatch(plan: Plan, hub: HubTarget, options: RunOptions): Promise<BatchResult> {
  const startedAt = new Date();
  const started = performance.now();
  const sinceStart = () => performance.now() - started;
  const problems: string[] = [];
  const answers: SendAnswer[] = [];
  const caseIds = new Map<VisitId, CaseId>();
  const lateDuplicates = new Map<VisitId, { send: PlannedSend; original: Answer }[]>();
  const inFlight: Promise<void>[] = [];
  let duplicatesSent = 0;

  const post = async (send: PlannedSend, role: SendAnswer['role'] | 'concurrent'): Promise<Answer | undefined> => {
    const sentAfterMs = sinceStart();
    const record = (status: number | null, replayed: boolean) =>
      answers.push({
        visitId: send.visitId,
        eventType: send.eventType,
        idempotencyKey: send.idempotencyKey,
        // A concurrent pair's roles follow from which of the two was answered fresh.
        role: role === 'concurrent' ? (replayed ? 'duplicate' : 'original') : role,
        timing: send.duplicate?.kind ?? null,
        sentAfterMs,
        latencyMs: sinceStart() - sentAfterMs,
        status,
        replayed,
      });
    try {
      const res = await fetch(new URL('v1/events', hub.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.apiKey}`, 'idempotency-key': send.idempotencyKey, 'content-type': 'application/json' },
        body: send.body,
      });
      const answer = { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', body: await res.text(), location: res.headers.get('location') };
      record(answer.status, answer.replayed);
      return answer;
    } catch (err) {
      record(null, false);
      problems.push(`${named(send)}: the send failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  const noteCase = (send: PlannedSend, answer: Answer) => {
    const caseId = answer.location?.split('/').at(-1);
    // The last segment of `Location: /v1/cases/{caseId}`.
    if (caseId) caseIds.set(send.visitId, caseId as CaseId);
  };
  const checkDuplicate = async (send: PlannedSend, original: Answer) => {
    duplicatesSent++;
    const duplicate = await post(send, 'duplicate');
    if (!duplicate) return;
    if (duplicate.status !== 202 || !duplicate.replayed || duplicate.body !== original.body) {
      problems.push(`${named(send)}: a duplicate was answered ${summary(duplicate)}, not the original 202 replayed`);
    }
  };

  const sendOriginal = async (send: PlannedSend) => {
    if (send.duplicate?.kind === 'concurrent') {
      duplicatesSent++;
      const [first, second] = await Promise.all([post(send, 'concurrent'), post(send, 'concurrent')]);
      const accepted = [first, second].find((a) => a?.status === 202);
      if (accepted) noteCase(send, accepted);
      if (!first || !second) return;
      const fresh = [first, second].filter((a) => !a.replayed);
      if (first.status !== 202 || second.status !== 202 || fresh.length !== 1 || first.body !== second.body) {
        problems.push(`${named(send)}: a concurrent pair was answered ${summary(first)} and ${summary(second)}, not one 202 and its replay`);
      }
      return;
    }
    const original = await post(send, 'original');
    if (!original) return;
    if (original.status !== 202 || original.replayed) {
      problems.push(`${named(send)}: the original was answered ${summary(original)}, not 202`);
      return;
    }
    noteCase(send, original);
    if (send.duplicate?.kind === 'delayed') {
      await sleep(send.duplicate.afterAcceptMs);
      await checkDuplicate(send, original);
    } else if (send.duplicate?.kind === 'late') {
      lateDuplicates.set(send.visitId, [...(lateDuplicates.get(send.visitId) ?? []), { send, original }]);
    }
  };

  // The planned sends, open loop; delayed duplicates go on in the background while the cases are read.
  for (const send of plan.sends) {
    const wait = started + send.atMs - performance.now();
    if (wait > 0) await sleep(wait);
    inFlight.push(sendOriginal(send));
  }
  const allSent = Promise.all(inFlight);
  let sendsEndedAfterMs = sinceStart();
  let sendsDone = false;
  void allSent.then(() => {
    sendsDone = true;
    sendsEndedAfterMs = sinceStart();
    const late = [...lateDuplicates.values()].reduce((n, d) => n + d.length, 0);
    options.report(
      `sent ${plan.sends.length} events and ${duplicatesSent} duplicates for ${plan.visits.length} visits in ${(sendsEndedAfterMs / 1000).toFixed(1)}s; ${late} late duplicates go once their cases complete`,
    );
  });

  // Read the case list until every case completes or can't without an operator; a completed case gets its late duplicates.
  const rows = new Map<VisitId, CaseRow>();
  const lateInFlight: Promise<void>[] = [];
  let ending: BatchEnding;
  let lastSteps = -1;
  let lastProgressAt = sinceStart();
  let lastCompleted = -1;
  for (;;) {
    const read = await readCases(hub, new Set(caseIds.values()));
    for (const [visitId, caseId] of caseIds) {
      const row = read.get(caseId);
      if (!row) continue;
      if (row.status === 'completed' && rows.get(visitId)?.status !== 'completed') {
        for (const { send, original } of lateDuplicates.get(visitId) ?? []) lateInFlight.push(checkDuplicate(send, original));
        lateDuplicates.delete(visitId);
      }
      rows.set(visitId, row);
    }
    const all = [...rows.values()];
    const steps = all.reduce((n, row) => n + completedSteps(row), 0);
    const completed = all.filter((row) => row.status === 'completed').length;
    if (steps !== lastSteps) {
      lastSteps = steps;
      lastProgressAt = sinceStart();
    }
    if (completed !== lastCompleted) options.report(`${completed} of ${plan.visits.length} cases completed`);
    lastCompleted = completed;

    const everyCaseRead = sendsDone && plan.visits.every(({ visitId }) => !caseIds.has(visitId) || rows.has(visitId));
    if (everyCaseRead && completed === caseIds.size && lateDuplicates.size === 0) {
      await Promise.all(lateInFlight);
      ending = 'completed';
      break;
    }
    if (everyCaseRead && all.every((row) => isSettled(row.status)) && lateDuplicates.size === 0) {
      await Promise.all(lateInFlight);
      ending = 'settled';
      break;
    }
    if (sinceStart() - lastProgressAt >= options.noProgressTimeoutMs) {
      ending = 'no_progress';
      break;
    }
    if (sinceStart() >= options.deadlineMs) {
      ending = 'deadline';
      break;
    }
    await sleep(Math.min(options.pollIntervalMs, Math.max(0, options.deadlineMs - sinceStart())));
  }
  const endedAfterMs = sinceStart();
  if (ending === 'no_progress') problems.push(`no step completed for ${options.noProgressTimeoutMs}ms; gave up after ${(endedAfterMs / 1000).toFixed(1)}s`);
  if (ending === 'deadline') problems.push(`the hard deadline of ${options.deadlineMs}ms after the first send passed`);
  if (!sendsDone) problems.push('some sends had not been answered when waiting ended');

  const cases: BatchCase[] = [];
  for (const { visitId } of plan.visits) {
    const caseId = caseIds.get(visitId);
    if (caseId === undefined) {
      problems.push(`${visitId}: no case was opened`);
      continue;
    }
    const row = rows.get(visitId);
    const status = row?.status ?? 'unread';
    cases.push({ visitId, caseId, status, currentStep: row?.currentStep ?? null });
    if (status !== 'completed') {
      const unsent = lateDuplicates.get(visitId)?.length ?? 0;
      const at = row?.currentStep ? ` at ${row.currentStep}` : '';
      problems.push(`${visitId}: case ${caseId} is ${status}${at}, not completed${unsent > 0 ? `, so its ${unsent} late duplicates were not sent` : ''}`);
    }
  }
  return { problems, cases, answers, ending, startedAt, sendsEndedAfterMs, endedAfterMs };
}

/** The four steps in order; a case's completed steps are those before its current step. */
const STEPS = ['create_visit', 'submit_prescription', 'submit_dispense', 'update_visit'] as const;

/** How many of a case's steps have completed: steps complete in order, so all of those before its current step. */
function completedSteps(row: CaseRow): number {
  if (row.status === 'completed') return STEPS.length;
  const index = STEPS.findIndex((step) => step === row.currentStep);
  return index === -1 ? 0 : index;
}

/**
 * Whether reading a case again can show nothing new without an operator: it
 * completed, was abandoned, or was dead-lettered (and waits for a replay).
 */
function isSettled(status: string): boolean {
  return status === 'completed' || status === 'dead_lettered' || status === 'abandoned';
}

/** Rows per page of the case list; its maximum. */
const PAGE_SIZE = 500;

/**
 * Reads the case list, newest first, until it has shown every wanted case or
 * ends. While no other batch opens cases at the same time, the batch's cases
 * are the newest, so a few pages cover them however many older cases the hub
 * holds; otherwise it pages further. A failed read shows what it got so far; the
 * cases it missed are read again on the next poll.
 */
async function readCases(hub: HubTarget, wanted: ReadonlySet<CaseId>): Promise<Map<CaseId, CaseRow>> {
  const found = new Map<CaseId, CaseRow>();
  let cursor: string | null = null;
  while (found.size < wanted.size) {
    const url = new URL('v1/cases', hub.baseUrl);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    let page: z.infer<typeof casePage>;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${hub.apiKey}` } });
      const parsed = casePage.safeParse(await res.json());
      if (res.status !== 200 || !parsed.success) return found;
      page = parsed.data;
    } catch {
      // Carrying on is safe: an unread case counts as not completed, and the next poll reads it again.
      return found;
    }
    // A case id from the hub's own case list.
    for (const row of page.cases) if (wanted.has(row.caseId as CaseId)) found.set(row.caseId as CaseId, row);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return found;
}

const named = (send: PlannedSend) => `${send.visitId} ${send.eventType}`;
const summary = (answer: Answer) => `${answer.status}${answer.replayed ? ' (replayed)' : ''}`;
