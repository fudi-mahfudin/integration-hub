import { AsyncLocalStorage } from 'node:async_hooks';
import { pino } from 'pino';
import type { CaseId, StepName } from '../cases/case-model.js';
import { redact, scrub } from './redaction.js';

/** Severity of a log line (#15): transient failures `warn`; dead-letters and permanent failures `error`; duplicates and rejections `info`. */
export type LogLevel = 'info' | 'warn' | 'error';

/** The process a log line comes from, its `service` field. */
export type Service = 'hub' | 'worker';

/**
 * What a log line carries besides its message. Case-scoped lines pass the
 * case ID as `caseId`, the correlation ID. `visitId` is never logged: the
 * case view and the rejection log hold it.
 */
export interface LogFields {
  caseId?: CaseId;
  step?: StepName;
  attempt?: number;
  /** A stable code: a dead-letter reason, a problem code, a step outcome. */
  errorCode?: string;
  error?: unknown;
  visitId?: never;
  [field: string]: unknown;
}

/**
 * Writes one structured log line. Every line passes the redaction module
 * here, message included, so call sites never redact.
 */
export type Log = (level: LogLevel, msg: string, fields?: LogFields) => void;

/** Where log lines go, one JSON line per `write`: stdout in production, memory in the canary test. */
export interface LogDestination {
  write(line: string): void;
}

/** The fields every line logged while handling one request carries: `requestId`, then `source` and `eventType` once known. */
interface RequestContext {
  requestId: string;
  source?: string;
  eventType?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Builds the log of one process: pino JSON lines with `time`, `level`,
 * `msg` and `service`, plus the request context of the request being
 * handled, if any. Only composition roots and entry points call this.
 */
export function createLog(service: Service, destination: LogDestination): Log {
  const logger = pino(
    {
      level: 'info',
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => {
        const context = requestContext.getStore();
        // Redacted like every other field, though its values come from config and closed sets.
        return context === undefined ? {} : (redact({ ...context }) as Record<string, unknown>);
      },
    },
    destination,
  );
  return (level, msg, fields = {}) => {
    // `redact` takes and returns `unknown`; a record in gives a record out.
    logger[level](redact(fields) as Record<string, unknown>, scrub(msg));
  };
}

/** Runs `handle` with a fresh request context, so every line it logs carries `requestId`. */
export function runInRequestContext(requestId: string, handle: () => void): void {
  requestContext.run({ requestId }, handle);
}

/** Adds `source` or `eventType` to the request being handled, for every line it logs from now on; outside a request it does nothing. */
export function addToRequestContext(fields: Pick<RequestContext, 'source' | 'eventType'>): void {
  const context = requestContext.getStore();
  if (context !== undefined) Object.assign(context, fields);
}
