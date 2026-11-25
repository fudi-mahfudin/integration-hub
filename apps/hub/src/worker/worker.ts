import type { WorkerConfig } from '../config.js';
import type { AttemptRecord, ClaimedStep, Outbox } from '../outbox/outbox.js';
import { PlatformError } from '../satusehat/fhir-client.js';
import { createVisit } from '../steps/create-visit.js';
import { submitDispense } from '../steps/submit-dispense.js';
import { submitPrescription } from '../steps/submit-prescription.js';
import type { StepDeps, StepRunner } from '../steps/step-runner.js';
import type { Clock } from '../tokens.js';

/** Step name → its runner. Update visit registers here when it lands (#31). */
const RUNNERS: Record<string, StepRunner> = {
  create_visit: createVisit,
  submit_prescription: submitPrescription,
  submit_dispense: submitDispense,
};

export interface Worker {
  start(): void;
  /** Stops claiming and waits for attempts in progress. The 70s drain is #43's. */
  stop(): Promise<void>;
}

/**
 * The worker loop: `concurrency` slots, each claims one step, runs its
 * attempt and records the outcome through the lease fence; sleeps
 * `pollIntervalMs` when nothing is claimable.
 */
export function createWorkerLoop(opts: { config: WorkerConfig; outbox: Outbox; deps: StepDeps; clock: Clock }): Worker {
  const { config, outbox, deps, clock } = opts;
  let running = false;
  let slots: Promise<void>[] = [];
  let wake: (() => void)[] = [];

  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, config.pollIntervalMs);
      function done() {
        clearTimeout(timer);
        wake = wake.filter((w) => w !== done);
        resolve();
      }
      wake.push(done);
    });

  const attempt = async (step: ClaimedStep): Promise<void> => {
    const runner = RUNNERS[step.name];
    const used: Record<string, unknown> = {};
    let httpStatus: number | null = null;
    const observe = (status: number) => {
      httpStatus = status;
    };
    const fhir = deps.fhir.observe(observe);
    const kfa = deps.kfa.observe(observe);
    const record = (fields: Partial<AttemptRecord>): AttemptRecord => ({
      errorCode: null,
      httpStatus,
      used,
      violations: [],
      detail: null,
      ...fields,
    });
    try {
      if (!runner) throw new Error(`no runner for step ${step.name} yet`);
      const result = await runner(step, { ...deps, fhir, kfa }, { used });
      // A false return means the lease was lost: a newer claim owns the
      // step, and this result (and its attempt log row) is discarded (#8).
      if (result.outcome === 'completed') await outbox.complete(step, result.remote, result.pins, record({}));
      else await outbox.deadLetter(step, result.reason, record({ errorCode: result.reason, violations: result.violations ?? [] }));
    } catch (err) {
      // Every unclassified failure is transient for now; #35 classifies and backs off.
      const message = (err as Error).message;
      console.warn(`step ${step.name} attempt ${step.attempt} failed: ${message}`);
      const status = err instanceof PlatformError ? err.status : httpStatus;
      await outbox.retryAt(step, new Date(clock().getTime() + config.retryDelayMs), record({ httpStatus: status, detail: message }));
    }
  };

  const slot = async (): Promise<void> => {
    while (running) {
      try {
        const step = await outbox.claim();
        if (step) await attempt(step);
        else await idle();
      } catch (err) {
        // Claim or outcome write failed (database trouble); the lease covers the step.
        console.error('worker slot error', err);
        if (running) await idle();
      }
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      slots = Array.from({ length: config.concurrency }, () => slot());
    },
    async stop() {
      running = false;
      for (const w of [...wake]) w();
      await Promise.all(slots);
    },
  };
}
