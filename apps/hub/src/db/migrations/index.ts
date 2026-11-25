import type { Migration } from 'kysely/migration';
import { migration0001 } from './0001_ingest.js';
import { migration0002 } from './0002_outbox.js';

/**
 * Every migration, in order. Keys are `NNNN_snake_case_name` and sort
 * lexically; never rename or edit one that has shipped. Static imports (not a
 * folder scan) so the same list works from `src` under tsx and from `dist`.
 */
export const migrations: Record<string, Migration> = {
  '0001_ingest': migration0001,
  '0002_outbox': migration0002,
};
