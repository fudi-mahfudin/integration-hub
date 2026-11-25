import { describe, expect, it } from 'vitest';
import { faultDraw, type FaultConfig } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { useMock } from './support/platform.js';

const ctx = useMock();

const visits = Array.from({ length: 20 }, (_, i) => `VISIT-D${i}`);
const config = (seed: number): FaultConfig => ({
  seed,
  rules: [{ id: 'writes', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', rate: 0.5 }],
});

/** Three creates per visit; returns each visit's statuses in send order. */
async function run(seed: number, order: string[], concurrent: boolean): Promise<Record<string, number[]>> {
  await ctx.client.reset();
  ctx.platform.forgetToken();
  await ctx.platform.bearer();
  await ctx.client.setFaults(config(seed));
  const out: Record<string, number[]> = {};
  const one = async (v: string) => {
    const statuses: number[] = [];
    out[v] = statuses;
    for (let i = 0; i < 3; i++) statuses.push((await ctx.platform.fhir('POST', '/Encounter', validEncounter(v))).status);
  };
  if (concurrent) await Promise.all(order.map(one));
  else for (const v of order) await one(v);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe('fault determinism', () => {
  it('gives every request the same fate for the same seed, however visits interleave', async () => {
    const sequential = await run(240001, visits, false);
    const interleaved = await run(240001, [...visits].reverse(), true);
    expect(interleaved).toEqual(sequential);
    const all = Object.values(sequential).flat();
    expect(all).toContain(500);
    expect(all).toContain(201);
  });

  it('gives a different pattern for a different seed', async () => {
    expect(await run(1, visits, false)).not.toEqual(await run(2, visits, false));
  });

  it('draws from a pure hash of (seed, rule id, method, identifier, nth)', () => {
    const d = faultDraw(240001, 'writes', 'POST', 'sys|VISIT-1', 1);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(1);
    expect(faultDraw(240001, 'writes', 'POST', 'sys|VISIT-1', 1)).toBe(d);
    for (const other of [
      faultDraw(240002, 'writes', 'POST', 'sys|VISIT-1', 1),
      faultDraw(240001, 'reads', 'POST', 'sys|VISIT-1', 1),
      faultDraw(240001, 'writes', 'PUT', 'sys|VISIT-1', 1),
      faultDraw(240001, 'writes', 'POST', 'sys|VISIT-2', 1),
      faultDraw(240001, 'writes', 'POST', 'sys|VISIT-1', 2),
    ]) {
      expect(other).not.toBe(d);
    }
  });

  it('realizes roughly the configured rate', () => {
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (faultDraw(5, 'r', 'GET', `k${i}`, 1) < 0.3) hits++;
    expect(hits).toBeGreaterThan(2_800);
    expect(hits).toBeLessThan(3_200);
  });
});
