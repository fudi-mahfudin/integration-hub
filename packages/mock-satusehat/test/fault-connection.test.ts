import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, useMock } from './support/platform.js';

const ctx = useMock();

const createRule = (kind: string, params?: object) => ({
  seed: 1,
  rules: [{ id: kind, match: { method: 'POST', resourceType: 'Encounter' }, kind, firstN: 1, params }] as never,
});

/** POST /Encounter as an adapter with a client timeout would; resolves to the status or the error name. */
async function post(visitKey: string, timeoutMs?: number): Promise<number | string> {
  try {
    const res = await fetch(`${ctx.mock.baseUrl}/fhir-r4/v1/Encounter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await ctx.platform.bearer()}` },
      body: JSON.stringify(validEncounter(visitKey)),
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    return res.status;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code ?? err.name);
  }
}

/** The mock logs a dropped request once the client hangs up, so read the log until it shows up. */
async function encounterEntries(count: number): Promise<LogEntry[]> {
  for (let i = 0; i < 200; i++) {
    const log = await ctx.client.log({ resourceType: 'Encounter' });
    if (log.length >= count) return log;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`expected ${count} Encounter log entries`);
}

const stored = async (visitKey: string) =>
  (await ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${visitKey}`)}`)).body.total;

describe('connection-level faults', () => {
  it('timeout: holds the request past the client timeout, then drops it unapplied', async () => {
    await ctx.client.setFaults(createRule('timeout'));
    expect(await post('VISIT-T1', 200)).toBe('timeout');
    const [entry] = await encounterEntries(1);
    expect([entry!.response.status, entry!.fault, entry!.effect, entry!.visitKey]).toEqual([0, 'timeout', 'none', 'VISIT-T1']);
    // Logged when the client hung up, so a retry after the timeout never overlaps it.
    expect(Date.parse(entry!.respondedAt) - Date.parse(entry!.receivedAt)).toBeLessThan(2_000);
    expect(await stored('VISIT-T1')).toBe(0);
  });

  it('timeout: drops the connection after params.ms if the client never gives up', async () => {
    await ctx.client.setFaults(createRule('timeout', { ms: 100 }));
    const started = Date.now();
    expect(await post('VISIT-T2')).toMatch(/SocketError|ECONNRESET|UND_ERR_SOCKET/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('connection_reset: resets the connection at once, unapplied', async () => {
    await ctx.client.setFaults(createRule('connection_reset'));
    expect(await post('VISIT-R1')).toMatch(/SocketError|ECONNRESET|UND_ERR_SOCKET/);
    const [entry] = await encounterEntries(1);
    expect([entry!.response.status, entry!.fault, entry!.effect]).toEqual([0, 'connection_reset', 'none']);
    expect(await stored('VISIT-R1')).toBe(0);
  });

  it('timeout_after_apply: stores the record, then never answers', async () => {
    await ctx.client.setFaults(createRule('timeout_after_apply'));
    expect(await post('VISIT-A1', 200)).toBe('timeout');
    const [entry] = await encounterEntries(1);
    expect([entry!.response.status, entry!.fault, entry!.effect]).toEqual([0, 'timeout_after_apply', 'created']);
    expect(await stored('VISIT-A1')).toBe(1);
  });

  it('http_500_after_apply: stores the record, then answers 500', async () => {
    await ctx.client.setFaults(createRule('http_500_after_apply'));
    expect(await post('VISIT-A2')).toBe(500);
    const [entry] = await encounterEntries(1);
    expect([entry!.response.status, entry!.fault, entry!.effect]).toEqual([500, 'http_500_after_apply', 'created']);
    expect(await stored('VISIT-A2')).toBe(1);
  });

  it('a request faulted after apply counts as an effect in the report; one faulted before does not', async () => {
    await ctx.client.setFaults({
      seed: 1,
      rules: [
        { id: 'before', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 },
        { id: 'after', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500_after_apply', firstN: 1 },
      ],
    });
    // 1st: `before` fires. 2nd: `before` is spent, `after` (its 1st match) fires. 3rd: clean.
    expect([await post('VISIT-A3'), await post('VISIT-A3'), await post('VISIT-A3')]).toEqual([500, 500, 201]);
    const dup = (await ctx.client.report()).duplicateSubmissions;
    expect(dup).toHaveLength(1);
    expect(dup[0]!.seqs).toHaveLength(2);
  });

  it('latency: delays a fixed time, then answers normally', async () => {
    await ctx.client.setFaults(createRule('latency', { ms: 150 }));
    const started = Date.now();
    expect(await post('VISIT-L1')).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    const [entry] = await encounterEntries(1);
    expect([entry!.fault, entry!.effect]).toEqual(['latency', 'created']);
  });

  it('latency: a uniform range stays inside its bounds', async () => {
    await ctx.client.setFaults({
      seed: 3,
      rules: [{ id: 'lat', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'latency', rate: 1, params: { minMs: 50, maxMs: 120 } }],
    });
    for (const v of ['U1', 'U2', 'U3']) {
      const started = Date.now();
      expect(await post(`VISIT-${v}`)).toBe(201);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(45);
      expect(took).toBeLessThan(400);
    }
  });
});
