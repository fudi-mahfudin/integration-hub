import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminKey } from '../auth/admin-key.js';
import { Problem, type ProblemBody } from '../http/problem.js';
import { parseRequestBody, parseRequestQuery } from '../http/request-body.js';
import { parseSourceTime } from '../ingestion/source-time.js';
import { UUID } from '../cases/read-case.js';
import { ADMIN_KEY, RECONCILIATION } from '../tokens.js';
import { isFindingCursor, type ReconciliationRuns, type RunSummary, type RunView } from './runs.js';

/** `409 RECONCILIATION_RUNNING`, naming the run already queued or running (#39). */
class ReconciliationRunning extends Problem {
  constructor(readonly runId: string) {
    super('RECONCILIATION_RUNNING', []);
  }

  override toBody(): ProblemBody & { runId: string } {
    return { ...super.toBody(), runId: this.runId };
  }
}

const requestBody = z.object({
  caseIds: z.array(z.string().regex(UUID, 'must be a case id')).min(1).max(1000).nullable().default(null),
  since: z
    .string()
    .transform((text, ctx) => {
      const parsed = parseSourceTime(text);
      if (parsed.ok) return parsed.instant;
      ctx.addIssue({ code: 'custom', message: 'must be an ISO 8601 date-time with an explicit offset' });
      return z.NEVER;
    })
    .nullable()
    .default(null),
});
const readQuery = z.object({
  wait: z.coerce.number().int().min(0).max(60_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().refine(isFindingCursor, 'must be a nextCursor the hub gave').nullable().default(null),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** `/v1/admin/reconciliation/runs` (#39): the operator requests reconciliation runs and reads what they found. Admin API key only. */
@Controller('v1/admin/reconciliation/runs')
export class ReconciliationController {
  constructor(
    @Inject(ADMIN_KEY) private readonly admin: AdminKey,
    @Inject(RECONCILIATION) private readonly runs: ReconciliationRuns,
  ) {}

  /** Requests a run; a worker executes it. `409 RECONCILIATION_RUNNING` while another is queued or running. */
  @Post()
  @HttpCode(202)
  async request(@Headers('authorization') authorization: string | undefined, @Req() req: FastifyRequest): Promise<{ runId: string }> {
    this.admin.authenticate(authorization);
    const scope = parseRequestBody(req.body, requestBody);
    const requested = await this.runs.request(scope);
    if ('running' in requested) throw new ReconciliationRunning(requested.running);
    return { runId: requested.created };
  }

  /** The latest runs, newest first, without their findings. */
  @Get()
  async list(@Headers('authorization') authorization: string | undefined, @Query() rawQuery: unknown): Promise<{ runs: RunSummary[] }> {
    this.admin.authenticate(authorization);
    const { limit } = parseRequestQuery(rawQuery, listQuery);
    return { runs: await this.runs.list(limit) };
  }

  /** One run with a page of its findings; `?wait=ms` holds the answer until the run ends, or that long. */
  @Get(':id')
  async read(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Query() rawQuery: unknown,
  ): Promise<RunView> {
    this.admin.authenticate(authorization);
    const { wait, limit, cursor } = parseRequestQuery(rawQuery, readQuery);
    // Any other string names no run.
    const run = UUID.test(id) ? await this.runs.read(id, { limit, cursor }, wait) : undefined;
    if (!run) throw new Problem('NOT_FOUND', []);
    return run;
  }
}
