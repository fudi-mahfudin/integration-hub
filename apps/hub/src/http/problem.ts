import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { log } from '../observability/log.js';

/** One violation in a problem's `errors[]`. `path` is a JSON Pointer (RFC 6901) into the request body. */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

/** Where every problem `type` URI points: the API contract, one heading per code. */
const PROBLEM_TYPE_BASE = 'https://github.com/fudi-mahfudin/integration-hub/blob/main/docs/api.md#';

const PROBLEMS = {
  UNAUTHENTICATED: { status: 401, title: 'Missing or unknown API key' },
  IDEMPOTENCY_KEY_MISSING: { status: 400, title: 'The Idempotency-Key header is required' },
  IDEMPOTENCY_KEY_INVALID: { status: 400, title: 'The Idempotency-Key header must be 1-255 characters' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'The Idempotency-Key was already used for a different request' },
  VALIDATION_FAILED: { status: 422, title: 'The source event failed validation' },
  UNSUPPORTED_MULTI_ITEM: { status: 422, title: 'A prescription must have exactly one drug item, and a visit exactly one prescription' },
  PRESCRIPTION_MISMATCH: { status: 422, title: "The event names another prescription or item than the case's" },
  FINISHED_BEFORE_STARTED: { status: 422, title: "The visit's finishedAt is not later than its startedAt" },
  EVENT_ALREADY_RECORDED: { status: 409, title: 'This event was already recorded for the visit' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
} as const satisfies Record<string, { status: number; title: string }>;

/** Every stable problem `code` the API answers with; each has a heading in docs/api.md. */
export type ProblemCode = keyof typeof PROBLEMS;

/** The RFC 9457 body of a problem. */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  errors: FieldError[];
}

/**
 * An RFC 9457 problem with a stable `code`. Throw it anywhere in a request;
 * `ProblemFilter` renders it as `application/problem+json`.
 */
export class Problem extends Error {
  /** The HTTP status, fixed per code. */
  readonly status: number;

  constructor(
    readonly code: ProblemCode,
    readonly errors: FieldError[],
  ) {
    super(`${PROBLEMS[code].status} ${code}${errors.length > 0 ? `: ${errors.map((e) => `${e.path} ${e.code}`).join(', ')}` : ''}`);
    this.name = 'Problem';
    this.status = PROBLEMS[code].status;
  }

  /** The `application/problem+json` body. */
  toBody(): ProblemBody {
    return {
      type: PROBLEM_TYPE_BASE + this.code.toLowerCase(),
      title: PROBLEMS[this.code].title,
      status: this.status,
      code: this.code,
      errors: this.errors,
    };
  }
}

function sendProblem(reply: FastifyReply, problem: Problem): void {
  void reply.status(problem.status).header('content-type', 'application/problem+json');
  if (problem.code === 'UNAUTHENTICATED') void reply.header('www-authenticate', 'Bearer');
  void reply.send(problem.toBody());
}

/** Renders every error leaving a controller (and Nest's own unknown-route 404s) as a problem. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof Problem) return sendProblem(reply, exception);
    if (exception instanceof HttpException && exception.getStatus() === 404) {
      return sendProblem(reply, new Problem('NOT_FOUND', []));
    }
    log('error', 'unhandled error in a request', { error: exception });
    sendProblem(reply, new Problem('INTERNAL_ERROR', []));
  }
}
