import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { planBatch, type BatchOptions, type Plan } from '../src/index.js';

const world = await loadWorld(DEFAULT_WORLD_PATH);

/** A small batch with every share and timing in use. */
const options: BatchOptions = {
  seed: 7,
  runId: 'T1',
  visits: 40,
  eventsPerSecond: 50,
  outOfOrder: { share: 0.25, delayMs: 500 },
  substitutionShare: 0.25,
  fallbackLookupShare: 0.25,
  duplicates: { perEvent: 0.25, concurrent: 0.5, delayed: 0.3, late: 0.2, delayedWindowMs: { min: 500, max: 10_000 } },
};

const eventBody = z.object({ type: z.string(), visitId: z.string(), occurredAt: z.string(), data: z.record(z.string(), z.unknown()) });

/** The parsed body of a visit's event of `type`. */
function bodyOf(plan: Plan, visitId: string, type: string): { data: Record<string, unknown> } {
  const send = plan.sends.find((s) => s.visitId === visitId && s.eventType === type);
  expect(send).toBeDefined();
  const parsed = eventBody.parse(JSON.parse(send?.body ?? 'null'));
  expect(parsed).toMatchObject({ type, visitId });
  return parsed;
}

const product = (code: string) => {
  const found = world.kfaProducts.find((p) => p.code === code);
  if (!found) throw new Error(`KFA ${code} is not in the world`);
  return found;
};
const ingredients = (code: string) => product(code).ingredients.toSorted();

const EVENT_TYPES = ['visit.started', 'prescription.written', 'drug.dispensed', 'visit.finished'];

describe('planBatch: a seeded batch of fictional visits drawn from the world dataset', () => {
  it('gives the same plan for the same seed, and another for another seed', () => {
    expect(planBatch(world, options)).toEqual(planBatch(world, options));
    expect(planBatch(world, { ...options, seed: 8 }).sends.map((s) => s.body)).not.toEqual(planBatch(world, options).sends.map((s) => s.body));
  });

  it('plans the four events of every visit once, each with its own idempotency key, under the run id', () => {
    const plan = planBatch(world, options);
    expect(plan.visits).toHaveLength(40);
    expect(plan.sends).toHaveLength(160);
    for (const visit of plan.visits) {
      expect(visit.visitId).toMatch(/^V-T1-/);
      const types = plan.sends.filter((s) => s.visitId === visit.visitId).map((s) => s.eventType);
      expect(types.toSorted()).toEqual(EVENT_TYPES.toSorted());
    }
    expect(new Set(plan.sends.map((s) => s.idempotencyKey)).size).toBe(160);
  });

  it('dispenses the share of substitutions as another product with the same active ingredients, and the rest as prescribed', () => {
    const plan = planBatch(world, options);
    const substitutions = plan.visits.filter((v) => v.scenario === 'substitution');
    expect(substitutions).toHaveLength(10);
    for (const visit of plan.visits) {
      const dispensed = product(visit.dispensedKfaCode);
      expect(dispensed.level).toBe(93);
      const derived = dispensed.code === visit.prescribedKfaCode || (dispensed.level === 93 && dispensed.parent === visit.prescribedKfaCode);
      const dispense = bodyOf(plan, visit.visitId, 'drug.dispensed').data;
      if (visit.scenario === 'substitution') {
        expect(derived).toBe(false);
        expect(ingredients(visit.dispensedKfaCode)).toEqual(ingredients(visit.prescribedKfaCode));
        expect(dispense.substitution).toEqual({ reasonCode: expect.any(String) });
      } else {
        expect(derived).toBe(true);
        expect(dispense.substitution).toBeUndefined();
      }
    }
  });

  it('hands every dispense over with a batch: a lot and a plain expiry date', () => {
    const plan = planBatch(world, options);
    for (const visit of plan.visits) {
      expect(bodyOf(plan, visit.visitId, 'drug.dispensed').data.batch).toEqual({ lot: expect.stringMatching(/^\S+$/), expiry: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    }
  });

  it('identifies the share of fallback patients by a fallback that finds exactly that patient, and the rest by NIK', () => {
    const plan = planBatch(world, options);
    expect(plan.visits.filter((v) => v.lookup !== 'nik')).toHaveLength(10);
    expect(new Set(plan.visits.map((v) => v.lookup))).toEqual(new Set(['nik', 'mother_nik_birth_date', 'name_birth_date_gender']));
    for (const visit of plan.visits) {
      const patient = z
        .object({ nik: z.string().optional(), motherNik: z.string().optional(), name: z.string().optional(), birthDate: z.string().optional(), gender: z.string().optional() })
        .parse(bodyOf(plan, visit.visitId, 'visit.started').data.patient);
      // How the mock SATUSEHAT searches, and the hub narrows a mother's NIK search by birthDate.
      const matches = world.patients.filter((p) =>
        visit.lookup === 'nik'
          ? p.nik === patient.nik
          : visit.lookup === 'mother_nik_birth_date'
            ? p.motherNik === patient.motherNik && p.birthDate === patient.birthDate
            : p.name === patient.name && p.birthDate === patient.birthDate && p.gender === patient.gender,
      );
      expect(matches.map((p) => p.ihsNumber)).toEqual([visit.patientIhsNumber]);
      if (visit.lookup !== 'nik') expect(patient.nik).toBeUndefined();
    }
  });

  it('sends one event of each out-of-order visit before its predecessor, held back at least the delay, and every other visit in order', () => {
    const plan = planBatch(world, options);
    expect(plan.visits.filter((v) => v.outOfOrder)).toHaveLength(10);
    for (const visit of plan.visits) {
      const sent = plan.sends.filter((s) => s.visitId === visit.visitId);
      const order = sent.map((s) => EVENT_TYPES.indexOf(s.eventType));
      if (!visit.outOfOrder) {
        expect(order).toEqual([0, 1, 2, 3]);
        continue;
      }
      const swapped = order.findIndex((type, i) => type !== i);
      expect(swapped).toBeGreaterThanOrEqual(0);
      const expected = [0, 1, 2, 3];
      expected.splice(swapped, 2, swapped + 1, swapped);
      expect(order).toEqual(expected);
      const [successor, predecessor] = [sent[swapped], sent[swapped + 1]];
      expect((predecessor?.atMs ?? 0) - (successor?.atMs ?? Infinity)).toBeGreaterThanOrEqual(500);
    }
  });

  it('spaces the original sends at the arrival rate at most, in send order', () => {
    const plan = planBatch(world, options);
    plan.sends.forEach((send, i) => {
      expect(send.atMs).toBeGreaterThanOrEqual(i * 20);
      expect(send.atMs).toBeGreaterThanOrEqual(plan.sends[i - 1]?.atMs ?? 0);
    });
    // With nothing held back, it runs at the rate exactly.
    expect(planBatch(world, { ...options, outOfOrder: { share: 0, delayMs: 500 } }).sends.at(-1)?.atMs).toBe(159 * 20);
  });

  it('gives the share of events a duplicate ingest, split concurrent / delayed (within the window) / late', () => {
    const plan = planBatch(world, options);
    const timings = plan.sends.flatMap((s) => (s.duplicate ? [s.duplicate] : []));
    expect(timings).toHaveLength(40);
    expect(timings.filter((t) => t.kind === 'concurrent')).toHaveLength(20);
    expect(timings.filter((t) => t.kind === 'late')).toHaveLength(8);
    const delayed = timings.flatMap((t) => (t.kind === 'delayed' ? [t.afterAcceptMs] : []));
    expect(delayed).toHaveLength(12);
    for (const ms of delayed) {
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThanOrEqual(10_000);
    }
  });
});
