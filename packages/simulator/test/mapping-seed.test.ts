import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LOCAL_DRUG_CODES, VISIT_LOCATIONS } from '../src/local-codes.js';

const world = await loadWorld(DEFAULT_WORLD_PATH);

// The operator's seed files, read as the worker reads them: files, not hub code.
const seedFile = async <T extends z.ZodType>(name: string, schema: T): Promise<z.infer<T>> =>
  schema.parse(JSON.parse(await readFile(new URL(`../../../apps/hub/seed/${name}`, import.meta.url), 'utf8')));
const drugSeed = await seedFile('drug-mappings.json', z.array(z.object({ source: z.string(), drugCode: z.string(), kfaCode: z.string(), note: z.string() })));
const locationSeed = await seedFile('location-mappings.json', z.array(z.object({ source: z.string(), locationCode: z.string(), locationId: z.string() })));

describe("the hub's mapping seed for the simulator's source points at the world dataset", () => {
  it('maps every local drug code the simulator uses to the KFA product it names, a 92 or 93 the world holds', () => {
    for (const { drugCode, kfaCode } of LOCAL_DRUG_CODES) {
      expect(drugSeed.filter((m) => m.source === 'simulator' && m.drugCode === drugCode).map((m) => m.kfaCode)).toEqual([kfaCode]);
      expect([92, 93]).toContain(world.kfaProducts.find((p) => p.code === kfaCode)?.level);
    }
  });

  it('maps every other seeded drug code to a world code too, except those noted as deliberately wrong', () => {
    const worldCodes = new Set([...world.kfaProducts.map((p) => p.code), ...world.kfaIngredients.map((i) => i.code)]);
    const others = drugSeed.filter((m) => !LOCAL_DRUG_CODES.some((c) => c.drugCode === m.drugCode));
    for (const mapping of others.filter((m) => !m.note.startsWith('Deliberately wrong'))) expect(worldCodes).toContain(mapping.kfaCode);
  });

  it('maps every location code the simulator starts visits at to the world location with that code', () => {
    for (const { locationCode } of VISIT_LOCATIONS) {
      const worldLocation = world.locations.find((l) => l.code === locationCode);
      expect(worldLocation).toBeDefined();
      expect(locationSeed.filter((m) => m.source === 'simulator' && m.locationCode === locationCode).map((m) => m.locationId)).toEqual([worldLocation?.id]);
    }
    for (const mapping of locationSeed) expect(world.locations.map((l) => l.id)).toContain(mapping.locationId);
  });
});
