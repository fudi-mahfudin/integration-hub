import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import {
  bootMock,
  world,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisit,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

type WorldPatient = (typeof world.patients)[number];
type WorldPractitioner = (typeof world.practitioners)[number];

/** A well-formed NIK no world patient or practitioner has. */
const UNKNOWN_NIK = '9271069999999999';

const createVisitSettled = (v: CaseView) => v.steps[0]?.state === 'completed' || v.steps[0]?.state === 'dead_lettered';

describe('person lookup: IHS numbers are found by NIK, else by the fallbacks SATUSEHAT documents', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });

  // The mock is never reset here (a reset revokes the worker's token); each test uses a fresh visit id.
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });

  /** Sends `visit.started` with these people and resolves once create visit settled. */
  async function settle(visit: ReturnType<typeof worldVisitStarted>) {
    const res = await send(visit);
    expect(res.status).toBe(202);
    return waitForCase(hub.baseUrl, res.headers.get('location'), createVisitSettled, { apiKey: WORLD_SOURCE_API_KEY });
  }
  const startVisit = (people: { patient?: Record<string, unknown>; practitioner?: Record<string, unknown> }) => settle(worldVisitStarted(people));

  describe('patient', () => {
    it('without a NIK, is found by name + birthDate + gender', async () => {
      const { patient } = worldVisit;

      const view = await startVisit({
        patient: { name: patient.name, birthDate: patient.birthDate, gender: patient.gender, mrn: 'MRN-0001' },
      });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: patient.ihsNumber } });
      expect(view.steps[0]?.attemptLog).toEqual([
        expect.objectContaining({ outcome: 'completed', lookupMethods: { patient: 'name_birth_date_gender', practitioner: 'nik' } }),
      ]);
    });

    it("without a NIK, is found by mother's NIK + birthDate", async () => {
      const { patient } = worldVisit;

      const view = await startVisit({ patient: { motherNik: patient.motherNik, birthDate: patient.birthDate, mrn: 'MRN-0001' } });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: patient.ihsNumber } });
      expect(view.steps[0]?.attemptLog).toEqual([
        expect.objectContaining({ outcome: 'completed', lookupMethods: { patient: 'mother_nik_birth_date', practitioner: 'nik' } }),
      ]);
    });

    it('is found by NIK first, even when the fallbacks would find someone else', async () => {
      const { patient } = worldVisit;
      const other = nearMiss('same name and birthDate, different gender')[0];

      const view = await startVisit({
        patient: { nik: patient.nik, name: other.name, birthDate: other.birthDate, gender: other.gender, mrn: 'MRN-0001' },
      });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: patient.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupMethods).toEqual({ patient: 'nik', practitioner: 'nik' });
    });

    it('falls back to the next search when one finds no one', async () => {
      const { patient } = worldVisit;

      const view = await startVisit({
        patient: {
          nik: UNKNOWN_NIK,
          motherNik: patient.motherNik,
          birthDate: patient.birthDate,
          name: patient.name,
          gender: patient.gender,
          mrn: 'MRN-0001',
        },
      });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: patient.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupMethods).toEqual({ patient: 'mother_nik_birth_date', practitioner: 'nik' });
    });

    it.each([
      ['same name and birthDate, different gender', 1],
      ['same name and gender, birthDate one day apart', 0],
      ['same birthDate and gender, names one letter apart', 1],
    ] as const)('among near-misses with %s, name + birthDate + gender finds only its own patient', async (description, index) => {
      const patient = nearMiss(description)[index];

      const view = await startVisit({ patient: { name: patient.name, birthDate: patient.birthDate, gender: patient.gender, mrn: 'MRN-0001' } });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: patient.ihsNumber } });
    });

    it.each([
      ['a name one letter off', (p: WorldPatient) => ({ name: `${p.name.slice(0, -1)}a`, birthDate: p.birthDate, gender: p.gender })],
      ['a birthDate one day off', (p: WorldPatient) => ({ name: p.name, birthDate: '2000-12-04', gender: p.gender })],
      ['the other gender', (p: WorldPatient) => ({ name: p.name, birthDate: p.birthDate, gender: p.gender === 'male' ? 'female' : 'male' })],
      ["the mother's NIK with another birthDate", (p: WorldPatient) => ({ motherNik: p.motherNik, birthDate: '2000-12-04' })],
    ])('dead-letters with PATIENT_NOT_FOUND for %s, creating nothing', async (_name, nearly) => {
      // Budi Santoso, 2000-12-03, male: no other world patient is one field away.
      const visit = worldVisitStarted({ patient: { ...nearly(worldVisit.patient), mrn: 'MRN-0001' } });

      const view = await settle(visit);

      expect(view.status).toBe('dead_lettered');
      expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PATIENT_NOT_FOUND', pins: null });
      expect(view.steps[0]?.attemptLog).toEqual([
        expect.objectContaining({ outcome: 'dead_lettered', errorCode: 'PATIENT_NOT_FOUND', httpStatus: 200, lookupMethods: {} }),
      ]);
      expect((await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none')).toEqual([]);
    });

    it.each([
      ['name + birthDate + gender', () => {
        const [first] = nearMiss('same name, birthDate and gender');
        return { name: first.name, birthDate: first.birthDate, gender: first.gender };
      }],
      ["mother's NIK + birthDate (twins)", () => {
        const [first] = nearMiss('twins');
        return { motherNik: first.motherNik, birthDate: first.birthDate };
      }],
    ])('dead-letters with PATIENT_AMBIGUOUS when %s matches more than one patient', async (_name, people) => {
      const view = await startVisit({ patient: { ...people(), mrn: 'MRN-0001' } });

      expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PATIENT_AMBIGUOUS', pins: null });
      expect(view.steps[0]?.attemptLog).toEqual([expect.objectContaining({ errorCode: 'PATIENT_AMBIGUOUS', lookupMethods: {} })]);
    });

    it('does not break an ambiguous match with a weaker search', async () => {
      const [twin] = nearMiss('twins');

      const view = await startVisit({
        patient: { motherNik: twin.motherNik, birthDate: twin.birthDate, name: twin.name, gender: twin.gender, mrn: 'MRN-0001' },
      });

      expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PATIENT_AMBIGUOUS' });
    });
  });

  describe('practitioner, requester and pharmacist', () => {
    const byNameBirthDateGender = (p: WorldPractitioner) => ({ name: p.name, birthDate: p.birthDate, gender: p.gender });

    it('without a NIK, the visit practitioner is found by name + birthDate + gender', async () => {
      const view = await startVisit({ practitioner: byNameBirthDateGender(worldVisit.physician) });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: worldVisit.physician.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupMethods).toEqual({ patient: 'nik', practitioner: 'name_birth_date_gender' });
    });

    it('without a NIK, the requester and the pharmacist are found by name + birthDate + gender', async () => {
      const { physician, pharmacist } = worldVisit;
      const visit = worldVisitStarted();
      const prescription = worldPrescriptionWritten(visit.visitId, { data: { requester: byNameBirthDateGender(physician) } });
      await send(visit);
      await send(prescription);
      const res = await send(worldDrugDispensed(prescription, { pharmacist: byNameBirthDateGender(pharmacist) }));

      const view = await waitForCase(hub.baseUrl, res.headers.get('location'), (v) => v.steps[2]?.state === 'completed' || v.status === 'dead_lettered', {
        apiKey: WORLD_SOURCE_API_KEY,
      });

      expect(view.steps[1]).toMatchObject({ state: 'completed', pins: { requesterIhsNumber: physician.ihsNumber } });
      expect(view.steps[1]?.attemptLog[0]?.lookupMethods).toEqual({ requester: 'name_birth_date_gender' });
      expect(view.steps[2]).toMatchObject({ state: 'completed', pins: { pharmacistIhsNumber: pharmacist.ihsNumber } });
      expect(view.steps[2]?.attemptLog[0]?.lookupMethods).toEqual({ pharmacist: 'name_birth_date_gender' });
    });

    it('falls back from a NIK no one has to name + birthDate + gender', async () => {
      const view = await startVisit({ practitioner: { nik: UNKNOWN_NIK, ...byNameBirthDateGender(worldVisit.physician) } });

      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: worldVisit.physician.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupMethods).toEqual({ patient: 'nik', practitioner: 'name_birth_date_gender' });
    });

    it('dead-letters with PRACTITIONER_NOT_FOUND when the name is a near-miss', async () => {
      const { physician } = worldVisit;

      const view = await startVisit({ practitioner: { ...byNameBirthDateGender(physician), name: `${physician.name}x` } });

      expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PRACTITIONER_NOT_FOUND', pins: null });
      expect(view.steps[0]?.attemptLog).toEqual([
        expect.objectContaining({ errorCode: 'PRACTITIONER_NOT_FOUND', valuesUsed: expect.objectContaining({ patientIhsNumber: worldVisit.patient.ihsNumber }), lookupMethods: { patient: 'nik' } }),
      ]);
    });

    it('dead-letters with PRACTITIONER_AMBIGUOUS when two practitioners share name, birthDate and gender', async () => {
      const twin = { name: `dr. Kembar ${randomUUID()}`, birthDate: '1980-05-05', gender: 'female' as const };
      // Fresh identifiers, so the seeded pair never collides with other seeds on this mock.
      const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
      await mock.client.seed({
        practitioners: [
          { ihsNumber: `1${digits(10)}`, nik: digits(16), role: 'physician', ...twin },
          { ihsNumber: `1${digits(10)}`, nik: digits(16), role: 'physician', ...twin },
        ],
      });

      const view = await startVisit({ practitioner: twin });

      expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PRACTITIONER_AMBIGUOUS', pins: null });
    });
  });
});

/** The world patients of the near-miss group `description` starts with; at least two. */
function nearMiss(description: string): [WorldPatient, WorldPatient, ...WorldPatient[]] {
  const group = world.patientMarkers.nearMisses.find((g) => g.description.startsWith(description));
  const patients = (group?.niks ?? []).flatMap((nik) => world.patients.filter((p) => p.nik === nik));
  const [first, second, ...rest] = patients;
  if (!first || !second) throw new Error(`the world has no near-miss group "${description}" of two patients or more`);
  return [first, second, ...rest];
}
