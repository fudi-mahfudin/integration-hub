import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { k6Options } from '../src/loadtest/k6.js';
import { loadLoadTestSettings } from '../src/loadtest/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));

describe('k6Options', () => {
  it('holds the committed thresholds, on the measured phase only', () => {
    expect(k6Options(loadLoadTestSettings(committed, []).loadTest).thresholds).toEqual({
      'http_req_duration{scenario:load}': ['p(95)<200', 'p(99)<500'],
      'ingest_non_2xx{scenario:load}': ['rate<0.001'],
    });
  });

  it('runs a warm-up then the measured phase, each a constant arrival rate of the committed events per second', () => {
    const { scenarios } = k6Options(loadLoadTestSettings(committed, []).loadTest);
    expect(scenarios.warmup).toMatchObject({ executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '30s', startTime: '0s' });
    expect(scenarios.load).toMatchObject({ executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '300s', startTime: '30s' });
  });

  it('follows an override, and leaves out a warm-up of zero seconds', () => {
    const { loadTest } = loadLoadTestSettings(committed, ['--set', 'warmUpSeconds=0', '--set', 'thresholds.ingestP95Ms=150']);
    const options = k6Options(loadTest);
    expect(options.scenarios.warmup).toBeUndefined();
    expect(options.scenarios.load).toMatchObject({ startTime: '0s' });
    expect(options.thresholds['http_req_duration{scenario:load}']).toEqual(['p(95)<150', 'p(99)<500']);
  });
});
