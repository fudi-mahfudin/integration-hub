import { Controller, Headers, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SourceSystems } from '../auth/source-systems.js';
import { Problem } from '../http/problem.js';
import { INGEST, SOURCE_SYSTEMS } from '../tokens.js';
import type { IdempotencyKey } from './idempotency-store.js';
import type { Ingest } from './ingest.js';

/** The longest `Idempotency-Key` accepted: opaque, UUID not required (#6). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** `POST /v1/events`: where source systems send source events. */
@Controller('v1/events')
export class EventsController {
  constructor(
    @Inject(SOURCE_SYSTEMS) private readonly sources: SourceSystems,
    @Inject(INGEST) private readonly ingestion: Ingest,
  ) {}

  /** Authenticates, checks the `Idempotency-Key` header, then hands the raw body to ingest (#7 check order). */
  @Post()
  async post(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const source = this.sources.authenticate(authorization);
    const key = parseIdempotencyKey(idempotencyKey);
    // The composition root makes every body arrive as raw text.
    const rawBody = typeof req.body === 'string' ? req.body : '';

    const response = await this.ingestion.ingest(source, key, rawBody);

    void reply.status(response.status).headers(response.headers).send(response.body);
  }
}

function parseIdempotencyKey(header: string | undefined): IdempotencyKey {
  if (header === undefined) throw new Problem('IDEMPOTENCY_KEY_MISSING', []);
  if (header.length === 0 || header.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Problem('IDEMPOTENCY_KEY_INVALID', []);
  }
  // Checked above: 1-255 characters is all an idempotency key must be.
  return header as IdempotencyKey;
}
