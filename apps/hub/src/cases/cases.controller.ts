import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminKey } from '../auth/admin-key.js';
import type { SourceSystems } from '../auth/source-systems.js';
import { Problem } from '../http/problem.js';
import { parseRequestBody } from '../http/request-body.js';
import { ADMIN_KEY, CASES, SOURCE_SYSTEMS } from '../tokens.js';
import type { Cases } from './cases.js';
import type { CaseView } from './read-case.js';

const note = z.string().max(2000).refine((n) => n.trim() !== '', 'must not be blank');
const replayBody = z.object({ note: note.nullable().default(null) });
const abandonBody = z.object({ note });

/** Read access to cases, and the operator's replay and abandon actions. */
@Controller('v1/cases')
export class CasesController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(ADMIN_KEY) private readonly admin: AdminKey,
    @Inject(CASES) private readonly cases: Cases,
  ) {}

  /** A case's status and step states. A source system sees only its own cases; the admin key sees every case. */
  @Get(':id')
  async get(@Param('id') id: string, @Headers('authorization') authorization: string | undefined): Promise<CaseView> {
    const scope = this.admin.presentedBy(authorization) ? 'operator' : { sourceSystemId: this.sources.authenticate(authorization).id };
    const view = await this.cases.read(scope, id);
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
}
