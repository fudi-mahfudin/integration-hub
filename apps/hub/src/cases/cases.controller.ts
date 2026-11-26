import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SourceSystems } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import { DATABASE, SOURCE_SYSTEMS } from '../tokens.js';
import { readCase, type CaseView } from './read-case.js';

/** Read access to cases. */
@Controller('v1/cases')
export class CasesController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(DATABASE) private readonly db: Kysely<Database>,
  ) {}

  /** A case's status and step states. A source system sees only its own cases. */
  @Get(':id')
  async get(@Param('id') id: string, @Headers('authorization') authorization: string | undefined): Promise<CaseView> {
    const source = this.sources.authenticate(authorization);
    const view = await readCase(this.db, source.id, id);
    if (!view) throw new Problem('NOT_FOUND', []);
    return view;
  }
}
