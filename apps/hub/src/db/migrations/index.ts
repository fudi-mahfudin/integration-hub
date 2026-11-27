import type { Migration } from 'kysely/migration';
import { ingestMigration } from './0001_ingest.js';
import { createVisitMigration } from './0002_create_visit.js';
import { attemptLogAndPinsMigration } from './0003_attempt_log_and_pins.js';
import { submitPrescriptionMigration } from './0004_submit_prescription.js';
import { updateVisitMigration } from './0005_update_visit.js';
import { leaseExpiryMigration } from './0006_lease_expiry.js';
import { retriesMigration } from './0007_retries.js';
import { replayAndAbandonMigration } from './0008_replay_and_abandon.js';
import { caseListMigration } from './0009_case_list.js';
import { reconciliationMigration } from './0010_reconciliation.js';
import { traceparentMigration } from './0011_traceparent.js';
import { gracefulShutdownMigration } from './0012_graceful_shutdown.js';
import { lookupSourcesMigration } from './0013_lookup_sources.js';

/**
 * Every migration, in order. Keys are `NNNN_snake_case_name` and sort
 * lexically; never rename or edit one that has shipped. Static imports (not a
 * folder scan) so the same list works from `src` under tsx and from `dist`.
 */
export const migrations: Record<string, Migration> = {
  '0001_ingest': ingestMigration,
  '0002_create_visit': createVisitMigration,
  '0003_attempt_log_and_pins': attemptLogAndPinsMigration,
  '0004_submit_prescription': submitPrescriptionMigration,
  '0005_update_visit': updateVisitMigration,
  '0006_lease_expiry': leaseExpiryMigration,
  '0007_retries': retriesMigration,
  '0008_replay_and_abandon': replayAndAbandonMigration,
  '0009_case_list': caseListMigration,
  '0010_reconciliation': reconciliationMigration,
  '0011_traceparent': traceparentMigration,
  '0012_graceful_shutdown': gracefulShutdownMigration,
  '0013_lookup_sources': lookupSourcesMigration,
};
