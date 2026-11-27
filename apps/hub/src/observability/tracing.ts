import {
  context,
  createContextKey,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';
import type { Brand } from '../brand.js';
import type { CaseId } from '../cases/case-model.js';
import type { Service } from './log.js';
import { redactingSpanExporter } from './redaction.js';

// Traces (#15, #42): OpenTelemetry for traces only. Tracing is process-wide
// (ADR 0008): one tracer provider per process, started by the entry point,
// so the spans the auto-instrumentation makes and the hub's own reach the
// same exporter. Code makes spans through the helpers below.
//
// `case.id`: every span under a case's context (`inCaseTrace`: an attempt, a
// reconciliation check) gets it; at ingest, the case is only known once its
// transaction has recorded the event, so only the server and `ingest.accept`
// spans of an accepted event carry it, not the queries before it.

/**
 * The W3C `traceparent` of the ingest span that accepted a source event,
 * stored on the event, so the attempts of its step join that event's trace.
 */
export type Traceparent = Brand<string, 'Traceparent'>;

/** A process's running tracing. */
export interface Tracing {
  /** Exports the spans still buffered, then stops exporting; tracing can't start again in this process. */
  shutdown(): Promise<void>;
}

/** The context value every span started under a case's context copies into its `case.id` attribute. */
const CASE_ID = createContextKey('integration-hub.case.id');

/** The tracer the hub's own spans come from; asked for at each use, so it is the provider's running now. */
const tracer = () => trace.getTracer('integration-hub');

const propagator = new W3CTraceContextPropagator();

/** Gives every span started under a case's context the case's id, the auto-instrumented ones included. */
const caseIdProcessor: SpanProcessor = {
  onStart(span, parentContext) {
    const caseId = parentContext.getValue(CASE_ID);
    if (typeof caseId === 'string') span.setAttribute('case.id', caseId);
  },
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
};

/**
 * Starts tracing in this process: parent-based sampling of `sampleRatio` of
 * the traces that start here (#15: 1 by default), W3C trace context
 * propagation, and every span redacted on its way to `exporter`. Only entry
 * points (and the tests standing in for them) call this, once per process: a
 * second call throws.
 */
export function startTracing(options: { service: Service; sampleRatio: number; exporter: SpanExporter }): Tracing {
  const { service, sampleRatio, exporter } = options;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': service }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
    spanProcessors: [caseIdProcessor, new BatchSpanProcessor({ exporter: redactingSpanExporter(exporter) })],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const registered = [context.setGlobalContextManager(contextManager), propagation.setGlobalPropagator(propagator), trace.setGlobalTracerProvider(provider)];
  // Once per process: the instrumentations keep the first provider's tracers, so a second would trace half its spans.
  if (registered.includes(false)) throw new Error('tracing was already started in this process; it starts once per process');
  return { shutdown: () => provider.shutdown() };
}

/**
 * Runs `run` in a new span named `name`, a child of the active span, and
 * ends the span when `run` settles. A throw is recorded on the span (as an
 * exception, and an error status with its message) and rethrown.
 */
export function inSpan<T>(name: string, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await run(span);
    } catch (err) {
      failSpan(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Marks `span` failed by `err`: an exception event and an error status with its message. */
export function failSpan(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

/** Records a span that is already over: from `startTime` until now, a child of the active span. */
export function recordEndedSpan(name: string, attributes: Attributes, startTime: Date): void {
  tracer().startSpan(name, { attributes, startTime }).end();
}

/** Sets `attributes` on the active span, if there is one. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** Names the active server span after its route template (`POST /v1/events`), never the raw path. */
export function nameServerSpan(method: string, route: string): void {
  const span = trace.getActiveSpan();
  span?.updateName(`${method} ${route}`);
  span?.setAttribute('http.route', route);
}

/** The `traceparent` of the active span, to store; null when nothing is traced. */
export function activeTraceparent(): Traceparent | null {
  const carrier: Record<string, string> = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);
  // The propagator writes only a well-formed W3C traceparent.
  return (carrier.traceparent as Traceparent | undefined) ?? null;
}

/**
 * Runs `run` in the trace of the ingest span `traceparent` names (a new
 * trace when null), with `caseId` on every span started under it.
 */
export function inCaseTrace<T>(traceparent: Traceparent | null, caseId: CaseId, run: () => Promise<T>): Promise<T> {
  const parent: Context = traceparent === null ? ROOT_CONTEXT : propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
  return context.with(parent.setValue(CASE_ID, caseId), run);
}
