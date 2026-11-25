import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { world } from './support/satusehat.js';

describe('committed mapping seed', () => {
  // The seed names world Locations by id; the world is the source of truth (#26).
  const seedPath = loadConfig({}).mappingSeedPath;
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { locations: { source: string; locationCode: string; locationId: string }[] };

  it('maps one local code to every world Location, for the default dev source', () => {
    const devSource = loadConfig({}).sources[0]!;

    expect(devSource.organizationId).toBe(world.organization.id);
    expect(seed.locations.every((l) => l.source === devSource.id)).toBe(true);
    expect(seed.locations.map((l) => l.locationId).sort()).toEqual(world.locations.map((l) => l.id).sort());
    expect(new Set(seed.locations.map((l) => l.locationCode)).size).toBe(seed.locations.length);
  });

  it('maps one local drug code to every world KFA 92 and 93 product, for the default dev source', () => {
    const devSource = loadConfig({}).sources[0]!;
    const drugs = (seed as unknown as { drugs: { source: string; drugCode: string; kfaCode: string }[] }).drugs;

    expect(drugs.every((d) => d.source === devSource.id)).toBe(true);
    const prescribable = world.kfaProducts.filter((p) => p.level === 92 || p.level === 93).map((p) => p.code);
    expect(drugs.map((d) => d.kfaCode).sort()).toEqual(prescribable.sort());
    expect(new Set(drugs.map((d) => d.drugCode)).size).toBe(drugs.length);
  });
});
