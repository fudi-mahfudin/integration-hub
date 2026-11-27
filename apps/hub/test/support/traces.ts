import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/**
 * An in-memory span exporter for `startTracing`, as Jaeger stands in
 * production: it keeps every span it is given, after shutdown too, so a test
 * reads them once tracing has flushed.
 */
export function collectingExporter(): SpanExporter & { spans: ReadableSpan[] } {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    export(batch, resultCallback) {
      spans.push(...batch);
      resultCallback({ code: 0 });
    },
    shutdown: async () => {},
  };
}
