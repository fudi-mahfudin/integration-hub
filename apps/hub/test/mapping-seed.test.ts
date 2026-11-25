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
});
