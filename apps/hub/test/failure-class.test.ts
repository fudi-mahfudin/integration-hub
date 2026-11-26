import { describe, expect, it } from 'vitest';
import {
  AttemptBudgetExceeded,
  SatusehatNetworkError,
  SatusehatRequestError,
  SatusehatResponseError,
  SatusehatTimeoutError,
  TokenUnavailable,
} from '../src/satusehat/errors.js';
import { AttemptFailed } from '../src/steps/step-outcome.js';
import { classifyFailure } from '../src/worker/failure-class.js';

const url = new URL('https://satusehat.test/fhir-r4/v1/Encounter');
const answered = (status: number, retryAfter: Date | null = null) => new SatusehatRequestError('POST', url, status, '{}', retryAfter);
const facts = { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };

describe('failure classification (#13)', () => {
  it.each([500, 502, 503, 504, 408, 429, 401])('a %i answer is transient', (status) => {
    expect(classifyFailure(answered(status))).toEqual({ transient: 'failed', retryAfter: null });
  });

  it('a transient answer carries its Retry-After', () => {
    const at = new Date('2026-03-02T01:00:45Z');
    expect(classifyFailure(answered(429, at))).toEqual({ transient: 'failed', retryAfter: at });
    expect(classifyFailure(answered(503, at))).toEqual({ transient: 'failed', retryAfter: at });
  });

  it('a 403 is permanent: PLATFORM_FORBIDDEN', () => {
    expect(classifyFailure(answered(403))).toEqual({ permanent: 'PLATFORM_FORBIDDEN' });
  });

  it.each([400, 404, 409, 410, 412, 422, 415])('any other 4xx (%i) is permanent: PAYLOAD_INVALID', (status) => {
    expect(classifyFailure(answered(status))).toEqual({ permanent: 'PAYLOAD_INVALID' });
  });

  it.each([
    ['a timeout', new SatusehatTimeoutError('GET', url, 2_000, { cause: new Error('aborted') })],
    ['a network error or reset', new SatusehatNetworkError('GET', url, { cause: new Error('ECONNRESET') })],
    ['an unreadable 2xx body', new SatusehatResponseError('GET', url, 'a body that is not JSON')],
    ['no token to send', new TokenUnavailable('the token endpoint is backing off until 2026-03-02T01:01:00.000Z')],
    ['an unforeseen error', new Error('connection terminated unexpectedly')],
  ])('%s is transient', (_, err) => {
    expect(classifyFailure(err)).toEqual({ transient: 'failed', retryAfter: null });
  });

  it('a spent attempt budget ends the attempt transient, as attempt_budget_exceeded', () => {
    expect(classifyFailure(new AttemptBudgetExceeded('GET', url, 1_500, 2_000))).toEqual({ transient: 'attempt_budget_exceeded', retryAfter: null });
  });

  it('looks through the AttemptFailed a step wraps its failure in', () => {
    expect(classifyFailure(new AttemptFailed(facts, { cause: answered(403) }))).toEqual({ permanent: 'PLATFORM_FORBIDDEN' });
    const at = new Date('2026-03-02T01:00:03Z');
    expect(classifyFailure(new AttemptFailed(facts, { cause: answered(503, at) }))).toEqual({ transient: 'failed', retryAfter: at });
  });
});
