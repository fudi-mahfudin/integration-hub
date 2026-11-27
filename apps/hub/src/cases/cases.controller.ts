import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminKey } from '../auth/admin-key.js';
import type { SourceSystems } from '../auth/source-systems.js';
import { Problem } from '../http/problem.js';
import { parseRequestBody, parseRequestQuery } from '../http/request-body.js';
import { ADMIN_KEY, CASES, SOURCE_SYSTEMS } from '../tokens.js';
import type { Cases } from './cases.js';
import { CASE_STATUSES, STEPS, type DeadLetterReason } from './case-model.js';
import type { CaseScope } from './case-summary.js';
import { isDeadLetterReason } from './reason-class.js';
import { readScopeOf } from './read-scope.js';
import { decodeCaseCursor, type CasePage } from './list-cases.js';
import type { CaseView } from './read-case.js';

const note = z.string().max(2000).refine((n) => n.trim() !== '', 'must not be blank');
const replayBody = z.object({ note: note.nullable().default(null) });
const abandonBody = z.object({ note });
/** A query parameter that is null when not given. */
const nullUnlessGiven = <T extends z.ZodType>(schema: T) => schema.nullable().default(null);
const listQuery = z.object({
  status: nullUnlessGiven(z.enum(CASE_STATUSES)),
  stalled: nullUnlessGiven(z.enum(['true', 'false']).transform((v) => v === 'true')),
  step: nullUnlessGiven(z.enum(STEPS.map((s) => s.name))),
  source: nullUnlessGiven(z.string()),
  visitId: nullUnlessGiven(z.string()),
  reason: nullUnlessGiven(z.custom<DeadLetterReason>((v) => typeof v === 'string' && isDeadLetterReason(v), 'must be a dead-letter reason')),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z
    .string()
    .transform((text, ctx) => decodeCaseCursor(text) ?? (ctx.addIssue({ code: 'custom', message: 'must be a nextCursor the hub gave' }), z.NEVER))
    .nullable()
    .default(null),
});

/** Read access to cases, and the operator's replay and abandon actions. */
@Controller('v1/cases')
export class CasesController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(ADMIN_KEY) private readonly admin: AdminKey,
    @Inject(CASES) private readonly cases: Cases,
  ) {}

  /** A page of cases, newest first. A source system sees only its own cases; the admin key sees every case. */
  @Get()
  async list(@Headers('authorization') authorization: string | undefined, @Query() rawQuery: unknown): Promise<CasePage> {
    const scope = this.scopeOf(authorization);
    const query = parseRequestQuery(rawQuery, listQuery);
    const { limit, cursor, ...filter } = query;
    return this.cases.list(scope, filter, { limit, cursor });
  }

  /** A case's status and step states. A source system sees only its own cases; the admin key sees every case. */
  @Get(':id')
  async get(@Param('id') id: string, @Headers('authorization') authorization: string | undefined): Promise<CaseView> {
    const view = await this.cases.read(this.scopeOf(authorization), id);
    if (!view) throw new Problem('NOT_FOUND', []);
    return view;
  }

  /** Replays a dead-lettered case from its failed step, with an optional note. Admin key only. */
  @Post(':id/replay')
  @HttpCode(200)
  async replay(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Req() req: FastifyRequest): Promise<CaseView> {
    this.admin.authenticate(authorization);
    const body = parseRequestBody(req.body, replayBody);
    return this.cases.replay(id, body.note);
  }

  /** Abandons a waiting or dead-lettered case; the note is required. Admin key only. */
  @Post(':id/abandon')
  @HttpCode(200)
  async abandon(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Req() req: FastifyRequest): Promise<CaseView> {
    this.admin.authenticate(authorization);
    const body = parseRequestBody(req.body, abandonBody);
    return this.cases.abandon(id, body.note);
  }

  private scopeOf(authorization: string | undefined): CaseScope {
    return readScopeOf(authorization, { admin: this.admin, sources: this.sources });
  }
}
