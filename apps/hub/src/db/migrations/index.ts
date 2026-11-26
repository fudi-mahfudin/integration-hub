import type { Migration } from 'kysely/migration';
import { ingestMigration } from './0001_ingest.js';
import { createVisitMigration } from './0002_create_visit.js';
import { attemptLogAndPinsMigration } from './0003_attempt_log_and_pins.js';
import { submitPrescriptionMigration } from './0004_submit_prescription.js';
import { updateVisitMigration } from './0005_update_visit.js';
import { leaseExpiryMigration } from './0006_lease_expiry.js';

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
};
