// Reading the run's cases from the hub's public case API, as the operator would.
import { z } from 'zod';

const caseViewSchema = z.object({
  caseId: z.string(),
  visitId: z.string(),
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

/** Thrown when the hub answers a case read with something other than a case. */
export class CaseReadError extends Error {
  constructor(caseId: string, detail: string) {
    super(`reading case ${caseId} failed: ${detail}`);
    this.name = 'CaseReadError';
  }
}

/** How many cases are read at once. */
const READS_AT_ONCE = 20;

/** Reads each case with the admin API key, a few at a time, in the order given. */
export async function readCaseViews(hubUrl: URL, adminApiKey: string, caseIds: readonly string[]): Promise<CaseView[]> {
  const views: CaseView[] = [];
  for (let i = 0; i < caseIds.length; i += READS_AT_ONCE) {
    const chunk = caseIds.slice(i, i + READS_AT_ONCE);
    views.push(
      ...(await Promise.all(
        chunk.map(async (caseId) => {
          const res = await fetch(new URL(`v1/cases/${encodeURIComponent(caseId)}`, hubUrl), { headers: { authorization: `Bearer ${adminApiKey}` } });
          const parsed = caseViewSchema.safeParse(await res.json());
          if (res.status !== 200 || !parsed.success) throw new CaseReadError(caseId, `HTTP ${res.status}${parsed.success ? '' : `, ${parsed.error.issues[0]?.message}`}`);
          return parsed.data;
        }),
      )),
    );
  }
  return views;
}
