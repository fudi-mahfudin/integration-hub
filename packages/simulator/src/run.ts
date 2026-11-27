import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Plan, PlannedSend } from './plan.js';

/** The hub the simulator sends to, as its source system. */
export interface HubTarget {
  /** The hub service, e.g. `http://localhost:3000/`. */
  baseUrl: URL;
  /** The source system's API key. */
  apiKey: string;
}

/** How a batch is run to completion. */
export interface RunOptions {
  /** How often each unfinished case is read while waiting for completion. */
  pollIntervalMs: number;
  /** How long after the last original send the cases may take to complete. */
  completionTimeoutMs: number;
  /** Receives a line of progress now and then. */
  report: (line: string) => void;
}

/** A visit's case as last read. */
export interface BatchCase {
  visitId: string;
  caseId: string;
  status: string;
}

/** What running a batch showed. */
export interface BatchResult {
  /** Every check that failed: an unexpected answer, a send that failed, a case that did not complete. Empty when all held. */
  problems: string[];
  /** The case of each planned visit that has one, in plan order. */
  cases: BatchCase[];
}

/** An answer as the checks need it. */
interface Answer {
  status: number;
  replayed: boolean;
  body: string;
  location: string | null;
}

const caseStatus = z.object({ status: z.string() });

/**
 * Runs a planned batch against the hub, open loop: each original goes at its
 * planned time whatever the hub's pace. Checks every answer (an original gets
 * `202`, a duplicate `202` with `Idempotent-Replayed: true` and the original's
 * body), then reads each case until it completes, sending its late duplicates
 * once it has. Never throws for what the hub answers: it collects problems.
 */
export async function runBatch(plan: Plan, hub: HubTarget, options: RunOptions): Promise<BatchResult> {
  const started = performance.now();
  const problems: string[] = [];
  const caseIds = new Map<string, string>();
  const lateDuplicates = new Map<string, { send: PlannedSend; original: Answer }[]>();
  const inFlight: Promise<void>[] = [];
  let duplicatesSent = 0;

  const post = async (send: PlannedSend): Promise<Answer | undefined> => {
    try {
      const res = await fetch(new URL('v1/events', hub.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.apiKey}`, 'idempotency-key': send.idempotencyKey, 'content-type': 'application/json' },
        body: send.body,
      });
      return { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', body: await res.text(), location: res.headers.get('location') };
    } catch (err) {
      problems.push(`${describe(send)}: the send failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  const noteCase = (send: PlannedSend, answer: Answer) => {
    const caseId = answer.location?.split('/').at(-1);
    if (caseId) caseIds.set(send.visitId, caseId);
  };
  const checkDuplicate = async (send: PlannedSend, original: Answer) => {
    duplicatesSent++;
    const duplicate = await post(send);
    if (!duplicate) return;
    if (duplicate.status !== 202 || !duplicate.replayed || duplicate.body !== original.body) {
      problems.push(`${describe(send)}: a duplicate was answered ${summary(duplicate)}, not the original 202 replayed`);
    }
  };

  const sendOriginal = async (send: PlannedSend) => {
    if (send.duplicate?.kind === 'concurrent') {
      duplicatesSent++;
      const [first, second] = await Promise.all([post(send), post(send)]);
      if (!first || !second) return;
      const fresh = [first, second].filter((a) => !a.replayed);
      if (first.status !== 202 || second.status !== 202 || fresh.length !== 1 || first.body !== second.body) {
        problems.push(`${describe(send)}: a concurrent pair was answered ${summary(first)} and ${summary(second)}, not one 202 and its replay`);
      }
      noteCase(send, first);
      return;
    }
    const original = await post(send);
    if (!original) return;
    if (original.status !== 202 || original.replayed) {
      problems.push(`${describe(send)}: the original was answered ${summary(original)}, not 202`);
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

  for (const send of plan.sends) {
    const wait = started + send.atMs - performance.now();
    if (wait > 0) await sleep(wait);
    inFlight.push(sendOriginal(send));
  }
  await Promise.all(inFlight);
  const sentFor = performance.now() - started;
  const late = [...lateDuplicates.values()].reduce((n, d) => n + d.length, 0);
  options.report(
    `sent ${plan.sends.length} events and ${duplicatesSent} duplicates for ${plan.visits.length} visits in ${(sentFor / 1000).toFixed(1)}s; ${late} late duplicates go once their cases complete`,
  );

  // Read every case until it completes or can't without an operator; a completed case gets its late duplicates.
  const statuses = new Map<string, string>();
  const deadline = performance.now() + options.completionTimeoutMs;
  let lastCompleted = -1;
  for (;;) {
    const open = plan.visits.filter((v) => caseIds.has(v.visitId) && !isFinal(statuses.get(v.visitId)));
    for (const { visitId } of open) {
      const status = await readStatus(hub, caseIds.get(visitId) ?? '');
      statuses.set(visitId, status);
      if (status === 'completed') {
        for (const { send, original } of lateDuplicates.get(visitId) ?? []) await checkDuplicate(send, original);
      }
    }
    const completed = [...statuses.values()].filter((s) => s === 'completed').length;
    if (completed !== lastCompleted) options.report(`${completed} of ${plan.visits.length} cases completed`);
    lastCompleted = completed;
    if (open.length === 0 || performance.now() > deadline) break;
    await sleep(options.pollIntervalMs);
  }

  const cases: BatchCase[] = [];
  for (const { visitId } of plan.visits) {
    const caseId = caseIds.get(visitId);
    if (caseId === undefined) {
      problems.push(`${visitId}: no case was opened`);
      continue;
    }
    const status = statuses.get(visitId) ?? 'unread';
    cases.push({ visitId, caseId, status });
    if (status !== 'completed') problems.push(`${visitId}: case ${caseId} is ${status}, not completed`);
  }
  return { problems, cases };
}

/** A case that will not complete without an operator, or already has. */
function isFinal(status: string | undefined): boolean {
  return status === 'completed' || status === 'dead_lettered' || status === 'abandoned';
}

async function readStatus(hub: HubTarget, caseId: string): Promise<string> {
  try {
    const res = await fetch(new URL(`v1/cases/${encodeURIComponent(caseId)}`, hub.baseUrl), { headers: { authorization: `Bearer ${hub.apiKey}` } });
    const parsed = caseStatus.safeParse(await res.json());
    return res.status === 200 && parsed.success ? parsed.data.status : `unreadable (HTTP ${res.status})`;
  } catch (err) {
    // A failed read is retried on the next poll; until then the case counts as not completed.
    return `unreadable (${err instanceof Error ? err.message : String(err)})`;
  }
}

const describe = (send: PlannedSend) => `${send.visitId} ${send.eventType}`;
const summary = (answer: Answer) => `${answer.status}${answer.replayed ? ' (replayed)' : ''}`;
