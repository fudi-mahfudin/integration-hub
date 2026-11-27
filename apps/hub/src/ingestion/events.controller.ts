import { Controller, Headers, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SourceSystems } from '../auth/source-systems.js';
import { Problem } from '../http/problem.js';
import { stopwatch, type HubMetrics, type IngestEventType } from '../observability/metrics.js';
import { INGEST, METRICS, SOURCE_SYSTEMS } from '../tokens.js';
import { eventTypeOf } from './event-schema.js';
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
    @Inject(METRICS) private readonly metrics: HubMetrics,
  ) {}

  /**
   * Authenticates, checks the `Idempotency-Key` header, then hands the raw
   * body to ingest (#7 check order). Every request is measured by the event
   * type its body names (`unknown` until it is authenticated) and its status;
   * every problem is counted by its code (#41).
   */
  @Post()
  async post(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const elapsed = stopwatch();
    let eventType: IngestEventType = 'unknown';
    let status = 500;
    try {
      const source = this.sources.authenticate(authorization);
      // The composition root makes every body arrive as raw text.
      const rawBody = typeof req.body === 'string' ? req.body : '';
      eventType = eventTypeOf(rawBody) ?? 'unknown';
      const key = parseIdempotencyKey(idempotencyKey);

      const response = await this.ingestion.ingest(source, key, rawBody);
      status = response.status;
      void reply.status(response.status).headers(response.headers).send(response.body);
    } catch (err) {
      if (err instanceof Problem) {
        status = err.status;
        this.metrics.ingestRejected(err.code);
      }
      throw err;
    } finally {
      this.metrics.ingestRequest(eventType, status, elapsed());
    }
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
