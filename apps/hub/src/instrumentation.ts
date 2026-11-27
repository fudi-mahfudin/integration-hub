// Auto-instrumentation (#42), preloaded with `node --import` before the entry
// point. It only patches: spans reach no exporter until the entry point
// starts tracing (`observability/tracing.ts`), and are no-ops without it.
//
// Self-contained (no relative imports), so Node can run it from `src` too:
// the test runner preloads it as TypeScript.
import { createRequire } from 'node:module';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

registerInstrumentations({
  instrumentations: [
    // Server spans for the hub API only: not `/metrics` scrapes, health probes, or (in tests) the mock in the same process.
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => !(req.url ?? '').startsWith('/v1/'),
      // The hub's HTTP client is undici, instrumented below.
      disableOutgoingRequestInstrumentation: true,
    }),
    // SATUSEHAT, KFA and token calls, within an attempt. The redacting exporter cuts the query off the URL (#15).
    new UndiciInstrumentation({ requireParentforSpans: true }),
    // Statement text only: Kysely sends values as parameters, and parameters are never recorded.
    new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
    // The command name only: keys and arguments may name a source system's idempotency key.
    new IORedisInstrumentation({ requireParentSpan: true, dbStatementSerializer: (commandName) => commandName }),
  ],
});

// The instrumentations patch a CommonJS package as it is `require`d. An ESM
// `import` of one doesn't go through `require`, but loads the same module
// instance once it is cached, so they are required here, patched, first.
const require = createRequire(import.meta.url);
require('pg');
require('ioredis');
