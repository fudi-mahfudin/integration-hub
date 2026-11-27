import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { READINESS } from '../tokens.js';
import { readinessHttpStatus, type Readiness } from './readiness.js';

/** Health endpoints for orchestrators and load balancers. */
@Controller()
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: Readiness) {}

  /** Liveness: answers whenever the event loop does. Checks no dependencies (#22). */
  @Get('livez')
  livez(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness (#43): `200` while Postgres answers and the hub service is not draining, `503` otherwise. */
  @Get('readyz')
  async readyz(@Res() reply: FastifyReply): Promise<void> {
    const report = await this.readiness.check();
    void reply.status(readinessHttpStatus(report)).send(report);
  }
}
