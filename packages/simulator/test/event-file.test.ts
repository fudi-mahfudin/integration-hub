import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { describe, expect, it } from 'vitest';
import { eventFile, planBatch, type BatchOptions } from '../src/index.js';

const world = await loadWorld(DEFAULT_WORLD_PATH);

/** The big run's mix at a small size: a quarter of the events get a duplicate, so a fifth of the requests are duplicates. */
const options: BatchOptions = {
  seed: 11,
  runId: 'EF1',
  visits: 50,
  eventsPerSecond: 160,
  outOfOrder: { share: 0.1, delayMs: 2000 },
  substitutionShare: 0.1,
  fallbackLookupShare: 0.1,
  duplicates: { perEvent: 0.25, concurrent: 0.5, delayed: 0.3, late: 0.2, delayedWindowMs: { min: 500, max: 10_000 } },
};

describe('eventFile: a planned batch as the requests a load generator replays in order', () => {
  it('holds every original once and every duplicate after its original, with the same key and byte-identical body', () => {
    const plan = planBatch(world, options);
    const lines = eventFile(plan);

    expect(lines).toHaveLength(250);
    expect(lines.filter((l) => l.duplicate)).toHaveLength(50);
    const originals = lines.filter((l) => !l.duplicate);
    expect(originals.map((l) => l.idempotencyKey).toSorted()).toEqual(plan.sends.map((s) => s.idempotencyKey).toSorted());
    lines.forEach((line, i) => {
      if (!line.duplicate) return;
      const original = lines.findIndex((l) => !l.duplicate && l.idempotencyKey === line.idempotencyKey);
      expect(original).toBeGreaterThanOrEqual(0);
      expect(original).toBeLessThan(i);
      expect(lines[original]?.body).toBe(line.body);
    });
  });

  it('sends a concurrent duplicate right after its original, and a late one after every original of its visit', () => {
    const plan = planBatch(world, options);
    const lines = eventFile(plan);
    const at = (key: string, duplicate: boolean) => lines.findIndex((l) => l.idempotencyKey === key && l.duplicate === duplicate);

    const concurrent = plan.sends.filter((s) => s.duplicate?.kind === 'concurrent');
    const late = plan.sends.filter((s) => s.duplicate?.kind === 'late');
    expect(concurrent.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
    for (const send of concurrent) expect(at(send.idempotencyKey, true)).toBe(at(send.idempotencyKey, false) + 1);
    for (const send of late) {
      const lastOfVisit = Math.max(...plan.sends.filter((s) => s.visitId === send.visitId).map((s) => at(s.idempotencyKey, false)));
      expect(at(send.idempotencyKey, true)).toBeGreaterThan(lastOfVisit);
    }
  });
});
