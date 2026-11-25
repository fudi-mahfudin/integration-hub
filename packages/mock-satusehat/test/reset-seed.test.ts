import { describe, expect, it } from 'vitest';
import type { WorldPatient } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, NIK, useMock, world } from './support/platform.js';

const ctx = useMock();

const extraPatient: WorldPatient = {
  ihs: 'P9999999901',
  nik: '9999999999999901',
  motherNik: null,
  name: 'Tambahan Uji Fiktif',
  birthDate: '1990-01-01',
  gender: 'female',
};
const findPatient = async (nik: string) =>
  (await ctx.platform.fhir('GET', `/Patient?identifier=${encodeURIComponent(`${NIK}|${nik}`)}`)).body.total;

describe('seed and reset', () => {
  it('serves seeded entries next to the world until the next reset', async () => {
    await ctx.client.seed({ patients: [extraPatient] });
    expect(await findPatient(extraPatient.nik)).toBe(1);
    expect(await findPatient(world.patients[0]!.nik)).toBe(1);

    await ctx.client.reset();
    ctx.platform.forgetToken(); // reset also drops issued tokens
    expect(await findPatient(extraPatient.nik)).toBe(0);
    expect(await findPatient(world.patients[0]!.nik)).toBe(1);
  });

  it('accepts an Encounter for a seeded organization (via a seeded location) until reset', async () => {
    await ctx.client.seed({ locations: [{ id: 'LOC-ORG2', name: 'Cabang', organizationId: '99000002' }] });
    expect((await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-ORG2', '99000002'))).status).toBe(201);
    await ctx.client.reset();
    ctx.platform.forgetToken();
    expect((await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-ORG2', '99000002'))).status).toBe(400);
  });

  it('clears stored records, issued tokens and the report on reset', async () => {
    const token = await ctx.platform.bearer();
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-X'));
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-X'));
    expect((await ctx.client.report()).duplicateSubmissions).toHaveLength(1);

    await ctx.client.reset();
    expect((await ctx.platform.fhir('GET', '/Location?_id=x', undefined, token)).status).toBe(401);
    ctx.platform.forgetToken();
    const q = `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|VISIT-X`)}`;
    expect((await ctx.platform.fhir('GET', q)).body.total).toBe(0);
    expect((await ctx.client.report()).duplicateSubmissions).toEqual([]);
  });
});
