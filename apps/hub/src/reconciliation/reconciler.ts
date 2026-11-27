import { sql, type Kysely } from 'kysely';
import type { OrganizationId } from '../auth/source-systems.js';
import type { PrescriptionId, RemoteId, RemoteIdentifier, StepName, StepState, VisitId } from '../cases/case-model.js';
import { readCreateVisitPins, readSubmitDispensePins, readSubmitPrescriptionPins } from '../cases/pins.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { log } from '../observability/log.js';
import type { SatusehatClient } from '../satusehat/client.js';
import type { AttemptCalls } from '../satusehat/transport.js';
import { compareResource, type Divergence, type ExpectedRecord, type RecordAtSatusehat, type ReconciliationCheckOutcome } from './model.js';
import { requestRun } from './runs.js';

/**
 * The Postgres advisory lock every reconciliation run executes under (#39):
 * one run at a time across all worker processes. A session lock, so it goes
 * with its holder's connection when the holder dies.
 */
const RECONCILIATION_LOCK = 39_039;

/** A worker's reconciliation loop. */
export interface Reconciler {
  /** Starts looking for runs to execute (and, on a schedule, requesting them). */
  start(): void;
  /** Stops after the case being checked; a run cut short this way ends `failed`. Resolves once the loop has stopped. */
  stop(): Promise<void>;
}

/** One step of a case at rest, as reconciliation reads it. */
interface StepAtRest {
  name: StepName;
  state: StepState;
  remote: RemoteIdentifier | null;
  pins: unknown;
}

/** A case as reconciliation reads it, from one snapshot: what it expects at SATUSEHAT and its version. */
interface CaseAtRest {
  organizationId: OrganizationId;
  visitId: VisitId;
  status: string;
  /** The case's last change: a change during the check makes it `skipped`. */
  version: number;
  steps: Record<StepName, StepAtRest>;
  /** The prescription the case's events name, if any: the `prescription/{org}` identifier's value. */
  prescriptionId: PrescriptionId | null;
}

/**
 * Builds the reconciliation loop of a worker process (#39). Every
 * `pollIntervalMs` it tries the advisory lock; holding it, it marks any run
 * still `running` (whose worker lost the lock) `failed`, requests a scheduled
 * run when the last one started longer than `intervalMs` ago (`0`: never),
 * and executes the oldest queued run, one case at a time. Its SATUSEHAT calls
 * go through the worker's transport, so they share the process's rate
 * limiter and circuit breakers. It never changes a case.
 */
