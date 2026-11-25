import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/** One per-field violation in a problem's `errors[]`. `path` is a JSON Pointer (RFC 6901) into the body. */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

/** Where every problem `type` URI points: the API contract, one anchor per code. */
const PROBLEM_TYPE_BASE = 'https://github.com/fudi-mahfudin/integration-hub/blob/main/docs/api.md#';

const TITLES = {
  UNAUTHENTICATED: 'Missing or unknown API key',
  IDEMPOTENCY_KEY_MISSING: 'Idempotency-Key header is required',
  IDEMPOTENCY_KEY_INVALID: 'Idempotency-Key header is invalid',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key was already used for a different request',
  VALIDATION_FAILED: 'The event failed validation',
  UNSUPPORTED_MULTI_ITEM: 'A prescription must have exactly one item',
  EVENT_ALREADY_RECORDED: 'This event was already recorded for the visit',
  PRESCRIPTION_MISMATCH: 'The dispense does not name the visit prescription',
  FINISHED_BEFORE_STARTED: 'The visit cannot finish before it started',
  NOT_FOUND: 'Not found',
  INTERNAL_ERROR: 'Internal error',
} as const satisfies Record<string, string>;

/** Every problem code the API answers with; add a code to `TITLES` and to docs/api.md. */
export type ProblemCode = keyof typeof TITLES;

/**
 * An RFC 9457 problem. Throw it anywhere in a request; `ProblemFilter`
 * renders it as `application/problem+json`.
 */
export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode,
    readonly errors: FieldError[] = [],
    readonly detail?: string,
  ) {
    super(`${status} ${code}`);
  }

  toJSON() {
    return {
      type: PROBLEM_TYPE_BASE + this.code.toLowerCase().replaceAll('_', '-'),
      title: TITLES[this.code],
      status: this.status,
      code: this.code,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      errors: this.errors,
    };
  }
}

export function sendProblem(reply: FastifyReply, problem: Problem): void {
  void reply.status(problem.status).header('content-type', 'application/problem+json').send(problem.toJSON());
}

/** Renders every error leaving a controller (and Nest's own 404s) as a problem. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof Problem) return sendProblem(reply, exception);
    if (exception instanceof HttpException && exception.getStatus() === 404) {
      return sendProblem(reply, new Problem(404, 'NOT_FOUND'));
    }
    console.error(exception);
    sendProblem(reply, new Problem(500, 'INTERNAL_ERROR'));
  }
}
