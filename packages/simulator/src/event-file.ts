// A planned batch as an event file: every request of the batch, originals and
// duplicates, in the order a load generator replays them at a fixed rate.
import type { IdempotencyKey, Plan } from './plan.js';

/** One request of an event file: the key and exact body to send with it. */
export interface EventFileLine {
  idempotencyKey: IdempotencyKey;
  /** The exact bytes to send; a duplicate's are its original's. */
  body: string;
  /** Whether this is a duplicate ingest of an earlier line. */
  duplicate: boolean;
}

/**
 * Every request of the batch in send order, for replay without feedback from
 * the hub. Originals keep their planned times. A duplicate goes where its
 * timing puts it: concurrent right after its original, delayed its
 * `afterAcceptMs` after it, and late (sent after the case completed, which a
 * replay can't observe) the delayed window's maximum after the visit's last
 * original. Pure: the same plan gives the same file.
 */
export function eventFile(plan: Plan): EventFileLine[] {
  const lastOfVisit = new Map<string, number>();
  for (const send of plan.sends) lastOfVisit.set(send.visitId, Math.max(lastOfVisit.get(send.visitId) ?? 0, send.atMs));
  const lateAfterMs = plan.options.duplicates.delayedWindowMs.max;

  const timed: { atMs: number; line: EventFileLine }[] = [];
  for (const send of plan.sends) {
    timed.push({ atMs: send.atMs, line: { idempotencyKey: send.idempotencyKey, body: send.body, duplicate: false } });
    const timing = send.duplicate;
    if (timing === null) continue;
    const atMs =
      timing.kind === 'concurrent'
        ? send.atMs
        : timing.kind === 'delayed'
          ? send.atMs + timing.afterAcceptMs
          : (lastOfVisit.get(send.visitId) ?? send.atMs) + lateAfterMs;
    timed.push({ atMs, line: { idempotencyKey: send.idempotencyKey, body: send.body, duplicate: true } });
  }
  // Stable: an original stays before a duplicate planned for the same instant.
  return timed.toSorted((a, b) => a.atMs - b.atMs).map((t) => t.line);
}
