import { describe, expect, it } from 'vitest';
import { nextAttemptAt, type RetryPolicy } from '../src/outbox/retry-policy.js';
import { parseRetryAfter } from '../src/satusehat/transport.js';

/** The #13 parameters. */
const policy: RetryPolicy = { maxAttempts: 15, backoffBaseMs: 1_000, backoffCapMs: 60_000, retryAfterCapMs: 300_000 };
const endedAt = new Date('2026-03-02T01:00:00.000Z');
const after = (ms: number) => new Date(endedAt.getTime() + ms);

describe('when a step whose attempt failed transiently is tried again', () => {
  it('waits a full-jitter backoff: random(0, 1s·2ⁿ) after the (n+1)th attempt', () => {
    expect(nextAttemptAt(policy, { attempt: 1, endedAt, retryAfter: null }, () => 0)).toEqual(after(0));
    expect(nextAttemptAt(policy, { attempt: 1, endedAt, retryAfter: null }, () => 0.5)).toEqual(after(500));
    expect(nextAttemptAt(policy, { attempt: 3, endedAt, retryAfter: null }, () => 0.5)).toEqual(after(2_000));
    expect(nextAttemptAt(policy, { attempt: 6, endedAt, retryAfter: null }, () => 0.999)).toEqual(after(31_968));
  });

  it('never draws a backoff above 60s', () => {
    expect(nextAttemptAt(policy, { attempt: 14, endedAt, retryAfter: null }, () => 0.5)).toEqual(after(30_000));
  });

  it('honours a Retry-After when it is later than the backoff', () => {
    expect(nextAttemptAt(policy, { attempt: 1, endedAt, retryAfter: after(7_000) }, () => 0.5)).toEqual(after(7_000));
  });

  it('keeps the backoff when it is longer than the Retry-After', () => {
    expect(nextAttemptAt(policy, { attempt: 8, endedAt, retryAfter: after(2_000) }, () => 0.5)).toEqual(after(30_000));
  });

  it('clamps a Retry-After to 300s, never dead-lettering for it', () => {
    expect(nextAttemptAt(policy, { attempt: 1, endedAt, retryAfter: after(86_400_000) }, () => 0)).toEqual(after(300_000));
  });

  it('ignores a Retry-After that has passed by the time the attempt ended', () => {
    expect(nextAttemptAt(policy, { attempt: 1, endedAt, retryAfter: after(-5_000) }, () => 0.25)).toEqual(after(250));
  });

  it('gives up after the 15th attempt: retries are exhausted', () => {
    expect(nextAttemptAt(policy, { attempt: 14, endedAt, retryAfter: null }, () => 0)).toEqual(after(0));
    expect(nextAttemptAt(policy, { attempt: 15, endedAt, retryAfter: null }, () => 0)).toBe('exhausted');
    expect(nextAttemptAt(policy, { attempt: 15, endedAt, retryAfter: after(1_000) }, () => 0)).toBe('exhausted');
  });
});

describe('reading a Retry-After header', () => {
  const receivedAt = endedAt;

  it('reads delta-seconds from when the answer arrived', () => {
    expect(parseRetryAfter('7', receivedAt)).toEqual(after(7_000));
    expect(parseRetryAfter(' 0 ', receivedAt)).toEqual(after(0));
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Mon, 02 Mar 2026 01:00:45 GMT', receivedAt)).toEqual(after(45_000));
  });

  it.each([
    ['no header', null],
    ['a past HTTP date', 'Mon, 02 Mar 2026 00:59:00 GMT'],
    ['an unparseable value', 'soon'],
    ['a negative number', '-5'],
    ['a fraction', '1.5'],
    ['an ISO date, not an HTTP date', '2026-03-02T01:00:45Z'],
    ['an empty value', ''],
  ])('treats %s as absent', (_, header) => {
    expect(parseRetryAfter(header, receivedAt)).toBeNull();
  });
});
