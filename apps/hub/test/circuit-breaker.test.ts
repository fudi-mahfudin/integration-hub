import { describe, expect, it } from 'vitest';
import { CircuitOpen } from '../src/satusehat/errors.js';
import { createWorkerMetrics } from '../src/observability/metrics.js';
import { createCircuitBreaker, type CircuitBreaker } from '../src/satusehat/circuit-breaker.js';

/** A clock the test moves by hand. */
function manualClock(start = Date.parse('2026-03-02T01:00:00Z')) {
  let now = start;
  return { clock: () => new Date(now), advance: (ms: number) => (now += ms) };
}

/** Breaker openings these tests don't count; the metrics test passes real worker metrics. */
const uncounted = { breakerOpened: () => {} };

/** Makes `n` calls through `breaker`, each reported healthy or not. */
function calls(breaker: CircuitBreaker, n: number, healthy: boolean) {
  for (let i = 0; i < n; i++) breaker.admit()(healthy);
}

describe('the circuit breaker of one platform API (#13)', () => {
  it('opens at 50% health failures over at least 20 calls, and then refuses calls', () => {
    const { clock } = manualClock();
    const breaker = createCircuitBreaker({ api: 'fhir', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 10, true);
    calls(breaker, 9, false);
    expect(breaker.isOpen()).toBe(false);

    calls(breaker, 1, false);

    expect(breaker.isOpen()).toBe(true);
    expect(() => breaker.admit()).toThrow(CircuitOpen);
  });

  it('does not open on fewer than 20 calls, however many fail', () => {
    const { clock } = manualClock();
    const breaker = createCircuitBreaker({ api: 'fhir', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 19, false);
    expect(breaker.isOpen()).toBe(false);
  });

  it('does not open below 50% failures', () => {
    const { clock } = manualClock();
    const breaker = createCircuitBreaker({ api: 'kfa', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 11, true);
    calls(breaker, 10, false);
    expect(breaker.isOpen()).toBe(false);
  });

  it('only counts calls of the last 10s', () => {
    const { clock, advance } = manualClock();
    const breaker = createCircuitBreaker({ api: 'fhir', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 15, false);
    advance(10_001);
    calls(breaker, 10, false);
    expect(breaker.isOpen()).toBe(false);
    calls(breaker, 10, false);
    expect(breaker.isOpen()).toBe(true);
  });

  it('after 30s open, admits one probe: a healthy one closes it', () => {
    const { clock, advance } = manualClock();
    const breaker = createCircuitBreaker({ api: 'auth', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 20, false);
    advance(29_999);
    expect(() => breaker.admit()).toThrow(CircuitOpen);
    advance(1);
    expect(breaker.isOpen()).toBe(false);

    const probe = breaker.admit();
    // While the probe is out, no other call is admitted.
    expect(() => breaker.admit()).toThrow(CircuitOpen);
    probe(true);

    expect(breaker.isOpen()).toBe(false);
    // Closed afresh: the failures before it no longer count.
    calls(breaker, 19, false);
    expect(breaker.isOpen()).toBe(false);
  });

  it('a failed probe opens it again for another 30s', () => {
    const { clock, advance } = manualClock();
    const breaker = createCircuitBreaker({ api: 'fhir', clock, openMs: 30_000, log: () => {}, metrics: uncounted });
    calls(breaker, 20, false);
    advance(30_000);

    breaker.admit()(false);

    expect(breaker.isOpen()).toBe(true);
    advance(29_999);
    expect(breaker.isOpen()).toBe(true);
    advance(1);
    expect(breaker.isOpen()).toBe(false);
  });

  it('shows its state (0 closed, 1 half-open, 2 open) and counts its openings in the worker metrics (#41)', async () => {
    const { clock, advance } = manualClock();
    let breaker: CircuitBreaker | undefined;
    const metrics = createWorkerMetrics({ breakerStates: () => ({ fhir: breaker?.state() ?? 'closed', kfa: 'closed', auth: 'closed' }) });
    breaker = createCircuitBreaker({ api: 'fhir', clock, openMs: 30_000, log: () => {}, metrics });
    const shown = async () => {
      const text = await metrics.scrape();
      return {
        state: /^circuit_breaker_state\{upstream="fhir"\} (\d+)$/m.exec(text)?.[1],
        opens: /^circuit_breaker_opens_total\{upstream="fhir"\} (\d+)$/m.exec(text)?.[1] ?? '0',
      };
    };
    expect(await shown()).toEqual({ state: '0', opens: '0' });

    calls(breaker, 20, false);
    expect(await shown()).toEqual({ state: '2', opens: '1' });
    advance(30_000);
    expect(await shown()).toEqual({ state: '1', opens: '1' });
    breaker.admit()(false);
    expect(await shown()).toEqual({ state: '2', opens: '2' });
    advance(30_000);
    breaker.admit()(true);
    expect(await shown()).toEqual({ state: '0', opens: '2' });
  });
});
