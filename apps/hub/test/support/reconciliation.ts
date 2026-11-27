import { expect } from 'vitest';
import { z } from 'zod';
import { adminRequest } from './events.js';

const findingSchema = z.object({
  caseId: z.string(),
  visitId: z.string(),
  kind: z.enum(['divergence', 'skipped', 'unchecked']),
  class: z.string().nullable(),
  step: z.string().nullable(),
  resourceType: z.string().nullable(),
  field: z.string().nullable(),
  snapshot: z.record(z.string(), z.unknown()),
});

/** A run as `GET /v1/admin/reconciliation/runs` lists it. */
export const runSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'completed_with_errors', 'failed', 'interrupted']),
  trigger: z.enum(['operator', 'schedule']),
  scope: z.object({ caseIds: z.array(z.string()).nullable(), since: z.string().nullable() }),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  counts: z.object({ cases: z.number(), clean: z.number(), divergent: z.number(), skipped: z.number(), unchecked: z.number() }),
});

/** A run as `GET /v1/admin/reconciliation/runs/{id}` shows it. */
export const runSchema = runSummarySchema.extend({ findings: z.array(findingSchema), nextCursor: z.string().nullable() });

/** A reconciliation run as tests read it. */
export type Run = z.infer<typeof runSchema>;

const ended = (r: Run) => ['completed', 'completed_with_errors', 'failed', 'interrupted'].includes(r.status);

/** `POST /v1/admin/reconciliation/runs` with `body`, expecting `202`; resolves to the new run's id. */
export async function requestRun(baseUrl: URL, body: unknown): Promise<string> {
  const res = await adminRequest(baseUrl, 'POST', 'v1/admin/reconciliation/runs', { body });
  expect(res.status).toBe(202);
  return z.object({ runId: z.string() }).parse(await res.json()).runId;
}

/** `GET /v1/admin/reconciliation/runs/{id}` with `query`. */
export async function readRun(baseUrl: URL, runId: string, query = ''): Promise<Run> {
  const res = await adminRequest(baseUrl, 'GET', `v1/admin/reconciliation/runs/${runId}?${query}`);
  expect(res.status).toBe(200);
  return runSchema.parse(await res.json());
}

/** Long-polls run `runId` until it ends, and resolves to it. Fails after `timeoutMs`. */
export async function awaitRun(baseUrl: URL, runId: string, timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await readRun(baseUrl, runId, 'wait=2000');
    if (ended(run)) return run;
  }
  throw new Error(`run ${runId} did not end within ${timeoutMs}ms`);
}

/** `GET /v1/admin/reconciliation/runs?limit=`. */
export async function listRuns(baseUrl: URL, limit: number) {
  const res = await adminRequest(baseUrl, 'GET', `v1/admin/reconciliation/runs?limit=${limit}`);
  expect(res.status).toBe(200);
  return z.object({ runs: z.array(runSummarySchema) }).parse(await res.json()).runs;
}
