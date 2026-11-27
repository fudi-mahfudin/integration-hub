import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessToken, bootMock, createdId, encounter, fhir, manualClock, medicationDispense, medicationRequest, requestToken, world, type BootedMock,
} from './support/boot-mock.js';

const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

describe('fault rules', () => {
  const clock = manualClock(new Date('2026-03-02T01:00:00Z'));
  let mock: BootedMock;
  let token: string;

  beforeAll(async () => {
    mock = await bootMock({}, clock);
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => {
    await mock.client.reset();
    token = await accessToken(mock.baseUrl);
  });

  const search = (visitKey: string) => fhir(mock.baseUrl, token, `Encounter?identifier=${ENCOUNTER_SYSTEM}|${visitKey}`);

  it('answers a matching request with a 500 instead of applying it, logs the rule id, and the report echoes the seed', async () => {
    await mock.client.setFaults({
      seed: 7,
      rules: [{ id: 'enc-500', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 }],
    });

    const faulted = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-500'));
    const next = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-500'));

    expect(faulted.status).toBe(500);
    expect(await faulted.json()).toMatchObject({ resourceType: 'OperationOutcome' });
    expect(next.status).toBe(201);
    expect(await (await search('V-500')).json()).toMatchObject({ total: 1 });
    const [first, second] = await mock.client.log({ visitKey: 'V-500', resourceType: 'Encounter' });
    expect(first).toMatchObject({ fault: 'enc-500', effect: 'none', response: { status: 500 } });
    expect(second).toMatchObject({ fault: null, effect: 'created' });
    expect(await mock.client.report()).toEqual({ faultSeed: 7, duplicates: [], outOfOrder: [], overlap: [] });
  });

  it('an http_400 with echoRequest echoes the request URL and body in its OperationOutcome, as a platform error may echo a NIK', async () => {
    const [patient] = world.patients;
    if (!patient) throw new Error('the world dataset needs a patient');
    await mock.client.setFaults({
      seed: 1,
      rules: [
        { id: 'echo-search', match: { method: 'GET', resourceType: 'Patient' }, kind: 'http_400', params: { echoRequest: true }, firstN: 1 },
        { id: 'echo-create', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_400', params: { echoRequest: true }, firstN: 1 },
      ],
    });

    const searched = await fhir(mock.baseUrl, token, `Patient?identifier=https://fhir.kemkes.go.id/id/nik|${patient.nik}`);
    const created = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-echo'));

    expect(searched.status).toBe(400);
    expect(JSON.stringify(await searched.json())).toContain(patient.nik);
    expect(created.status).toBe(400);
    expect(JSON.stringify(await created.json())).toContain('V-echo');
  });

  it.each([
    ['http_503 without Retry-After', { kind: 'http_503' }, 503, null],
    ['http_503 with Retry-After seconds', { kind: 'http_503', params: { retryAfter: { form: 'seconds', seconds: 5 } } }, 503, '5'],
    ['http_429 without Retry-After', { kind: 'http_429' }, 429, null],
    ['http_429 with Retry-After seconds', { kind: 'http_429', params: { retryAfter: { form: 'seconds', seconds: 2 } } }, 429, '2'],
    ['http_429 with Retry-After as an HTTP date', { kind: 'http_429', params: { retryAfter: { form: 'http-date', seconds: 30 } } }, 429, 'Mon, 02 Mar 2026 01:00:30 GMT'],
  ] as const)('injects %s', async (_, rule, status, retryAfter) => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'r', match: { resourceType: 'Encounter' }, firstN: 1, ...rule }] });

    const res = await search('V-throttled');

    expect(res.status).toBe(status);
    expect(res.headers.get('retry-after')).toBe(retryAfter);
    expect(await res.json()).toMatchObject({ resourceType: 'OperationOutcome' });
  });

  it('injects a permanent 400 OperationOutcome and a 401 without applying the request', async () => {
    await mock.client.setFaults({
      seed: 1,
      rules: [
        { id: 'bad', match: { method: 'POST' }, kind: 'http_400', firstN: 1 },
        { id: 'login', match: { method: 'POST' }, kind: 'http_401', everyNth: 2 },
      ],
    });

    const rejected = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-4xx'));
    const unauthorized = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-4xx'));

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ issue: [{ details: { coding: [{ code: 'PAYLOAD_INVALID' }] } }] });
    expect(unauthorized.status).toBe(401);
    expect((await mock.client.log({ visitKey: 'V-4xx' })).map((e) => [e.fault, e.effect])).toEqual([['bad', 'none'], ['login', 'none']]);
    expect(await (await search('V-4xx')).json()).toMatchObject({ total: 0 });
  });

  it('matches the token endpoint by path like any other', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'tok', match: { path: '/oauth2/v1/accesstoken' }, kind: 'http_503', firstN: 1 }] });

    expect((await requestToken(mock.baseUrl)).status).toBe(503);
    expect((await requestToken(mock.baseUrl)).status).toBe(200);
    expect((await search('V-tok')).status).toBe(200);
  });

  it('rejects invalid fault rules with 400 and keeps the current ones', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'keep', match: {}, kind: 'http_500', firstN: 1 }] });

    await expect(
      mock.client.setFaults({ seed: 2, rules: [{ id: 'two-modes', match: {}, kind: 'http_500', firstN: 1, everyNth: 2 }] }),
    ).rejects.toMatchObject({ status: 400 });
    const withoutMs = await fetch(new URL('__mock/faults', mock.baseUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 2, rules: [{ id: 'no-ms', match: {}, kind: 'timeout', rate: 1 }] }),
    });
    expect(withoutMs.status).toBe(400);
    expect(await withoutMs.json()).toMatchObject({ error: expect.stringContaining('params') });

    await expect(
      mock.client.setFaults({
        seed: 2,
        rules: [
          { id: 'twin', match: {}, kind: 'http_500', firstN: 1 },
          { id: 'twin', match: {}, kind: 'http_503', firstN: 1 },
        ],
      }),
    ).rejects.toThrow(/twin.{0,3} more than once/);

    expect((await search('V-kept')).status).toBe(500);
    expect((await mock.client.report()).faultSeed).toBe(1);
  });

  describe('decisions', () => {
    const visits = Array.from({ length: 40 }, (_, i) => `V-det-${i}`);
    const halfOfCreates = (seed: number) =>
      mock.client.setFaults({ seed, rules: [{ id: 'half', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', rate: 0.5 }] });
    const sendTwice = (visitKey: string) =>
      fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey)).then(() => fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey)));

    /** The faulted (visit, nth create) pairs, in a stable order. */
    async function outcomes(): Promise<string[]> {
      const byVisit = new Map<string, number>();
      const faulted: string[] = [];
      for (const e of await mock.client.log({ resourceType: 'Encounter' })) {
        const nth = (byVisit.get(e.visitKey ?? '') ?? 0) + 1;
        byVisit.set(e.visitKey ?? '', nth);
        if (e.fault === 'half') faulted.push(`${e.visitKey}#${nth}`);
      }
      return faulted.sort();
    }

    it('gives the same faults for the same seed however requests interleave', async () => {
      await halfOfCreates(42);
      for (const v of visits) await sendTwice(v);
      const sequential = await outcomes();

      await mock.client.reset();
      token = await accessToken(mock.baseUrl);
      await halfOfCreates(42);
      await Promise.all([...visits].reverse().map(sendTwice));

      expect(await outcomes()).toEqual(sequential);
      expect(sequential.length).toBeGreaterThan(20);
      expect(sequential.length).toBeLessThan(60);
    });

    it('gives different faults for a different seed', async () => {
      await halfOfCreates(42);
      for (const v of visits) await sendTwice(v);
      const first = await outcomes();

      await mock.client.reset();
      token = await accessToken(mock.baseUrl);
      await halfOfCreates(43);
      for (const v of visits) await sendTwice(v);

      expect(await outcomes()).not.toEqual(first);
    });

    it('counts firstN and everyNth per identifier, not across identifiers', async () => {
      await mock.client.setFaults({
        seed: 1,
        rules: [
          { id: 'first', match: { method: 'POST' }, kind: 'http_503', firstN: 1 },
          { id: 'third', match: { method: 'POST' }, kind: 'http_500', everyNth: 3 },
        ],
      });

      const statuses = async (visitKey: string) => {
        const answers: number[] = [];
        for (let i = 0; i < 4; i++) answers.push((await fhir(mock.baseUrl, token, 'Encounter', encounter(visitKey))).status);
        return answers;
      };

      expect(await statuses('V-a')).toEqual([503, 201, 500, 201]);
      expect(await statuses('V-b')).toEqual([503, 201, 500, 201]);
    });

    it('counts a prescription and its dispense apart, though they share a business identifier', async () => {
      const encounterId = await createdId(await fhir(mock.baseUrl, token, 'Encounter', encounter('V-rx')));
      await mock.client.setFaults({ seed: 1, rules: [{ id: 'first', match: { method: 'POST' }, kind: 'http_503', firstN: 1 }] });

      const prescribe = () => fhir(mock.baseUrl, token, 'MedicationRequest', medicationRequest(encounterId, 'RX-shared'));
      expect((await prescribe()).status).toBe(503);
      const requestId = await createdId(await prescribe());
      const dispense = () => fhir(mock.baseUrl, token, 'MedicationDispense', medicationDispense(encounterId, requestId, 'RX-shared'));

      expect((await dispense()).status).toBe(503);
      expect((await dispense()).status).toBe(201);
    });
  });

  it('resets the connection without applying the request, logging no response', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'rst', match: { method: 'POST' }, kind: 'connection_reset', firstN: 1 }] });

    await expect(fhir(mock.baseUrl, token, 'Encounter', encounter('V-rst'))).rejects.toThrow();

    expect(await (await search('V-rst')).json()).toMatchObject({ total: 0 });
    const [logged] = await mock.client.log({ visitKey: 'V-rst', resourceType: 'Encounter' });
    expect(logged).toMatchObject({ fault: 'rst', effect: 'none', response: { status: null, body: null } });
  });

  it('applies the request, then answers 500: the effect counts and a search finds the record', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'late', match: { method: 'POST' }, kind: 'http_500_after_apply', firstN: 1 }] });

    const res = await fhir(mock.baseUrl, token, 'Encounter', encounter('V-late'));

    expect(res.status).toBe(500);
    expect(await (await search('V-late')).json()).toMatchObject({ total: 1 });
    const [logged] = await mock.client.log({ visitKey: 'V-late', resourceType: 'Encounter' });
    expect(logged).toMatchObject({ fault: 'late', effect: 'created', response: { status: 500 } });
  });

  /** How long `request` took to settle, in wall-clock ms, and whether it got a response. */
  async function timed(request: Promise<Response>): Promise<{ ms: number; status: number | 'cut' }> {
    const start = performance.now();
    const status = await request.then((r) => r.status, () => 'cut' as const);
    return { ms: performance.now() - start, status };
  }

  it('delays a matching request by a fixed latency, then applies it', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'slow', match: { method: 'POST' }, kind: 'latency', params: { ms: 150 }, rate: 1 }] });

    const { ms, status } = await timed(fhir(mock.baseUrl, token, 'Encounter', encounter('V-slow')));

    expect(status).toBe(201);
    expect(ms).toBeGreaterThanOrEqual(145);
    const [logged] = await mock.client.log({ visitKey: 'V-slow', resourceType: 'Encounter' });
    expect(logged).toMatchObject({ fault: 'slow', effect: 'created' });
  });

  it('delays by a latency drawn from a uniform range', async () => {
    await mock.client.setFaults({
      seed: 1,
      rules: [{ id: 'range', match: { resourceType: 'Encounter' }, kind: 'latency', params: { minMs: 60, maxMs: 120 }, rate: 1 }],
    });

    const { ms, status } = await timed(search('V-range'));

    expect(status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(55);
    expect(ms).toBeLessThan(400);
  });

  it('holds a timed-out request for its ms, then drops the connection without applying it', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'hang', match: { method: 'POST' }, kind: 'timeout', params: { ms: 150 }, firstN: 1 }] });

    const { ms, status } = await timed(fhir(mock.baseUrl, token, 'Encounter', encounter('V-hang')));

    expect(status).toBe('cut');
    expect(ms).toBeGreaterThanOrEqual(145);
    expect(await (await search('V-hang')).json()).toMatchObject({ total: 0 });
    const [logged] = await mock.client.log({ visitKey: 'V-hang', resourceType: 'Encounter' });
    expect(logged).toMatchObject({ fault: 'hang', effect: 'none', response: { status: null } });
  });

  it('logs a timed-out request once its hold ends, even when the client gave up first', async () => {
    await mock.client.setFaults({ seed: 1, rules: [{ id: 'hang', match: { method: 'POST' }, kind: 'timeout', params: { ms: 200 }, firstN: 1 }] });

    const gaveUp = await fetch(new URL('fhir-r4/v1/Encounter', mock.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(encounter('V-gave-up')),
      signal: AbortSignal.timeout(50),
    }).catch((err: unknown) => err);

    expect(gaveUp).toBeInstanceOf(DOMException);
    await vi.waitFor(async () => expect(await mock.client.log({ visitKey: 'V-gave-up' })).toHaveLength(1), { timeout: 2_000 });
    expect(await (await search('V-gave-up')).json()).toMatchObject({ total: 0 });
  });

  it('applies a request, then holds it and drops the connection: the record exists though the client saw no answer', async () => {
    await mock.client.setFaults({
      seed: 1,
      rules: [{ id: 'lost-answer', match: { method: 'POST' }, kind: 'timeout_after_apply', params: { ms: 100 }, firstN: 1 }],
    });

    const { status } = await timed(fhir(mock.baseUrl, token, 'Encounter', encounter('V-lost')));

    expect(status).toBe('cut');
    expect(await (await search('V-lost')).json()).toMatchObject({ total: 1 });
    const [logged] = await mock.client.log({ visitKey: 'V-lost', resourceType: 'Encounter' });
    expect(logged).toMatchObject({ fault: 'lost-answer', effect: 'created', response: { status: null } });
  });

  describe('holds', () => {
    const parkCreates = () =>
      mock.client.setFaults({ seed: 1, rules: [{ id: 'park', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'hold', firstN: 1 }] });

    it('parks a matching request until it is released, then applies it', async () => {
      await parkCreates();
      const waiting = mock.client.holds(2_000);

      const create = fhir(mock.baseUrl, token, 'Encounter', encounter('V-park'));
      const [hold, ...others] = await waiting;

      expect(others).toEqual([]);
      expect(hold).toMatchObject({
        id: expect.any(String), ruleId: 'park', method: 'POST', path: '/fhir-r4/v1/Encounter',
        resourceType: 'Encounter', visitKey: 'V-park', businessIdentifier: `${ENCOUNTER_SYSTEM}|V-park`,
      });
      expect(await (await search('V-park')).json()).toMatchObject({ total: 0 });

      await mock.client.releaseHold(hold?.id ?? '');

      expect((await create).status).toBe(201);
      expect(await mock.client.holds(0)).toEqual([]);
      const logged = (await mock.client.log({ visitKey: 'V-park' })).find((e) => e.method === 'POST');
      expect(logged).toMatchObject({ fault: 'park', effect: 'created' });
    });

    it('answers a wait with no parked request with an empty list once the wait is over', async () => {
      const start = performance.now();

      expect(await mock.client.holds(100)).toEqual([]);
      expect(performance.now() - start).toBeGreaterThanOrEqual(95);
    });

    it('answers 404 to releasing a hold it does not have', async () => {
      await expect(mock.client.releaseHold('no-such-hold')).rejects.toMatchObject({ status: 404 });
    });

    it('reset clears the fault rules and drops every parked request', async () => {
      await parkCreates();
      const parked = fhir(mock.baseUrl, token, 'Encounter', encounter('V-dropped')).then((r) => r.status, () => 'cut');
      expect(await mock.client.holds(2_000)).toHaveLength(1);

      await mock.client.reset();

      expect(await parked).toBe('cut');
      expect(await mock.client.holds(0)).toEqual([]);
      expect((await mock.client.report()).faultSeed).toBeNull();
      token = await accessToken(mock.baseUrl);
      expect((await fhir(mock.baseUrl, token, 'Encounter', encounter('V-dropped'))).status).toBe(201);
      expect((await mock.client.log({ resourceType: 'Encounter' })).map((e) => e.fault)).toEqual([null]);
    });
  });
});
