import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { accessToken, bootMock, encounter, fhir, world, type BootedMock } from './support/boot-mock.js';

const NIK = 'https://fhir.kemkes.go.id/id/nik';
const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

describe('search', () => {
  let mock: BootedMock;
  let token: string;

  beforeAll(async () => {
    mock = await bootMock();
  });
  afterAll(async () => mock?.close());
  beforeEach(async () => {
    await mock.client.reset();
    token = await accessToken(mock.baseUrl);
  });

  async function search(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fhir(mock.baseUrl, token, path);
    return { status: res.status, body: await res.json() };
  }

  it('finds a world patient by NIK, with the IHS number as id', async () => {
    const patient = world.patients[0];
    const { status, body } = await search(`Patient?identifier=${NIK}|${patient?.nik}`);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      resourceType: 'Bundle',
      type: 'searchset',
      total: 1,
      entry: [{ resource: { resourceType: 'Patient', id: patient?.ihsNumber } }],
    });
  });

  it('answers an empty Bundle for an unknown NIK', async () => {
    const { status, body } = await search(`Patient?identifier=${NIK}|0000000000000000`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ resourceType: 'Bundle', total: 0, entry: [] });
  });

  it('finds a world practitioner by NIK, including the pharmacist', async () => {
    const pharmacist = world.practitioners.find((p) => p.role === 'pharmacist');
    const { body } = await search(`Practitioner?identifier=${NIK}|${pharmacist?.nik}`);
    expect(body).toMatchObject({ total: 1, entry: [{ resource: { resourceType: 'Practitioner', id: pharmacist?.ihsNumber } }] });
  });

  it('finds a world practitioner by name, birthdate and gender, ignoring the case of the name', async () => {
    const physician = world.practitioners.find((p) => p.role === 'physician');
    if (!physician) throw new Error('world has no physician');
    const query = (name: string, birthdate: string, gender: string) =>
      search(`Practitioner?${new URLSearchParams({ name, birthdate, gender })}`);

    const { status, body } = await query(physician.name.toUpperCase(), physician.birthDate, physician.gender);

    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1, entry: [{ resource: { resourceType: 'Practitioner', id: physician.ihsNumber } }] });
    const otherGender = physician.gender === 'male' ? 'female' : 'male';
    expect((await query(physician.name, physician.birthDate, otherGender)).body).toMatchObject({ total: 0 });
    expect((await query(physician.name, '1900-01-01', physician.gender)).body).toMatchObject({ total: 0 });
    expect((await query(physician.name.slice(0, -1), physician.birthDate, physician.gender)).body).toMatchObject({ total: 0 });
  });

  /** The world patients of the near-miss group `description` starts with. */
  function nearMiss(description: string) {
    const group = world.patientMarkers.nearMisses.find((g) => g.description.startsWith(description));
    const patients = group?.niks.map((nik) => world.patients.find((p) => p.nik === nik));
    if (!patients?.every((p) => p !== undefined)) throw new Error(`world has no near-miss group "${description}"`);
    return patients;
  }
  const byNameBirthdateGender = (p: { name: string; birthDate: string; gender: string }) =>
    `Patient?${new URLSearchParams({ name: p.name, birthdate: p.birthDate, gender: p.gender })}`;
  const hitIds = (body: unknown) =>
    z.object({ entry: z.array(z.object({ resource: z.object({ id: z.string() }) })) }).parse(body).entry.map((e) => e.resource.id);

  it.each([
    'same name and birthDate, different gender',
    'same name and gender, birthDate one day apart',
    'same birthDate and gender, names one letter apart',
  ])('finds only the one patient by name, birthdate and gender among near-misses with %s', async (description) => {
    for (const patient of nearMiss(description)) {
      const { status, body } = await search(byNameBirthdateGender(patient));
      expect(status).toBe(200);
      expect(hitIds(body)).toEqual([patient.ihsNumber]);
    }
  });

  it('finds every patient sharing name, birthdate and gender', async () => {
    const [first, second] = nearMiss('same name, birthDate and gender');
    if (!first || !second) throw new Error('the ambiguous near-miss group needs two patients');

    const { body } = await search(byNameBirthdateGender(first));

    expect(hitIds(body).sort()).toEqual([first.ihsNumber, second.ihsNumber].sort());
  });

  it("finds every child of a mother by her NIK, each with its birthDate and the mother's NIK", async () => {
    const twins = nearMiss('twins');
    const [twin] = twins;
    if (!twin) throw new Error('the twins group is empty');

    const { status, body } = await search(`Patient?identifier=${NIK}-ibu|${twin.motherNik}`);

    expect(status).toBe(200);
    expect(hitIds(body).sort()).toEqual(twins.map((p) => p.ihsNumber).sort());
    expect(body).toMatchObject({
      entry: twins.map(() => ({
        resource: {
          birthDate: twin.birthDate,
          identifier: expect.arrayContaining([{ use: 'official', system: `${NIK}-ibu`, value: twin.motherNik }]),
        },
      })),
    });
    expect((await search(`Patient?identifier=${NIK}-ibu|0000000000000000`)).body).toMatchObject({ total: 0 });
  });

  it('finds a world location by id', async () => {
    const location = world.locations[0];
    const { body } = await search(`Location?_id=${location?.id}`);
    expect(body).toMatchObject({ total: 1, entry: [{ resource: { resourceType: 'Location', id: location?.id } }] });
  });

  it('finds a created Encounter by its encounter/{org} identifier', async () => {
    const created: unknown = await (await fhir(mock.baseUrl, token, 'Encounter', encounter('V-search'))).json();
    expect(created).toMatchObject({ id: expect.any(String) });

    const { body } = await search(`Encounter?identifier=${ENCOUNTER_SYSTEM}|V-search`);

    expect(body).toMatchObject({ total: 1, entry: [{ resource: created }] });
    expect((await search(`Encounter?identifier=${ENCOUNTER_SYSTEM}|V-other`)).body).toMatchObject({ total: 0 });
  });

  it.each([
    ['an unknown parameter', 'Patient?name=Budi'],
    ['NIK plus another parameter', `Patient?identifier=${NIK}|${world.patients[0]?.nik}&gender=male`],
    ['a repeated parameter', `Patient?identifier=${NIK}|1&identifier=${NIK}|2`],
    ['an identifier under another system', 'Patient?identifier=https://fhir.kemkes.go.id/id/ihs-number|P02000000001'],
    ['no parameter at all', 'Practitioner'],
    ['Location by identifier', 'Location?identifier=x|y'],
    ['Encounter by subject', 'Encounter?subject=Patient/P02000000001'],
    ['an identifier without a system', 'Encounter?identifier=V-1'],
    ['a resource type the mock does not search', 'Organization?_id=99000001'],
  ])('answers 400 for %s', async (_name, path) => {
    const { status, body } = await search(path);
    expect(status).toBe(400);
    expect(body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'not-supported' }] });
  });

  it('answers more than one hit when a seeded entry shares a NIK', async () => {
    const patient = world.patients[0];
    if (!patient) throw new Error('world has no patients');
    await mock.client.seed({ patients: [{ ...patient, ihsNumber: 'P09999999999', name: 'Seeded Twin' }] });

    const { body } = await search(`Patient?identifier=${NIK}|${patient.nik}`);

    expect(body).toMatchObject({ total: 2 });
  });

  it('seeded entries last until the next reset', async () => {
    await mock.client.seed({ practitioners: [{ ihsNumber: '19999999999', nik: '1111111111111111', name: 'dr. Seeded', birthDate: '1980-01-01', gender: 'female', role: 'physician' }] });
    expect((await search(`Practitioner?identifier=${NIK}|1111111111111111`)).body).toMatchObject({ total: 1 });

    await mock.client.reset();
    token = await accessToken(mock.baseUrl);

    expect((await search(`Practitioner?identifier=${NIK}|1111111111111111`)).body).toMatchObject({ total: 0 });
  });

  it('rejects invalid seed entries with 400', async () => {
    // Sent raw: the typed client would not let a test build an invalid entry.
    const res = await fetch(new URL('__mock/seed', mock.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patients: [{ nik: 'short' }] }),
    });
    expect(res.status).toBe(400);
  });
});
