import type { LoggerService } from '@nestjs/common';
import type { Log } from './log.js';

/**
 * NestJS's own log output as structured lines through `log`, so every line
 * the hub service writes is JSON and redacted. Nest's warnings and errors
 * are kept; its boot chatter (`log`, `debug`, `verbose`) is dropped, as before.
 */
export function nestLogger(log: Log): LoggerService {
  const write = (level: 'warn' | 'error', message: unknown, extra: unknown[]) => {
    // Nest passes the context (the class name) last, and an error's stack before it.
    const context = extra.at(-1);
    log(level, typeof message === 'string' ? message : 'NestJS reported an error', {
      ...(typeof context === 'string' ? { nestContext: context } : {}),
      ...(message instanceof Error ? { error: message } : {}),
    });
  };
  return {
    log: () => {},
    warn: (message: unknown, ...extra: unknown[]) => write('warn', message, extra),
    error: (message: unknown, ...extra: unknown[]) => write('error', message, extra),
  };
}
