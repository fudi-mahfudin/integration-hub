import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { MetricsExposition } from '../observability/metrics.js';
import { METRICS } from '../tokens.js';

/** `GET /metrics`: the hub service's Prometheus metrics (#41). Unauthenticated, like `/livez`: no label holds personal data. */
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsExposition) {}

  /** The metrics as of now, database-derived gauges read for this scrape. */
  @Get('metrics')
  async metricsText(@Res() reply: FastifyReply): Promise<void> {
    const text = await this.metrics.scrape();
    void reply.status(200).header('content-type', this.metrics.contentType).send(text);
  }
}
