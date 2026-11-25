import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SourceSystems } from '../auth/source-systems.js';
import { Problem } from '../http/problem.js';
import { INGEST, SOURCE_SYSTEMS } from '../tokens.js';
import type { Ingest } from './ingest.js';

/** Opaque, at most 255 characters, UUID not required (#6). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

@Controller('v1/events')
export class EventsController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(INGEST) private readonly ingestion: Ingest,
  ) {}

  /** Check order (#7): authenticate, then the key header, then everything else in `Ingest`. */
  @Post()
  async ingest(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const source = this.sources.authenticate(req.headers.authorization);
    const key = req.headers['idempotency-key'];
    if (key === undefined) throw new Problem(400, 'IDEMPOTENCY_KEY_MISSING');
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new Problem(400, 'IDEMPOTENCY_KEY_INVALID', [], `must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    const rawBody = typeof req.body === 'string' ? req.body : '';

    const response = await this.ingestion.accept(source, key, rawBody);

    void reply.status(response.status).headers(response.headers).send(response.body);
  }
}
