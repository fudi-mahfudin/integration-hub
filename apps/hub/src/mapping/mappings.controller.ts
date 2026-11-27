import { Controller, Delete, Headers, HttpCode, Inject, Param, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { AdminKey } from '../auth/admin-key.js';
import type { SourceSystemId, SourceSystems } from '../auth/source-systems.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import { parseRequestBody } from '../http/request-body.js';
import { ADMIN_KEY, CLOCK, DATABASE, SOURCE_SYSTEMS } from '../tokens.js';
import { deleteDrugMapping, readDrugMapping, upsertDrugMappings, type DrugMapping } from './drug-mappings.js';
import { deleteLocationMapping, readLocationMapping, upsertLocationMappings, type LocationMapping } from './location-mappings.js';

const note = z.string().min(1).max(500).nullable().default(null);
const drugBody = z.object({ source: z.string(), kfaCode: z.string().regex(/^\d+$/, 'must be a KFA code of digits'), note });
const locationBody = z.object({ source: z.string(), locationId: z.string().min(1), note });

/** A mapping as the admin API answers it: a stored drug or location mapping, with when it last changed (ISO 8601 UTC). */
export type MappingView = (Omit<DrugMapping, 'source'> | Omit<LocationMapping, 'source'>) & { source: SourceSystemId; updatedAt: string };

/**
 * `PUT` / `DELETE /v1/admin/mappings/{drugs|locations}/{localCode}` (#10):
 * the operator's way to keep mappings, upserting the same tables as the seed
 * file. Admin API key only.
 */
@Controller('v1/admin/mappings')
export class MappingsController {
  constructor(
    @Inject(ADMIN_KEY) private readonly admin: AdminKey,
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Creates or replaces the mapping of (`source`, `localCode`); answers it as stored. */
  @Put(':kind/:localCode')
  async put(
    @Headers('authorization') authorization: string | undefined,
    @Param('kind') kind: string,
    @Param('localCode') localCode: string,
    @Req() req: FastifyRequest,
  ): Promise<MappingView> {
    this.admin.authenticate(authorization);
    const now = this.clock();
    if (kind === 'drugs') {
      const body = parseRequestBody(req.body, drugBody);
      const source = this.registered(body.source);
      await upsertDrugMappings(this.db, [{ source, localCode, kfaCode: body.kfaCode, note: body.note }], now);
      const stored = await readDrugMapping(this.db, source, localCode);
      if (!stored) throw new Error(`the drug mapping ${body.source}/${localCode} was just upserted, yet no row reads back`);
      return { ...stored, updatedAt: stored.updatedAt.toISOString() };
    }
    if (kind === 'locations') {
      const body = parseRequestBody(req.body, locationBody);
      const source = this.registered(body.source);
      await upsertLocationMappings(this.db, [{ source, localCode, locationId: body.locationId, note: body.note }], now);
      const stored = await readLocationMapping(this.db, source, localCode);
      if (!stored) throw new Error(`the location mapping ${body.source}/${localCode} was just upserted, yet no row reads back`);
      return { ...stored, updatedAt: stored.updatedAt.toISOString() };
    }
    throw new Problem('NOT_FOUND', []);
  }

  /** Deletes the mapping of (`?source=`, `localCode`); `404` when there is none. */
  @Delete(':kind/:localCode')
  @HttpCode(204)
  async delete(
    @Headers('authorization') authorization: string | undefined,
    @Param('kind') kind: string,
    @Param('localCode') localCode: string,
    @Query('source') source: string | undefined,
  ): Promise<void> {
    this.admin.authenticate(authorization);
    const remove = { drugs: deleteDrugMapping, locations: deleteLocationMapping }[kind];
    // An unregistered source has no mappings the admin API keeps.
    const registered = source === undefined ? undefined : this.sources.find(source)?.id;
    if (!remove || !registered || !(await remove(this.db, registered, localCode))) throw new Problem('NOT_FOUND', []);
  }

  /** The registered source system `source` names. @throws Problem `VALIDATION_FAILED` when there is none. */
  private registered(source: string): SourceSystemId {
    const found = this.sources.find(source);
    if (found) return found.id;
    throw new Problem('VALIDATION_FAILED', [{ path: '/source', code: 'INVALID_FORMAT', message: `must be a registered source system, got "${source}"` }]);
  }
}
