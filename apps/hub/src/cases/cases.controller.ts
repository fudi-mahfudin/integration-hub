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
    // One snapshot: a completion committing between the two reads would
    // otherwise show a completed step under the old case status.
    const { kase, steps, log } = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const kase = await trx
          .selectFrom('case')
          .select(['id', 'source_id', 'visit_id', 'status', 'waiting_for', 'waiting_since'])
          .where('id', '=', id)
          .where('source_id', '=', source.id)
          .executeTakeFirst();
        const steps = await trx
          .selectFrom('step')
          .select([
            'seq',
            'name',
            'event_type',
            'state',
            'attempts',
            'dead_letter_reason',
            'remote_type',
            'remote_id',
            'remote_version',
            'pins',
          ])
          .where('case_id', '=', id)
          .orderBy('seq')
          .execute();
        const log = await trx
          .selectFrom('step_attempt')
          .selectAll()
          .where('case_id', '=', id)
          .orderBy('seq')
          .orderBy('attempt')
          .execute();
        return { kase, steps, log };
      });
    if (!kase) throw new Problem(404, 'NOT_FOUND');
    return {
      caseId: kase.id,
      source: kase.source_id,
      visitId: kase.visit_id,
      status: kase.status,
      waitingFor: kase.waiting_for,
      waitingSince: kase.waiting_since?.toISOString() ?? null,
      steps: steps.map((s) => ({
        step: s.name,
        eventType: s.event_type,
        state: s.state,
        attempts: s.attempts,
        deadLetterReason: s.dead_letter_reason,
        remote:
          s.remote_type !== null && s.remote_id !== null
            ? { type: s.remote_type, id: s.remote_id, version: s.remote_version }
            : null,
        pins: s.pins,
        attemptLog: log
          .filter((a) => a.seq === s.seq)
          .map((a) => ({
            attempt: a.attempt,
            startedAt: a.started_at.toISOString(),
            endedAt: a.ended_at.toISOString(),
            outcome: a.outcome,
            errorCode: a.error_code,
            httpStatus: a.http_status,
            used: a.used,
            violations: a.violations,
            detail: a.detail,
          })),
      })),
    };
  }
}
