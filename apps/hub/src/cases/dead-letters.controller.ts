import { Controller, Get, Headers, Inject } from '@nestjs/common';
import type { AdminKey } from '../auth/admin-key.js';
import type { SourceSystems } from '../auth/source-systems.js';
import { ADMIN_KEY, CASES, SOURCE_SYSTEMS } from '../tokens.js';
import type { Cases } from './cases.js';
import type { DeadLetterGroup } from './dead-letter-summary.js';
import { readScopeOf } from './read-scope.js';

/** `GET /v1/dead-letters/summary` (#38): what the dashboard's dead-letter screen groups. */
@Controller('v1/dead-letters')
export class DeadLettersController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(ADMIN_KEY) private readonly admin: AdminKey,
    @Inject(CASES) private readonly cases: Cases,
  ) {}

  /** The dead-lettered cases by reason. A source system sees only its own cases; the admin key sees every case. */
  @Get('summary')
  async summary(@Headers('authorization') authorization: string | undefined): Promise<DeadLetterGroup[]> {
    return this.cases.deadLetterSummary(readScopeOf(authorization, { admin: this.admin, sources: this.sources }));
  }
}
