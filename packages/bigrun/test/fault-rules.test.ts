import { MockSatusehatClient, type FaultRulesInput } from '@integration-hub/mock-satusehat/client';
import { createMockSatusehat } from '@integration-hub/mock-satusehat/server';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { faultRulesFor } from '../src/fault-rules.js';
import { loadSettings } from '../src/settings.js';

const { bigRun } = loadSettings(JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8')), []);
const world = await loadWorld(DEFAULT_WORLD_PATH);

/**
 * The committed rules with every hold cut to 1ms. Whether a rule hits depends
 * only on the seed, its id, the request's identifier and count, never on its
 * params, so the realized shares are those of the committed rules.
 */
function withShortHolds(rules: FaultRulesInput): FaultRulesInput {
  return {
    ...rules,
    rules: rules.rules.map((rule) => ('params' in rule && rule.params !== undefined && 'ms' in rule.params ? { ...rule, params: { ms: 1 } } : rule)),
  } as FaultRulesInput; // the same rule with a smaller hold, so still a valid rule
}

/** Sends `count` requests, `at once` at a time, ignoring cut connections: the log records what happened. */
async function fire(count: number, request: (i: number) => Promise<Response>): Promise<Response[]> {
  const answered: Response[] = [];
  for (let i = 0; i < count; i += 50) {
    const batch = await Promise.all(Array.from({ length: Math.min(50, count - i) }, (_, j) => request(i + j).catch(() => null)));
    for (const res of batch) if (res) answered.push(res);
  }
  return answered;
}

const share = (part: number, whole: number) => part / whole;
const tokenOf = async (res: Response) => z.object({ access_token: z.string() }).parse(await res.json()).access_token;

describe('faultRulesFor', () => {
  let close: () => Promise<void>;
  let baseUrl: URL;
  let client: MockSatusehatClient;
  let token: string;

  beforeAll(async () => {
    const mock = await createMockSatusehat(
      { host: '127.0.0.1', port: 0, worldPath: DEFAULT_WORLD_PATH, tokenExpiresInSeconds: 3599, tokenThrottleWindowSeconds: 60 },
      { clock: () => new Date() },
    );
    baseUrl = await mock.listen();
    close = () => mock.close();
    client = new MockSatusehatClient(baseUrl);
    const res = await fetch(new URL('oauth2/v1/accesstoken?grant_type=client_credentials', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
    });
    token = await tokenOf(res);
    await client.setFaults(withShortHolds(faultRulesFor(bigRun)));
  });

  afterAll(() => close());

  it('carries the committed seed', async () => {
    expect(faultRulesFor(bigRun).seed).toBe(20261125);
    expect((await client.report()).faultSeed).toBe(20261125);
  });

  it('faults reads (FHIR searches and KFA) at each committed weight, and splits the Retry-After variants as committed', async () => {
    const location = world.locations[0]?.id ?? '';
    const reads = 4000;
    const answers = await fire(reads, (i) =>
      fetch(new URL(i % 4 === 0 ? `kfa-v2/products?identifier=kfa&code=93000001` : `fhir-r4/v1/Location?_id=${location}`, baseUrl), {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const log = (await client.logNdjson()).filter((e) => e.method === 'GET');
    expect(log).toHaveLength(reads);
    const faulted = log.filter((e) => e.fault !== null);
    expect(share(faulted.length, reads)).toBeCloseTo(0.3, 1);
    for (const kind of ['http_500', 'http_503', 'http_429', 'timeout', 'connection_reset']) {
      const ofKind = faulted.filter((e) => e.fault?.split(':')[1] === kind).length;
      expect(Math.abs(share(ofKind, reads) - 0.06), kind).toBeLessThan(0.015);
    }
    expect(faulted.some((e) => e.resourceType === 'KfaProduct')).toBe(true);

    const unavailable = answers.filter((r) => r.status === 503);
    expect(Math.abs(share(unavailable.filter((r) => r.headers.has('retry-after')).length, unavailable.length) - 0.5)).toBeLessThan(0.1);
    const throttled = answers.filter((r) => r.status === 429).map((r) => r.headers.get('retry-after'));
    const forms = { absent: throttled.filter((v) => v === null).length, seconds: throttled.filter((v) => v === '1').length };
    const httpDate = throttled.length - forms.absent - forms.seconds;
    for (const count of [forms.absent, forms.seconds, httpDate]) expect(Math.abs(share(count, throttled.length) - 1 / 3)).toBeLessThan(0.1);
  });

  it('faults FHIR writes at each committed weight, and never the token endpoint', async () => {
    await client.reset();
    await client.setFaults(withShortHolds(faultRulesFor(bigRun)));
    const writes = 3000;
    const encounter = (i: number) => ({
      resourceType: 'Encounter',
      identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`, value: `V-FAULTS-${i}` }],
      status: 'arrived',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      subject: { reference: `Patient/${world.patients[0]?.ihsNumber}` },
      participant: [{ individual: { reference: `Practitioner/${world.practitioners[0]?.ihsNumber}` } }],
      period: { start: '2026-03-02T01:00:00+00:00' },
      location: [{ location: { reference: `Location/${world.locations[0]?.id}` } }],
      statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
      serviceProvider: { reference: `Organization/${world.organization.id}` },
    });
    const fresh = await fetch(new URL('oauth2/v1/accesstoken?grant_type=client_credentials', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
    });
    const writeToken = await tokenOf(fresh);
    await fire(writes, (i) =>
      fetch(new URL('fhir-r4/v1/Encounter', baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(encounter(i)),
      }),
    );
    const tokens = await fire(200, () =>
      fetch(new URL('oauth2/v1/accesstoken?grant_type=client_credentials', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
      }),
    );
    expect(tokens.map((r) => r.status)).toEqual(tokens.map(() => 200));

    const log = await client.logNdjson();
    expect(log.filter((e) => e.resourceType === null && e.fault !== null)).toEqual([]);
    const posts = log.filter((e) => e.method === 'POST' && e.resourceType === 'Encounter');
    expect(posts).toHaveLength(writes);
    const faulted = posts.filter((e) => e.fault !== null);
    expect(share(faulted.length, writes)).toBeCloseTo(0.3, 1);
    const weights = { timeout_after_apply: 7, http_500_after_apply: 7, http_500: 4, http_503: 4, http_429: 4, timeout: 2, connection_reset: 2 };
    for (const [kind, weight] of Object.entries(weights)) {
      const ofKind = faulted.filter((e) => e.fault?.split(':')[1] === kind).length;
      expect(Math.abs(share(ofKind, writes) - weight / 100), kind).toBeLessThan(0.015);
    }
  });

  it('holds a timeout past the committed call timeout, so the hub gives up first', () => {
    const holds = faultRulesFor(bigRun).rules.flatMap((rule) =>
      'params' in rule && rule.params !== undefined && 'ms' in rule.params ? [rule.params.ms] : [],
    );
    expect(holds.length).toBeGreaterThan(0);
    for (const ms of holds) expect(ms).toBeGreaterThan(bigRun.mockProfile.callTimeoutSeconds * 1000);
  });

  it('faults PUTs of an Encounter like any other write', () => {
    const puts = faultRulesFor(bigRun).rules.filter((rule) => rule.match.method === 'PUT');
    expect(puts.map((rule) => rule.match.resourceType)).toEqual(Object.keys(bigRun.faults.writes.weights).map(() => 'Encounter'));
  });
});
