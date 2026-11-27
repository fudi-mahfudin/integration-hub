# Tracing is process-wide, started by the entry point

Every other piece of infrastructure is built by a composition root and passed down (`CODING_STANDARDS.md`). Tracing is the exception. A preload (`node --import ./dist/instrumentation.js`) patches pg, ioredis, the HTTP server and the undici client before the app loads, and the entry point starts one tracer provider per process (`startTracing`), with the exporter wrapped by the redaction module. Code makes its own spans through the helpers in `observability/tracing.ts`, which use the global OpenTelemetry API, rather than through an injected tracer.

## Considered Options

- **A tracer provider per composition root, passed down like the log**: rejected. Auto-instrumentation patches modules once per process and reports to the global provider. With a provider per composition root, its spans and the hub's own would go to different providers, and two composition roots in one process (the test harness boots hub and worker together) would each see the other's spans or none.
- **Patching inside the composition root**: rejected. A package can only be patched before it first loads, and the composition root's own imports load pg and ioredis.
- **An injected `Tracer` alongside the global context**: rejected. Spans start deep in the steps (`ihs.lookup`), the transport and the limiter, so it would have to be threaded through every one of them. The OpenTelemetry API is built as a no-op global facade, so code that makes spans without tracing started still runs.

## Consequences

- Tracing starts once per process; a second `startTracing` throws. The instrumentations keep the first provider's tracers, so a restarted provider would get only some of the spans. A test that starts tracing has its file, and so its process, to itself.
- In tests, hub and worker share one provider and report as one service. Parentage and redaction are tested this way; the `service.name` split only exists between real processes.
- The preload is part of how a process starts: `pnpm start`, `pnpm start:worker`, the spawned test worker and the vitest workers all pass it. Started without it, a process still traces its own spans, but not pg, ioredis, HTTP server or client spans.
