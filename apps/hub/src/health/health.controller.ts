import { Controller, Get } from '@nestjs/common';

/** Health endpoints for orchestrators and load balancers. */
@Controller()
export class HealthController {
  /** Liveness: answers whenever the event loop does. Checks no dependencies (#22). */
  @Get('livez')
  livez(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
