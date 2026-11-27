import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTracing, type Tracing } from '../src/observability/tracing.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { SOURCE_API_KEY, TEST_SOURCES, visitStarted } from './support/events.js';
import { collectingExporter } from './support/traces.js';

// Its own file: tracing starts once per process (ADR 0008), here at a ratio of 0.
describe('sampling: parent-based, the ratio configurable (#42)', () => {
  const exporter = collectingExporter();
  let tracing: Tracing;
  let hub: BootedHub;
  let closed = false;

  const send = (headers: Record<string, string>) =>
    fetch(new URL('v1/events', hub.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SOURCE_API_KEY}`, 'idempotency-key': randomUUID(), ...headers },
      body: JSON.stringify(visitStarted()),
    });
  const sampledTraceId = randomUUID().replaceAll('-', '');

  beforeAll(async () => {
    // A ratio of 0 samples no trace that starts in the hub: only a caller's sampled trace is followed.
    tracing = startTracing({ service: 'hub', sampleRatio: 0, exporter });
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
    expect((await send({})).status).toBe(202);
    expect((await send({ traceparent: `00-${sampledTraceId}-${'1'.repeat(16)}-01` })).status).toBe(202);
    closed = true;
    await hub.close();
    await tracing.shutdown();
  });

  afterAll(async () => {
    if (!closed) {
      await hub?.close();
      await tracing?.shutdown();
    }
  });

  it('a trace that starts in the hub is not sampled at a ratio of 0, and a sampled parent is followed', () => {
    const accepts = exporter.spans.filter((s) => s.name === 'ingest.accept');
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.spanContext().traceId).toBe(sampledTraceId);
    expect(new Set(exporter.spans.map((s) => s.spanContext().traceId))).toEqual(new Set([sampledTraceId]));
  });
});

