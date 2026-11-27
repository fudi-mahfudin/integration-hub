// Reading the run's cases from the hub's public case API, as the operator would.
import type { CaseId, VisitId } from '@integration-hub/simulator';
import { z } from 'zod';

const caseViewSchema = z.object({
  caseId: z.string().transform((id) => id as CaseId), // the hub's own id of the case
  visitId: z.string().transform((id) => id as VisitId), // the visit number the simulator sent
  status: z.string(),
  currentStep: z.string().nullable(),
  waitingFor: z.string().nullable(),
  deadLetterReason: z.string().nullable(),
  events: z.array(z.object({ type: z.string(), receivedAt: z.string() })),
  steps: z.array(
    z.object({
      step: z.string(),
      state: z.string(),
      attempts: z.number().int(),
      deadLetterReason: z.string().nullable(),
      attemptLog: z.array(z.object({ outcome: z.string(), errorCode: z.string().nullable(), endedAt: z.string().nullable() })),
    }),
  ),
});

/** What the harness reads of a case from `GET /v1/cases/{id}`. */
export type CaseView = z.infer<typeof caseViewSchema>;


/** How many cases are read at once. */
const READS_AT_ONCE = 20;

/** The cases read, and each one that could not be, with why. */
export interface CaseReads {
  views: CaseView[];
  unreadable: { caseId: CaseId; error: string }[];
}

/**
 * Reads each case with the admin API key, a few at a time. Never throws: a
 * case the hub can't show is listed as unreadable, so a run whose hub is
 * failing still gets its full FAIL report.
 */
export async function readCaseViews(hub: { baseUrl: URL; adminApiKey: string }, caseIds: readonly CaseId[]): Promise<CaseReads> {
  const reads: CaseReads = { views: [], unreadable: [] };
  for (let i = 0; i < caseIds.length; i += READS_AT_ONCE) {
    await Promise.all(
      caseIds.slice(i, i + READS_AT_ONCE).map(async (caseId) => {
        try {
          const res = await fetch(new URL(`v1/cases/${encodeURIComponent(caseId)}`, hub.baseUrl), { headers: { authorization: `Bearer ${hub.adminApiKey}` } });
          const parsed = caseViewSchema.safeParse(await res.json());
          if (res.status === 200 && parsed.success) reads.views.push(parsed.data);
          else reads.unreadable.push({ caseId, error: `HTTP ${res.status}${parsed.success ? '' : `, ${parsed.error.issues[0]?.message}`}` });
        } catch (err) {
          // Handled: the case counts as not completed, and the report names it with the error.
          reads.unreadable.push({ caseId, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
  }
  return reads;
}
