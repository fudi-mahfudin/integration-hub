import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWorld } from '../src/world/world.js';

const commitments = JSON.parse(
  readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'),
) as { worldDataset: { patients: number; practitioners: number } };

describe('world dataset', () => {
  const world = loadWorld();

  it('is sized to the commitments file', () => {
    expect(world.patients).toHaveLength(commitments.worldDataset.patients);
    expect(world.practitioners).toHaveLength(commitments.worldDataset.practitioners);
  });

  it('has exactly one pharmacist among the practitioners', () => {
    expect(world.practitioners.filter((p) => p.role === 'pharmacist')).toHaveLength(1);
  });

  it('has unique NIKs and IHS numbers across patients and practitioners', () => {
    const people = [...world.patients, ...world.practitioners];
    expect(new Set(people.map((p) => p.nik)).size).toBe(people.length);
    expect(new Set(people.map((p) => p.ihs)).size).toBe(people.length);
  });

  it('uses only fake NIKs (16 digits, unused province code 99)', () => {
    for (const p of [...world.patients, ...world.practitioners]) {
      expect(p.nik).toMatch(/^99\d{14}$/);
    }
  });

  it('carries every patient lookup field, with mothers NIKs for some', () => {
    for (const p of world.patients) {
      expect(p.name).not.toBe('');
      expect(p.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['male', 'female']).toContain(p.gender);
    }
    expect(world.patients.some((p) => p.motherNik !== null)).toBe(true);
  });

  it('contains deliberate near-misses of every kind', () => {
    const kinds = new Set(world.patients.flatMap((p) => (p.nearMiss ? [p.nearMiss.kind] : [])));
    expect([...kinds].sort()).toEqual(
      ['nik_one_digit', 'same_name_birthdate_other_gender', 'same_name_gender_birthdate_off_by_one_day', 'same_mother_nik'].sort(),
    );
    // Each near-miss names a real other patient.
    const niks = new Set(world.patients.map((p) => p.nik));
    for (const p of world.patients) {
      if (p.nearMiss) expect(niks.has(p.nearMiss.ofNik)).toBe(true);
    }
  });

  it('names its canary values, and they are real records', () => {
    const { canaries } = world;
    const patient = world.patients.find((p) => p.nik === canaries.patientNik);
    expect(patient?.ihs).toBe(canaries.patientIhs);
    expect(patient?.name).toBe(canaries.patientName);
    expect(world.practitioners.some((p) => p.nik === canaries.practitionerNik)).toBe(true);
  });

  it('has an organization, credentials for it, and locations belonging to it', () => {
    expect(world.organization.id).not.toBe('');
    expect(world.organization.clientId).not.toBe('');
    expect(world.locations.length).toBeGreaterThan(0);
    for (const l of world.locations) expect(l.organizationId).toBe(world.organization.id);
  });

  describe('KFA catalogue', () => {
    const byCode = new Map(world.kfaProducts.map((p) => [p.code, p]));

    it('uses the code prefix that matches each level', () => {
      for (const p of world.kfaProducts) expect(p.code.startsWith(String(p.level))).toBe(true);
    });

    it('gives every 92 and 93 a non-empty set of existing 91 codes', () => {
      for (const p of world.kfaProducts.filter((x) => x.level !== 91)) {
        expect(p.ingredientCodes.length).toBeGreaterThan(0);
        for (const c of p.ingredientCodes) expect(byCode.get(c)?.level).toBe(91);
      }
    });

    it('gives every 93 a 92 parent with the same 91 set', () => {
      for (const p of world.kfaProducts.filter((x) => x.level === 93)) {
        const parent = byCode.get(p.parentCode ?? '');
        expect(parent?.level).toBe(92);
        expect([...p.ingredientCodes].sort()).toEqual([...(parent?.ingredientCodes ?? [])].sort());
      }
    });

    it('has two different 92s with the same 91 set (strength-change substitution)', () => {
      const sets = world.kfaProducts
        .filter((x) => x.level === 92)
        .map((x) => [...x.ingredientCodes].sort().join(','));
      expect(new Set(sets).size).toBeLessThan(sets.length);
    });

    it('gives every 92 and 93 a dose form (the quantity unit, #6), a 93 the one of its 92; a 91 none', () => {
      for (const p of world.kfaProducts) {
        if (p.level === 91) expect(p.doseForm).toBeUndefined();
        else expect(p.doseForm).toMatchObject({ code: expect.stringMatching(/^[A-Z]+$/), name: expect.any(String) });
        if (p.level === 93) expect(p.doseForm).toEqual(byCode.get(p.parentCode ?? '')?.doseForm);
      }
      expect(new Set(world.kfaProducts.flatMap((p) => (p.doseForm ? [p.doseForm.code] : []))).size).toBeGreaterThan(1);
    });

    it('has a multi-ingredient product (91 set larger than one)', () => {
      expect(world.kfaProducts.some((x) => x.level === 92 && x.ingredientCodes.length > 1)).toBe(true);
    });
  });
});
