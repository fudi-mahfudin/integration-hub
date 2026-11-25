import type { Migration } from 'kysely/migration';

/**
 * Every migration, in order. Keys are `NNNN_snake_case_name` and sort
 * lexically; never rename or edit one that has shipped. Static imports (not a
 * folder scan) so the same list works from `src` under tsx and from `dist`.
 */
export const migrations: Record<string, Migration> = {};
