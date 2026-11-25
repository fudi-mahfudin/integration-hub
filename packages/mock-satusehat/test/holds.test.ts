import { describe, expect, it } from 'vitest';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, useMock } from './support/platform.js';

const ctx = useMock();

const holdCreates = { seed: 1, rules: [{ id: 'park', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'hold' as const, firstN: 1 }] };
const stored = async (visitKey: string) =>
  (await ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${visitKey}`)}`)).body.total;

describe('holds', () => {
  it('parks a matching request until released, then lets it through', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults(holdCreates);
    const pending = ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-H1'));

    const hold = await ctx.client.nextHold(2_000);
    expect(hold).toMatchObject({ ruleId: 'park', method: 'POST', path: '/fhir-r4/v1/Encounter', visitKey: 'VISIT-H1' });
    expect(await stored('VISIT-H1')).toBe(0);

    await ctx.client.releaseHold(hold.id);
    expect((await pending).status).toBe(201);
    expect(await ctx.client.holds()).toEqual([]);
    const entries = await ctx.client.log({ visitKey: 'VISIT-H1' });
    expect(entries.find((e) => e.method === 'POST')).toMatchObject({ fault: 'park', effect: 'created' });
  });

  it('returns no holds once the wait runs out', async () => {
    const started = Date.now();
    expect(await ctx.client.holds(100)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('refuses to release an unknown hold', async () => {
    await expect(ctx.client.releaseHold('h-nope')).rejects.toThrow(/404/);
  });

  it('reset drops parked requests unapplied and clears the rules', async () => {
    await ctx.platform.bearer();
    await ctx.client.setFaults(holdCreates);
    const pending = ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-H2')).then(
      (r) => r.status,
      () => 'dropped',
    );
    await ctx.client.nextHold(2_000);

    await ctx.client.reset();
    expect(await pending).toBe('dropped');
    expect(await ctx.client.holds()).toEqual([]);
    expect(await ctx.client.log()).toEqual([]); // a pre-reset request never lands in the new log
    ctx.platform.forgetToken();
    expect((await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-H2'))).status).toBe(201);
    expect((await ctx.client.report()).faultSeed).toBeNull();
  });
});
