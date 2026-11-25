/**
 * Regenerates `world/world.json` deterministically. Sizes come from
 * `bigrun.commitments.json` (`worldDataset`), never from literals here.
 * Run: `pnpm --filter @integration-hub/mock-satusehat world:generate`.
 * All values are synthetic: NIKs use the unused province code 99.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Gender, KfaProduct, NearMissKind, World, WorldPatient, WorldPractitioner } from '../src/world/world.js';

const WORLD_SEED = 260001;

const commitments = JSON.parse(
  readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'),
) as { worldDataset: { patients: number; practitioners: number } };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(WORLD_SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');

const givenNames = ['Ayu', 'Budi', 'Citra', 'Dewi', 'Eko', 'Fajar', 'Gita', 'Hadi', 'Indah', 'Joko', 'Kartika', 'Lestari', 'Made', 'Nur', 'Putri', 'Rizki', 'Sari', 'Teguh', 'Wahyu', 'Yuni'];
const familyNames = ['Fiktif', 'Contoh', 'Sintetis', 'Rekaan', 'Uji', 'Tiruan', 'Sampel', 'Dummy'];

const usedNiks = new Set<string>();
function newNik(): string {
  for (;;) {
    const nik = `99${digits(14)}`;
    if (!usedNiks.has(nik)) {
      usedNiks.add(nik);
      return nik;
    }
  }
}

function birthDate(fromYear: number, toYear: number): string {
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear, 11, 31);
  return new Date(start + Math.floor(rand() * (end - start))).toISOString().slice(0, 10);
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function changeOneDigit(nik: string): string {
  for (;;) {
    const i = 2 + Math.floor(rand() * 14);
    const d = String((Number(nik[i]) + 1 + Math.floor(rand() * 9)) % 10);
    const candidate = nik.slice(0, i) + d + nik.slice(i + 1);
    if (!usedNiks.has(candidate)) {
      usedNiks.add(candidate);
      return candidate;
    }
  }
}

const name = (): string => `${pick(givenNames)} ${pick(givenNames)} ${pick(familyNames)}`;
const gender = (): Gender => (rand() < 0.5 ? 'male' : 'female');

// Patients: a regular population, then near-misses built from earlier patients.
const patientCount = commitments.worldDataset.patients;
const nearMissPerKind = 10;
const regularCount = patientCount - 4 * nearMissPerKind;
const patients: WorldPatient[] = [];
for (let i = 0; i < regularCount; i++) {
  const bd = birthDate(1950, 2023);
  const isChild = Number(bd.slice(0, 4)) >= 2018;
  patients.push({
    ihs: `P99${String(i + 1).padStart(8, '0')}`,
    nik: newNik(),
    motherNik: isChild ? newNik() : null,
    name: name(),
    birthDate: bd,
    gender: gender(),
  });
}
let nextIhs = regularCount + 1;
const nearMiss = (base: WorldPatient, kind: NearMissKind, p: Partial<WorldPatient>): WorldPatient => ({
  ihs: `P99${String(nextIhs++).padStart(8, '0')}`,
  nik: newNik(),
  motherNik: null,
  name: base.name,
  birthDate: base.birthDate,
  gender: base.gender,
  ...p,
  nearMiss: { kind, ofNik: base.nik },
});
for (let k = 0; k < nearMissPerKind; k++) {
  const base = patients[k * 7]!;
  patients.push(nearMiss(base, 'nik_one_digit', { nik: changeOneDigit(base.nik), name: name() }));
}
for (let k = 0; k < nearMissPerKind; k++) {
  const base = patients[k * 7 + 1]!;
  patients.push(nearMiss(base, 'same_name_birthdate_other_gender', { gender: base.gender === 'male' ? 'female' : 'male' }));
}
for (let k = 0; k < nearMissPerKind; k++) {
  const base = patients[k * 7 + 2]!;
  patients.push(nearMiss(base, 'same_name_gender_birthdate_off_by_one_day', { birthDate: shiftDay(base.birthDate, 1) }));
}
const children = patients.filter((p) => p.motherNik !== null);
for (let k = 0; k < nearMissPerKind; k++) {
  const base = children[k]!;
  // A sibling: same mother, different child.
  patients.push(nearMiss(base, 'same_mother_nik', { motherNik: base.motherNik, name: name(), gender: gender(), birthDate: birthDate(2018, 2023) }));
}

// Practitioners: exactly one pharmacist (mirrors the sandbox's dummy list, #14).
const practitioners: WorldPractitioner[] = [];
for (let i = 0; i < commitments.worldDataset.practitioners; i++) {
  practitioners.push({
    ihs: `100990${String(i + 1).padStart(5, '0')}`,
    nik: newNik(),
    name: `dr. ${name()}`,
    birthDate: birthDate(1960, 1995),
    gender: gender(),
    role: 'physician',
  });
}
const pharmacist = practitioners[practitioners.length - 1]!;
pharmacist.role = 'pharmacist';
pharmacist.name = pharmacist.name.replace(/^dr\. /, 'apt. ');

// KFA catalogue: 91 ingredients, 92 virtual products, 93 actual products.
const ingredients: [string, string][] = [
  ['91000001', 'Paracetamol'],
  ['91000002', 'Amoxicillin'],
  ['91000003', 'Metformin'],
  ['91000004', 'Amlodipine'],
  ['91000005', 'Omeprazole'],
  ['91000006', 'Cetirizine'],
  ['91000007', 'Ibuprofen'],
  ['91000008', 'Clavulanic acid'],
];
const virtuals: [string, string, string[]][] = [
  ['92000001', 'Paracetamol 500 mg Tablet', ['91000001']],
  ['92000002', 'Paracetamol 650 mg Tablet', ['91000001']],
  ['92000003', 'Amoxicillin 500 mg Kapsul', ['91000002']],
  ['92000004', 'Amoxicillin 500 mg / Clavulanic acid 125 mg Tablet', ['91000002', '91000008']],
  ['92000005', 'Metformin 500 mg Tablet', ['91000003']],
  ['92000006', 'Amlodipine 5 mg Tablet', ['91000004']],
  ['92000007', 'Amlodipine 10 mg Tablet', ['91000004']],
  ['92000008', 'Omeprazole 20 mg Kapsul', ['91000005']],
  ['92000009', 'Cetirizine 10 mg Tablet', ['91000006']],
  ['92000010', 'Ibuprofen 400 mg Tablet', ['91000007']],
];
const brands = ['Merek Alfa', 'Merek Beta'];
/** Dose form from the product name (v3-orderableDrugForm codes, synthetic). */
const doseForm = (display: string) => (display.endsWith('Kapsul') ? { code: 'CAP', name: 'Kapsul' } : { code: 'TAB', name: 'Tablet' });
const kfaProducts: KfaProduct[] = [
  ...ingredients.map(([code, display]): KfaProduct => ({ code, level: 91, display, ingredientCodes: [] })),
  ...virtuals.map(([code, display, ingredientCodes]): KfaProduct => ({ code, level: 92, display, ingredientCodes, doseForm: doseForm(display) })),
];
let actual = 1;
for (const [parentCode, display, ingredientCodes] of virtuals) {
  for (const brand of brands) {
    kfaProducts.push({
      code: `93${String(actual++).padStart(6, '0')}`,
      level: 93,
      display: `${display} (${brand})`,
      parentCode,
      ingredientCodes,
      doseForm: doseForm(display),
    });
  }
}

const organizationId = '99000001';
const canaryPatient = patients[0]!;
const world: World = {
  organization: {
    id: organizationId,
    name: 'RS Fiktif Sejahtera',
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
  },
  locations: [
    { id: '99a10000-0000-4000-8000-000000000001', name: 'Apotek Rawat Jalan', organizationId },
    { id: '99a10000-0000-4000-8000-000000000002', name: 'Poli Penyakit Dalam', organizationId },
    { id: '99a10000-0000-4000-8000-000000000003', name: 'Poli Anak', organizationId },
    { id: '99a10000-0000-4000-8000-000000000004', name: 'Instalasi Gawat Darurat', organizationId },
  ],
  patients,
  practitioners,
  kfaProducts,
  canaries: {
    patientNik: canaryPatient.nik,
    patientIhs: canaryPatient.ihs,
    patientName: canaryPatient.name,
    practitionerNik: practitioners[0]!.nik,
  },
};

const out = fileURLToPath(new URL('../world/world.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(world, null, 1)}\n`);
console.log(`wrote ${out}: ${patients.length} patients, ${practitioners.length} practitioners, ${kfaProducts.length} KFA products`);
