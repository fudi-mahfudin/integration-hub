import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { ClaimedStep, RemoteIdentifier } from '../outbox/outbox.js';
import type { FhirClient } from '../satusehat/fhir-client.js';

/** What a step attempt ended with. A transient failure is a thrown error instead. */
export type StepResult =
  | { outcome: 'completed'; remote: RemoteIdentifier }
  /** Permanent: the step dead-letters with this stable reason code (#8, #9). */
  | { outcome: 'dead_lettered'; reason: string };

export interface StepDeps {
  db: Kysely<Database>;
  fhir: FhirClient;
}

/** One step's attempt: resolve what it needs, then search-then-create (ADR 0005). */
export type StepRunner = (step: ClaimedStep, deps: StepDeps) => Promise<StepResult>;

/** The source event envelope a step works from (stored by ingest, immutable). */
export async function sourceEvent(db: Kysely<Database>, caseId: string, type: string): Promise<Record<string, any>> {
  const row = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', caseId)
    .where('type', '=', type)
    .executeTakeFirstOrThrow();
  return row.envelope as Record<string, any>;
}

/**
 * Search-then-create (ADR 0005): exactly one match is adopted, none is
 * created, more than one dead-letters (`REMOTE_RECORD_AMBIGUOUS`).
 */
export async function searchThenCreate(
  fhir: FhirClient,
  type: string,
  identifier: { system: string; value: string },
  build: () => Record<string, unknown>,
): Promise<StepResult> {
  const hits = await fhir.search(type, { identifier: `${identifier.system}|${identifier.value}` });
  if (hits.length > 1) return { outcome: 'dead_lettered', reason: 'REMOTE_RECORD_AMBIGUOUS' };
  const record = hits[0] ?? (await fhir.create(type, build()));
  return { outcome: 'completed', remote: { type, id: record.id, version: record.meta?.versionId ?? null } };
}
