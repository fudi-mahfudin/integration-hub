import type { Migration } from 'kysely/migration';
import { migration0001 } from './0001_ingest.js';
import { migration0002 } from './0002_outbox.js';
import { migration0003 } from './0003_attempt_log.js';
import { migration0004 } from './0004_prescription.js';

/**
 * Every migration, in order. Keys are `NNNN_snake_case_name` and sort
 * lexically; never rename or edit one that has shipped. Static imports (not a
 * folder scan) so the same list works from `src` under tsx and from `dist`.
 */
export const migrations: Record<string, Migration> = {
  '0001_ingest': migration0001,
  '0002_outbox': migration0002,
  '0003_attempt_log': migration0003,
  '0004_prescription': migration0004,
};
