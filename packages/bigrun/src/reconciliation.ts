// The one on-demand reconciliation run after the drain. Its counts are
// information only, never a pass criterion (bigrun.commitments.json).
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

const requested = z.object({ runId: z.string() });
const runView = z.object({
  runId: z.string(),
  status: z.string(),
  counts: z.object({ cases: z.number(), clean: z.number(), divergent: z.number(), skipped: z.number(), unchecked: z.number() }),
});

/** How the run went: its status and counts, or why there are none. */
export type ReconciliationOutcome = z.infer<typeof runView> | { error: string };

const ENDED = new Set(['completed', 'completed_with_errors', 'failed', 'interrupted']);

/** Requests a run over the cases changed since `since`, and waits up to `timeoutMs` for it to end. */
export async function reconcileAfterDrain(hubUrl: URL, adminApiKey: string, since: Date, timeoutMs: number): Promise<ReconciliationOutcome> {
  const headers = { authorization: `Bearer ${adminApiKey}`, 'content-type': 'application/json' };
  try {
    const res = await fetch(new URL('v1/admin/reconciliation/runs', hubUrl), { method: 'POST', headers, body: JSON.stringify({ since: since.toISOString() }) });
    // A 409 names the run already queued or running; that one is waited for instead.
    if (res.status !== 202 && res.status !== 409) return { error: `requesting a run answered HTTP ${res.status}` };
    const { runId } = requested.parse(await res.json());
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await fetch(new URL(`v1/admin/reconciliation/runs/${encodeURIComponent(runId)}?wait=30000&limit=1`, hubUrl), { headers });
      const run = runView.parse(await view.json());
      if (ENDED.has(run.status)) return run;
      if (Date.now() > deadline) return { error: `run ${runId} was still ${run.status} after ${timeoutMs}ms` };
      await sleep(1000);
    }
  } catch (err) {
    // Carrying on is safe: the counts are information only, and the report says why they are missing.
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