export function createReconciler(deps: {
  db: Kysely<Database>;
  clock: Clock;
  /** A SATUSEHAT client whose calls count against `calls`: one per case check. */
  satusehatFor: (calls: AttemptCalls) => SatusehatClient;
  /** How often a scheduled run is requested; 0 turns the schedule off. */
  intervalMs: number;
  /** The default scope: cases whose last change is within this long before the run starts. */
  lookbackMs: number;
  pollIntervalMs: number;
  /** How long one case's check may go on making calls, as an attempt may. */
  checkBudgetMs: number;
}): Reconciler {
  const { db, clock, satusehatFor, intervalMs, lookbackMs, pollIntervalMs, checkBudgetMs } = deps;
  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function endRun(runId: string, status: 'completed' | 'completed_with_errors' | 'failed', error: string | null): Promise<void> {
    await db.updateTable('reconciliation_runs').set({ status, ended_at: clock(), error }).where('id', '=', runId).execute();
  }

  /** Under the lock: fail orphaned runs, schedule one if due, then execute the oldest queued run. */
  async function underLock(): Promise<void> {
    const failed = await db
      .updateTable('reconciliation_runs')
      .set({ status: 'failed', ended_at: clock(), error: 'left running without the lock: the worker executing it stopped' })
      .where('status', '=', 'running')
      .returning('id')
      .execute();
    for (const { id } of failed) log('warn', 'a reconciliation run was left running without the lock; it is marked failed', { runId: id });

    if (intervalMs > 0) {
      const now = clock();
      const last = await db.selectFrom('reconciliation_runs').select((eb) => eb.fn.max('started_at').as('at')).executeTakeFirst();
      if (!last?.at || last.at.getTime() <= now.getTime() - intervalMs) await requestRun(db, 'schedule', { caseIds: null, since: null }, now);
    }

    const run = await db
      .updateTable('reconciliation_runs')
      .set({ status: 'running', started_at: clock() })
      .where('id', '=', (eb) => eb.selectFrom('reconciliation_runs').select('id').where('status', '=', 'queued').orderBy('requested_at').limit(1))
      .returning(['id', 'case_ids', 'since'])
      .executeTakeFirst();
    if (!run) return;
    log('info', 'reconciliation run started', { runId: run.id });
    try {
      await execute(run);
    } catch (err) {
      log('error', 'reconciliation run failed', { runId: run.id, error: err });
      await endRun(run.id, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  async function execute(run: { id: string; case_ids: string[] | null; since: Date | null }): Promise<void> {
    let scope = db
      .selectFrom('case')
      .select('id')
      .where('status', '<>', 'active')
      .where('updated_at', '>=', new Date(clock().getTime() - lookbackMs));
    // The API takes at least one case id; an empty list would be no narrowing, and Postgres refuses `in ()`.
    if (run.case_ids !== null && run.case_ids.length > 0) scope = scope.where('id', 'in', run.case_ids);
    if (run.since !== null) scope = scope.where('updated_at', '>=', run.since);
    const cases = await scope.orderBy('list_seq').execute();

    let unchecked = 0;
    for (const { id } of cases) {
      if (!running) {
        await endRun(run.id, 'failed', 'the worker stopped before the run ended');
        return;
      }
      if ((await checkCase(run.id, id)) === 'unchecked') unchecked++;
    }
    await endRun(run.id, unchecked > 0 ? 'completed_with_errors' : 'completed', null);
    log('info', 'reconciliation run ended', { runId: run.id, cases: cases.length, unchecked });
  }

  /** Checks one case and records how the check ended, with what it found. */
  async function checkCase(runId: string, caseId: string): Promise<ReconciliationCheckOutcome> {
    const atRest = await readCaseAtRest(db, caseId);
    // A case that is moving again since the run listed it is not at rest.
    if (atRest.status === 'active') return record(runId, caseId, 'skipped', [{ kind: 'skipped', snapshot: {} }]);

    const calls: AttemptCalls = { budgetEndsAt: new Date(clock().getTime() + checkBudgetMs), readRetries: [] };
    const satusehat = satusehatFor(calls);
    const visit = { organizationId: atRest.organizationId, visitId: atRest.visitId };
    let found: { encounters: RecordAtSatusehat[]; medicationRequests: RecordAtSatusehat[]; medicationDispenses: RecordAtSatusehat[] };
    try {
      const prescription = atRest.prescriptionId === null ? null : { organizationId: atRest.organizationId, prescriptionId: atRest.prescriptionId };
      found = {
        encounters: await satusehat.readEncounters(visit),
        medicationRequests: prescription ? await satusehat.readMedicationRequests(prescription) : [],
        medicationDispenses: prescription ? await satusehat.readMedicationDispenses(prescription) : [],
      };
    } catch (err) {
      // Reported, not retried: the run ends `completed_with_errors`, and the next run checks the case again.
      log('warn', 'a reconciliation check failed; the case is unchecked', { runId, caseId, error: err });
      const message = err instanceof Error ? err.message : String(err);
      return record(runId, caseId, 'unchecked', [{ kind: 'unchecked', snapshot: { error: message, readRetries: calls.readRetries } }]);
    }

    if ((await readVersion(db, caseId)) !== atRest.version) return record(runId, caseId, 'skipped', [{ kind: 'skipped', snapshot: {} }]);
    const divergences = compareCase(atRest, found);
    return record(
      runId,
      caseId,
      divergences.length > 0 ? 'divergent' : 'clean',
      divergences.map((d) => ({ kind: 'divergence', ...d })),
    );
  }

  async function record(
    runId: string,
    caseId: string,
    outcome: ReconciliationCheckOutcome,
    findings: ({ kind: 'skipped' | 'unchecked'; snapshot: Record<string, unknown> } | ({ kind: 'divergence' } & Divergence))[],
  ): Promise<ReconciliationCheckOutcome> {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('reconciliation_checks').values({ run_id: runId, case_id: caseId, outcome, checked_at: clock() }).execute();
      if (findings.length === 0) return;
      await trx
        .insertInto('reconciliation_findings')
        .values(
          findings.map((f) => ({
            run_id: runId,
            case_id: caseId,
            kind: f.kind,
            class: f.kind === 'divergence' ? f.class : null,
            step: f.kind === 'divergence' ? f.step : null,
            resource_type: f.kind === 'divergence' ? f.resourceType : null,
            field: f.kind === 'divergence' ? f.field : null,
            snapshot: JSON.stringify(f.snapshot),
          })),
        )
        .execute();
    });
    return outcome;
  }

  async function tick(): Promise<void> {
    await db.connection().execute(async (conn) => {
      const { rows } = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${RECONCILIATION_LOCK}) as locked`.execute(conn);
      if (!rows[0]?.locked) return;
      try {
        await underLock();
      } finally {
        await sql`select pg_advisory_unlock(${RECONCILIATION_LOCK})`.execute(conn);
      }
    });
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        await tick();
      } catch (err) {
        // The next poll tries again; a run cut short stays `running` until the next lock holder fails it.
        log('error', 'reconciliation loop failed', { error: err });
      }
      if (running) await idle();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
  };
}

/** A case's version: its last change, in milliseconds. */
async function readVersion(db: Kysely<Database>, caseId: string): Promise<number> {
  const { updated_at } = await db.selectFrom('case').select('updated_at').where('id', '=', caseId).executeTakeFirstOrThrow();
  return updated_at.getTime();
}

/** Reads a case and its steps from one snapshot. */
function readCaseAtRest(db: Kysely<Database>, caseId: string): Promise<CaseAtRest> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const kase = await trx
        .selectFrom('case')
        .select(['organization_id', 'visit_id', 'status', 'updated_at'])
        .where('id', '=', caseId)
        .executeTakeFirstOrThrow();
      const rows = await trx
        .selectFrom('step')
        .select(['name', 'state', 'remote_type', 'remote_id', 'remote_version', 'pins'])
        .where('case_id', '=', caseId)
        .execute();
      const prescription = await trx
        .selectFrom('source_event')
        .select('prescription_id')
        .where('case_id', '=', caseId)
        .where('prescription_id', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      const stepOf = (name: StepName): StepAtRest => {
        const row = rows.find((r) => r.name === name);
        if (!row) throw new Error(`case ${caseId} has no step ${name}`);
        return {
          name,
          state: row.state,
          remote:
            row.remote_type !== null && row.remote_id !== null
              ? // Stored only by lease-fenced completion, from a RemoteIdentifier.
                { type: row.remote_type, id: row.remote_id as RemoteId, version: row.remote_version }
              : null,
          pins: row.pins,
        };
      };
      return {
        // Stored at ingest from the source registration and the validated event.
        organizationId: kase.organization_id as OrganizationId,
        visitId: kase.visit_id as VisitId,
        status: kase.status,
        version: kase.updated_at.getTime(),
        steps: {
          create_visit: stepOf('create_visit'),
          submit_prescription: stepOf('submit_prescription'),
          submit_dispense: stepOf('submit_dispense'),
          update_visit: stepOf('update_visit'),
        },
        // Stored at ingest from a validated prescription.written or drug.dispensed.
        prescriptionId: (prescription?.prescription_id ?? null) as PrescriptionId | null,
      };
    });
}

/** A completed step's stored record; null for a step in any other state. */
function completedRemote(step: StepAtRest): RemoteIdentifier | null {
  if (step.state !== 'completed') return null;
  if (!step.remote) throw new Error(`invariant broken: step ${step.name} is completed with no remote identifier`);
  return step.remote;
}

/**
 * The divergences of a case at rest (#39), from what its steps stored and
 * pinned and what the searches found: the Encounter create visit stored
 * (`finished`, at update visit's `meta.versionId`, once update visit
 * completed), the MedicationRequest and the MedicationDispense.
 */
function compareCase(
  c: CaseAtRest,
  found: { encounters: RecordAtSatusehat[]; medicationRequests: RecordAtSatusehat[]; medicationDispenses: RecordAtSatusehat[] },
): Divergence[] {
  const { create_visit: create, submit_prescription: prescribe, submit_dispense: dispense, update_visit: update } = c.steps;
  const encounter = completedRemote(create);
  const visitPins = encounter ? readCreateVisitPins(create.pins) : null;
  const updated = completedRemote(update);

  let expectedEncounter: ExpectedRecord | null = null;
  if (encounter && visitPins) {
    const version = updated ?? encounter;
    expectedEncounter = {
      step: 'create_visit',
      remote: encounter,
      fields: {
        status: updated ? 'finished' : 'arrived',
        subject: `Patient/${visitPins.patientIhsNumber}`,
        'participant.individual': `Practitioner/${visitPins.practitionerIhsNumber}`,
        location: `Location/${visitPins.locationId}`,
      },
      fieldSteps: updated ? { status: 'update_visit' } : {},
      version: version.version === null ? null : { value: version.version, step: updated ? 'update_visit' : 'create_visit' },
    };
  }

  const medicationRequest = completedRemote(prescribe);
  let expectedRequest: ExpectedRecord | null = null;
  if (medicationRequest && encounter && visitPins) {
    const pins = readSubmitPrescriptionPins(prescribe.pins);
    expectedRequest = {
      step: 'submit_prescription',
      remote: medicationRequest,
      fields: {
        status: 'completed',
        subject: `Patient/${visitPins.patientIhsNumber}`,
        requester: `Practitioner/${pins.requesterIhsNumber}`,
        encounter: `Encounter/${encounter.id}`,
        medication: pins.kfaCode,
      },
      fieldSteps: {},
      version: null,
    };
  }

  const medicationDispense = completedRemote(dispense);
  let expectedDispense: ExpectedRecord | null = null;
  if (medicationDispense && medicationRequest && encounter && visitPins) {
    const pins = readSubmitDispensePins(dispense.pins);
    expectedDispense = {
      step: 'submit_dispense',
      remote: medicationDispense,
      fields: {
        status: 'completed',
        subject: `Patient/${visitPins.patientIhsNumber}`,
        'performer.actor': `Practitioner/${pins.pharmacistIhsNumber}`,
        context: `Encounter/${encounter.id}`,
        authorizingPrescription: `MedicationRequest/${medicationRequest.id}`,
        medication: pins.kfaCode,
      },
      fieldSteps: {},
      version: null,
    };
  }

  return [
    ...compareResource({ resourceType: 'Encounter', step: 'create_visit', expected: expectedEncounter, found: found.encounters }),
    ...compareResource({ resourceType: 'MedicationRequest', step: 'submit_prescription', expected: expectedRequest, found: found.medicationRequests }),
    ...compareResource({ resourceType: 'MedicationDispense', step: 'submit_dispense', expected: expectedDispense, found: found.medicationDispenses }),
  ];
}
