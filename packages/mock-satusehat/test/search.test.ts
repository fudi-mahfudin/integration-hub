import { describe, expect, it } from 'vitest';
import { encounterSystem, NIK, useMock, world } from './support/platform.js';
import { validEncounter } from './support/encounters.js';

describe('search', () => {
  const ctx = useMock();
  const patient = world.patients[5]!;
  const pharmacist = world.practitioners.find((p) => p.role === 'pharmacist')!;

  it('finds a Patient by NIK and returns its IHS number', async () => {
    const r = await ctx.platform.fhir('GET', `/Patient?identifier=${encodeURIComponent(`${NIK}|${patient.nik}`)}`);
    expect(r.status).toBe(200);
    expect(r.body.resourceType).toBe('Bundle');
    expect(r.body.total).toBe(1);
    expect(r.body.entry[0].resource.id).toBe(patient.ihs);
  });

  it('returns an empty Bundle for an unknown NIK', async () => {
    const r = await ctx.platform.fhir('GET', `/Patient?identifier=${encodeURIComponent(`${NIK}|9900000000000000`)}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.entry).toEqual([]);
  });

  it('finds a Practitioner (the pharmacist) by NIK', async () => {
    const r = await ctx.platform.fhir('GET', `/Practitioner?identifier=${encodeURIComponent(`${NIK}|${pharmacist.nik}`)}`);
    expect(r.status).toBe(200);
    expect(r.body.entry[0].resource.id).toBe(pharmacist.ihs);
  });

  it('does not find a patient NIK among practitioners', async () => {
    const r = await ctx.platform.fhir('GET', `/Practitioner?identifier=${encodeURIComponent(`${NIK}|${patient.nik}`)}`);
    expect(r.body.total).toBe(0);
  });

  it('finds a Location by id', async () => {
    const location = world.locations[1]!;
    const hit = await ctx.platform.fhir('GET', `/Location?_id=${location.id}`);
    expect(hit.body.entry[0].resource.id).toBe(location.id);
    const miss = await ctx.platform.fhir('GET', '/Location?_id=99a10000-0000-4000-8000-0000000000ff');
    expect(miss.body.total).toBe(0);
  });

  it('finds Encounters by identifier, every stored duplicate included', async () => {
    const value = 'VISIT-SEARCH-1';
    const q = `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${value}`)}`;
    expect((await ctx.platform.fhir('GET', q)).body.total).toBe(0);
    await ctx.platform.fhir('POST', '/Encounter', validEncounter(value));
    expect((await ctx.platform.fhir('GET', q)).body.total).toBe(1);
    await ctx.platform.fhir('POST', '/Encounter', validEncounter(value));
    const two = await ctx.platform.fhir('GET', q);
    expect(two.body.total).toBe(2);
    expect(new Set(two.body.entry.map((e: any) => e.resource.id)).size).toBe(2);
  });

  it.each([
    ['Patient by name', `/Patient?name=${encodeURIComponent(patient.name)}`],
    ['Patient by NIK under the wrong system', `/Patient?identifier=${encodeURIComponent(`urn:other|${patient.nik}`)}`],
    ['Patient by NIK plus an extra parameter', `/Patient?identifier=${encodeURIComponent(`${NIK}|${patient.nik}`)}&_count=5`],
    ['Location by name', '/Location?name=Apotek'],
    ['Encounter by subject', `/Encounter?subject=Patient/${patient.ihs}`],
    ['Encounter with no parameter', '/Encounter'],
    ['an unsupported resource type', '/Observation?identifier=x'],
  ])('rejects any other search (%s) with 400', async (_name, path) => {
    const r = await ctx.platform.fhir('GET', path);
    expect(r.status).toBe(400);
    expect(r.body.resourceType).toBe('OperationOutcome');
  });
});
