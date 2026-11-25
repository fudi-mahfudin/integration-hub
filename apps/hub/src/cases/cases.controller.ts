import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { SourceSystems } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import { DATABASE, SOURCE_SYSTEMS } from '../tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/cases')
export class CasesController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(DATABASE) private readonly db: Kysely<Database>,
  ) {}

  /**
   * Case status and step states. For now a source key sees only its own cases;
   * the dashboard's admin key and the richer view of #21 come later.
   */
  @Get(':id')
  async get(@Param('id') id: string, @Req() req: FastifyRequest) {
    const source = this.sources.authenticate(req.headers.authorization);
    if (!UUID.test(id)) throw new Problem(404, 'NOT_FOUND');
    const kase = await this.db
      .selectFrom('case')
      .select(['id', 'source_id', 'visit_id', 'status', 'waiting_for', 'waiting_since'])
      .where('id', '=', id)
      .where('source_id', '=', source.id)
      .executeTakeFirst();
    if (!kase) throw new Problem(404, 'NOT_FOUND');
    const steps = await this.db
      .selectFrom('step')
      .select(['name', 'event_type', 'state'])
      .where('case_id', '=', id)
      .orderBy('seq')
      .execute();
    return {
      caseId: kase.id,
      source: kase.source_id,
      visitId: kase.visit_id,
      status: kase.status,
      waitingFor: kase.waiting_for,
      waitingSince: kase.waiting_since?.toISOString() ?? null,
      steps: steps.map((s) => ({ step: s.name, eventType: s.event_type, state: s.state })),
    };
  }
}
