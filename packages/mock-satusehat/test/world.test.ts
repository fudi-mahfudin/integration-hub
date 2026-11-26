import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { world } from './support/boot-mock.js';

const commitments: unknown = JSON.parse(await readFile(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));

describe('world dataset', () => {
  it('is sized to the commitments file', () => {
    expect(commitments).toMatchObject({ world: { patients: world.patients.length, practitioners: world.practitioners.length } });
  });

  it('has unique NIKs and IHS numbers', () => {
    for (const people of [world.patients, world.practitioners]) {
      expect(new Set(people.map((p) => p.nik)).size).toBe(people.length);
      expect(new Set(people.map((p) => p.ihsNumber)).size).toBe(people.length);
    }
  });

  it('has exactly one pharmacist among the practitioners', () => {
    expect(world.practitioners.filter((p) => p.role === 'pharmacist')).toHaveLength(1);
  });

  it('has at least one location and the organization the hub runs as by default', () => {
    expect(world.locations.length).toBeGreaterThan(0);
    expect(world.organization.id).toBe('99000001');
  });

  it('every KFA product names known 91 ingredients, and every 93 derives from a 92 with the same 91 set', () => {
    const ingredients = new Set(world.kfaIngredients.map((i) => i.code));
    const virtual = new Map(world.kfaProducts.filter((p) => p.level === 92).map((p) => [p.code, p]));
    for (const product of world.kfaProducts) {
      expect(product.ingredients.every((code) => ingredients.has(code)), product.code).toBe(true);
      if (product.level === 93) {
        const parent = virtual.get(product.parent);
        expect(parent, `${product.code} parent ${product.parent}`).toBeDefined();
        expect([...product.ingredients].sort()).toEqual([...(parent?.ingredients ?? [])].sort());
      }
    }
  });

  it('supports the substitution scenario: two 92s with the same 91 set, and a multi-ingredient product', () => {
    const sets = world.kfaProducts.filter((p) => p.level === 92).map((p) => [...p.ingredients].sort().join('+'));
    expect(sets.length).toBeGreaterThan(new Set(sets).size);
    expect(world.kfaProducts.some((p) => p.ingredients.length > 1)).toBe(true);
  });

  it('marks near-misses whose patients really look alike, covering each fallback', () => {
    const byNik = new Map(world.patients.map((p) => [p.nik, p]));
    const groups = world.patientMarkers.nearMisses.map((g) => g.niks.map((nik) => byNik.get(nik)));
    for (const group of groups) expect(group.every((p) => p !== undefined)).toBe(true);
    const same = (key: 'name' | 'birthDate' | 'gender' | 'motherNik') => (group: (typeof groups)[number]) =>
      new Set(group.map((p) => p?.[key])).size === 1;

    // name+birthDate+gender ambiguous, and each one-field-off variant
    expect(groups.some((g) => same('name')(g) && same('birthDate')(g) && same('gender')(g))).toBe(true);
    expect(groups.some((g) => same('name')(g) && same('birthDate')(g) && !same('gender')(g))).toBe(true);
    expect(groups.some((g) => same('name')(g) && !same('birthDate')(g) && same('gender')(g))).toBe(true);
    expect(groups.some((g) => !same('name')(g) && same('birthDate')(g) && same('gender')(g))).toBe(true);
    // mother's NIK ambiguous
    expect(groups.some(same('motherNik'))).toBe(true);
  });

  it('outside the marked near-misses, no two patients share name+birthDate+gender', () => {
    const marked = new Set(world.patientMarkers.nearMisses.flatMap((g) => g.niks));
    const keys = world.patients.filter((p) => !marked.has(p.nik)).map((p) => `${p.name}|${p.birthDate}|${p.gender}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has canary patients', () => {
    const niks = new Set(world.patients.map((p) => p.nik));
    expect(world.patientMarkers.canaryNiks.length).toBeGreaterThan(0);
    for (const nik of world.patientMarkers.canaryNiks) expect(niks.has(nik)).toBe(true);
  });

  it("contains the README's example patient and practitioner NIKs", () => {
    expect(world.patients.some((p) => p.nik === '9271060312000001')).toBe(true);
    expect(world.practitioners.some((p) => p.nik === '7209061211900001')).toBe(true);
  });
});
