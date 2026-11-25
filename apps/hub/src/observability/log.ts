/** Severity of a log line. */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Writes one structured log line (JSON) to stdout, or stderr for errors.
 * Case-scoped lines must pass the case ID as `caseId`, which is the
 * correlation ID.
 */
export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }, serializeErrors);
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

function serializeErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, cause: value.cause };
  }
  return value;
}
