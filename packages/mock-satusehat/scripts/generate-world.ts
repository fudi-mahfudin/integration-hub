// Writes world/world.json: the one synthetic world dataset (see GLOSSARY.md).
// Deterministic: the same script always writes the same file. Every value is
// fake. Sizes come from bigrun.commitments.json (`world`).
//
//   pnpm --filter @integration-hub/mock-satusehat world:generate
import { readFile, writeFile } from 'node:fs/promises';
import { worldSchema, type World, type WorldPatient } from '../src/world/world.js';

const commitments = JSON.parse(
  await readFile(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'),
) as { world: { patients: number; practitioners: number } }; // shape fixed by the commitments file; the world schema re-checks the result

// mulberry32: a tiny seeded PRNG, so the file is reproducible.
let state = 20261126;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}
function uuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = '8';
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const MALE = ['Budi', 'Agus', 'Andi', 'Rudi', 'Dedi', 'Hendra', 'Joko', 'Bayu', 'Rizki', 'Fajar', 'Arif', 'Yusuf', 'Dimas', 'Eko', 'Gilang', 'Hadi', 'Imam', 'Krisna', 'Lukman', 'Made'];
const FEMALE = ['Siti', 'Dewi', 'Ani', 'Rina', 'Wati', 'Putri', 'Ayu', 'Indah', 'Lestari', 'Maya', 'Nur', 'Ratna', 'Sari', 'Tuti', 'Yuni', 'Fitri', 'Gita', 'Intan', 'Kartika', 'Lina'];
const FAMILY = ['Santoso', 'Wijaya', 'Saputra', 'Hidayat', 'Kurniawan', 'Pratama', 'Setiawan', 'Nugroho', 'Lestari', 'Rahayu', 'Siregar', 'Nasution', 'Simanjuntak', 'Tanjung', 'Wibowo', 'Gunawan', 'Halim', 'Sitompul', 'Purba', 'Manurung'];

