import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, prescriptionWritten, TEST_SOURCES, visitStarted } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { scrapeMetrics, valueOf } from './support/metrics.js';

const HOUR = 3_600_000;

describe('hub service metrics: ingest and database state on its own /metrics (#41)', () => {
  let database: FreshDatabase;
  let hub: BootedHub;
  let offsetMs = 0;
  /** The hub's clock, moved forward by `offsetMs`. */
  const clock = () => new Date(Date.now() + offsetMs);

  beforeAll(async () => {
    database = await createFreshDatabase();
    // No worker: a step made ready stays claimable.
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, DATABASE_URL: database.url }, clock);
  });

  afterAll(async () => {
    await hub?.close();
    await database?.drop();
  });

  it('counts ingest requests by event type and status, duplicates by event type, and rejections by code', async () => {
    const key = randomUUID();
    const started = visitStarted();
    expect((await postEvent(hub.baseUrl, { body: started, idempotencyKey: key })).status).toBe(202);
    expect((await postEvent(hub.baseUrl, { body: started, idempotencyKey: key })).status).toBe(202);
    expect((await postEvent(hub.baseUrl, { apiKey: null })).status).toBe(401);
    expect((await postEvent(hub.baseUrl, { body: { ...started, data: { ...started.data, startedAt: 'not a time' } } })).status).toBe(422);

    const samples = await scrapeMetrics(hub.baseUrl);
    expect(valueOf(samples, 'ingest_request_duration_seconds_count', { event_type: 'visit.started', status: '202' })).toBe(2);
    expect(valueOf(samples, 'ingest_request_duration_seconds_count', { event_type: 'unknown', status: '401' })).toBe(1);
    expect(valueOf(samples, 'ingest_request_duration_seconds_count', { event_type: 'visit.started', status: '422' })).toBe(1);
    expect(valueOf(samples, 'ingest_duplicates_total', { event_type: 'visit.started' })).toBe(1);
    expect(valueOf(samples, 'ingest_rejections_total', { code: 'UNAUTHENTICATED' })).toBe(1);
    expect(valueOf(samples, 'ingest_rejections_total', { code: 'VALIDATION_FAILED' })).toBe(1);
  });

  it('shows cases by status, stalled cases, and the claimable steps with their lag, as of the scrape', async () => {
    const before = await scrapeMetrics(hub.baseUrl);
    expect((await postEvent(hub.baseUrl, { body: prescriptionWritten() })).status).toBe(202);

    const now = await scrapeMetrics(hub.baseUrl);
    expect(valueOf(now, 'cases', { status: 'waiting' }) - valueOf(before, 'cases', { status: 'waiting' })).toBe(1);
    // The first test's visit.started made its create visit step ready.
    expect(valueOf(now, 'outbox_claimable_steps', { step: 'create_visit' })).toBe(1);
    expect(valueOf(now, 'outbox_claimable_steps', { step: 'submit_prescription' })).toBe(0);
    expect(valueOf(now, 'cases_stalled')).toBe(0);
    expect(valueOf(now, 'outbox_lag_seconds', { step: 'create_visit' })).toBeLessThan(60);
    expect(now.filter((s) => s.name === 'cases').map((s) => s.labels.status).sort()).toEqual(['abandoned', 'active', 'completed', 'dead_lettered', 'waiting']);

    offsetMs = 25 * HOUR;
    const later = await scrapeMetrics(hub.baseUrl);
    expect(valueOf(later, 'cases_stalled')).toBe(valueOf(later, 'cases', { status: 'waiting' }));
    expect(valueOf(later, 'cases_stalled')).toBeGreaterThan(0);
    expect(valueOf(later, 'outbox_lag_seconds', { step: 'create_visit' })).toBeGreaterThan(24 * 3600);
    expect(valueOf(later, 'cases_dead_lettered_oldest_age_seconds')).toBe(0);
    expect(later.some((s) => s.name === 'reconciliation_last_completed_timestamp_seconds')).toBe(false);
    expect(valueOf(later, 'reconciliation_divergences')).toBe(0);
  });
});