/** A fake NIK: region 927106, birth date (day + 40 for women), a 4-digit sequence. */
function patientNik(birthDate: string, gender: 'male' | 'female', seq: number): string {
  const [yyyy = '', mm = '', dd = ''] = birthDate.split('-');
  const day = Number(dd) + (gender === 'female' ? 40 : 0);
  return `927106${String(day).padStart(2, '0')}${mm}${yyyy.slice(2)}${String(seq).padStart(4, '0')}`;
}
function randomBirthDate(fromYear: number, toYear: number): string {
  const year = fromYear + Math.floor(random() * (toYear - fromYear + 1));
  const month = 1 + Math.floor(random() * 12);
  const day = 1 + Math.floor(random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let seq = 1;
let motherSeq = 5001;
function patient(name: string, birthDate: string, gender: 'male' | 'female', motherNik?: string): WorldPatient {
  const index = seq++;
  return {
    ihsNumber: `P${String(2000000000 + index).padStart(11, '0')}`,
    nik: patientNik(birthDate, gender, index),
    motherNik: motherNik ?? patientNik(shiftDay(birthDate, -9000), 'female', motherSeq++),
    name,
    birthDate,
    gender,
  };
}

// The README's example visit uses NIK 9271060312000001; it is the first patient.
const patients: WorldPatient[] = [patient('Budi Santoso', '2000-12-03', 'male')];

// Deliberate near-misses for the name+birthDate+gender and mother's NIK fallbacks.
const nearMisses: World['patientMarkers']['nearMisses'] = [];
function nearMiss(description: string, group: WorldPatient[]): void {
  patients.push(...group);
  nearMisses.push({ description, niks: group.map((p) => p.nik) });
}
nearMiss('same name and birthDate, different gender', [
  patient('Ari Kusuma', '1985-04-17', 'male'),
  patient('Ari Kusuma', '1985-04-17', 'female'),
]);
nearMiss('same name and gender, birthDate one day apart', [
  patient('Dewi Anggraini', '1990-08-09', 'female'),
  patient('Dewi Anggraini', '1990-08-10', 'female'),
]);
nearMiss('same birthDate and gender, names one letter apart', [
  patient('Rahmat Hidayat', '1978-02-21', 'male'),
  patient('Rahmad Hidayat', '1978-02-21', 'male'),
]);
nearMiss('same name, birthDate and gender, different NIK (the fallback is ambiguous)', [
  patient('Siti Aminah', '1995-11-30', 'female'),
  patient('Siti Aminah', '1995-11-30', 'female'),
]);
const twinsMother = patientNik('1992-06-14', 'female', 4901);
nearMiss("twins: same mother's NIK and birthDate (the mother's NIK fallback is ambiguous)", [
  patient('Bayi Ny. Lestari I', '2026-01-05', 'male', twinsMother),
  patient('Bayi Ny. Lestari II', '2026-01-05', 'female', twinsMother),
]);

// Canary values: distinctive enough that a redaction test can grep for them.
const canaries = [patient('Kanari Penanda Satu', '1999-09-09', 'female'), patient('Kanari Penanda Dua', '1988-08-08', 'male')];
patients.push(...canaries);

const reserved = new Set(patients.map((p) => `${p.name}|${p.birthDate}|${p.gender}`));
const reservedNames = new Set(patients.map((p) => p.name));
while (patients.length < commitments.world.patients) {
  const gender = random() < 0.5 ? 'male' : 'female';
  const name = `${pick(gender === 'male' ? MALE : FEMALE)} ${pick(FAMILY)}`;
  const birthDate = randomBirthDate(1945, 2024);
  const key = `${name}|${birthDate}|${gender}`;
  // Only the marked near-misses may look alike, so ordinary patients never
  // share name+birthDate+gender or a special patient's name.
  if (reserved.has(key) || reservedNames.has(name)) continue;
  reserved.add(key);
  patients.push(patient(name, birthDate, gender));
}

const practitioners: World['practitioners'] = Array.from({ length: commitments.world.practitioners }, (_, i) => {
  const index = i + 1;
  const pharmacist = index === commitments.world.practitioners;
  const gender = random() < 0.5 ? 'male' : 'female';
  // The README's example practitioner NIK 7209061211900001 is the first one.
  const nik = index === 1 ? '7209061211900001' : `720906${randomBirthDate(1960, 1995).replace(/^(\d\d)(\d\d)-(\d\d)-(\d\d)$/, '$4$3$2')}${String(index).padStart(4, '0')}`;
  return {
    ihsNumber: `1000${String(9000000 + index).padStart(7, '0')}`,
    nik,
    name: `${pharmacist ? 'apt.' : 'dr.'} ${pick(gender === 'male' ? MALE : FEMALE)} ${pick(FAMILY)}`,
    // Read from the date the NIK encodes (DDMMYY, all 19xx), so no extra random draw shifts the rest of the world.
    birthDate: `19${nik.slice(10, 12)}-${nik.slice(8, 10)}-${nik.slice(6, 8)}`,
    gender,
    role: pharmacist ? 'pharmacist' : 'physician',
  };
});

// Fake dose form codes in the shape of KFA's `dosage_form` (code + name).
const TABLET = { code: 'BS066', display: 'Tablet' };
const KAPSUL = { code: 'BS019', display: 'Kapsul' };

const world: World = {
  organization: {
    id: '99000001',
    name: 'RS Fiktif Sehat Sentosa',
    clientId: 'dev-satusehat-client',
    clientSecret: 'dev-satusehat-secret',
  },
  kfaIngredients: [
    { code: '91000001', display: 'Parasetamol' },
    { code: '91000002', display: 'Amoksisilin' },
    { code: '91000003', display: 'Asam klavulanat' },
    { code: '91000004', display: 'Ibuprofen' },
    { code: '91000005', display: 'Metformin hidroklorida' },
    { code: '91000006', display: 'Amlodipin besilat' },
  ],
  kfaProducts: [
    { level: 92, code: '92000001', display: 'Parasetamol 500 mg Tablet', doseForm: TABLET, ingredients: ['91000001'] },
    { level: 92, code: '92000002', display: 'Parasetamol 650 mg Tablet', doseForm: TABLET, ingredients: ['91000001'] },
    { level: 92, code: '92000003', display: 'Amoksisilin 500 mg Kapsul', doseForm: KAPSUL, ingredients: ['91000002'] },
    { level: 92, code: '92000004', display: 'Amoksisilin 500 mg / Asam klavulanat 125 mg Tablet', doseForm: TABLET, ingredients: ['91000002', '91000003'] },
    { level: 92, code: '92000005', display: 'Ibuprofen 400 mg Tablet', doseForm: TABLET, ingredients: ['91000004'] },
    { level: 92, code: '92000006', display: 'Metformin hidroklorida 500 mg Tablet', doseForm: TABLET, ingredients: ['91000005'] },
    { level: 92, code: '92000007', display: 'Amlodipin besilat 5 mg Tablet', doseForm: TABLET, ingredients: ['91000006'] },
    { level: 92, code: '92000008', display: 'Amlodipin besilat 10 mg Tablet', doseForm: TABLET, ingredients: ['91000006'] },
    { level: 93, code: '93000001', display: 'Parasetamol 500 mg Tablet (Fiktif Farma A)', doseForm: TABLET, ingredients: ['91000001'], parent: '92000001' },
    { level: 93, code: '93000002', display: 'Parasetamol 500 mg Tablet (Fiktif Farma B)', doseForm: TABLET, ingredients: ['91000001'], parent: '92000001' },
    { level: 93, code: '93000003', display: 'Parasetamol 650 mg Tablet (Fiktif Farma A)', doseForm: TABLET, ingredients: ['91000001'], parent: '92000002' },
    { level: 93, code: '93000004', display: 'Amoksisilin 500 mg Kapsul (Fiktif Farma C)', doseForm: KAPSUL, ingredients: ['91000002'], parent: '92000003' },
    { level: 93, code: '93000005', display: 'Amoksisilin 500 mg Kapsul (Fiktif Farma D)', doseForm: KAPSUL, ingredients: ['91000002'], parent: '92000003' },
    { level: 93, code: '93000006', display: 'Amoksisilin / Asam klavulanat 625 mg Tablet (Fiktif Farma C)', doseForm: TABLET, ingredients: ['91000002', '91000003'], parent: '92000004' },
    { level: 93, code: '93000007', display: 'Ibuprofen 400 mg Tablet (Fiktif Farma B)', doseForm: TABLET, ingredients: ['91000004'], parent: '92000005' },
    { level: 93, code: '93000008', display: 'Metformin hidroklorida 500 mg Tablet (Fiktif Farma D)', doseForm: TABLET, ingredients: ['91000005'], parent: '92000006' },
    { level: 93, code: '93000009', display: 'Amlodipin besilat 5 mg Tablet (Fiktif Farma A)', doseForm: TABLET, ingredients: ['91000006'], parent: '92000007' },
    { level: 93, code: '93000010', display: 'Amlodipin besilat 10 mg Tablet (Fiktif Farma A)', doseForm: TABLET, ingredients: ['91000006'], parent: '92000008' },
  ],
  patients,
  practitioners,
  locations: [
    { id: uuid(), code: 'POLI-UMUM', name: 'Poli Umum' },
    { id: uuid(), code: 'POLI-ANAK', name: 'Poli Anak' },
    { id: uuid(), code: 'POLI-PENYAKIT-DALAM', name: 'Poli Penyakit Dalam' },
    { id: uuid(), code: 'IGD', name: 'Instalasi Gawat Darurat' },
    { id: uuid(), code: 'FARMASI-RJ', name: 'Farmasi Rawat Jalan' },
  ],
  patientMarkers: { canaryNiks: canaries.map((p) => p.nik), nearMisses },
};

worldSchema.parse(world);
await writeFile(new URL('../world/world.json', import.meta.url), `${JSON.stringify(world, null, 1)}\n`);
console.log(`world/world.json: ${patients.length} patients, ${practitioners.length} practitioners`);
