import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, TEST_SOURCES, visitStarted } from './support/events.js';

describe('ingest: visit.started schema', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES });
  });

  afterAll(async () => {
    await hub?.close();
  });

  async function violations(body: unknown) {
    const res = await postEvent(hub.baseUrl, { body });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const problem = (await res.json()) as { code: string; errors: { path: string; code: string; message: string }[] };
    expect(problem.code).toBe('VALIDATION_FAILED');
    for (const e of problem.errors) expect(e.message).toEqual(expect.any(String));
    return problem.errors.map(({ path, code }) => ({ path, code }));
  }

  it('rejects a body that is not JSON', async () => {
    expect(await violations('{not json')).toEqual([{ path: '', code: 'INVALID_FORMAT' }]);
  });

  it('reports every missing envelope field at once', async () => {
    expect(await violations({})).toEqual([
      { path: '/type', code: 'REQUIRED' },
      { path: '/visitId', code: 'REQUIRED' },
      { path: '/occurredAt', code: 'REQUIRED' },
      { path: '/data', code: 'REQUIRED' },
    ]);
  });

  it('rejects an unknown event type', async () => {
    expect(await violations({ ...visitStarted(), type: 'visit.teleported' })).toEqual([
      { path: '/type', code: 'INVALID_FORMAT' },
    ]);
  });

  it('reports every missing visit.started field at once', async () => {
    const event = { ...visitStarted(), data: {} };

    expect(await violations(event)).toEqual([
      { path: '/data/patient', code: 'REQUIRED' },
      { path: '/data/practitioner', code: 'REQUIRED' },
      { path: '/data/encounterClass', code: 'REQUIRED' },
      { path: '/data/locationCode', code: 'REQUIRED' },
      { path: '/data/startedAt', code: 'REQUIRED' },
    ]);
  });

  it('rejects an encounterClass outside AMB|IMP|EMER', async () => {
    expect(await violations(visitStarted({ data: { encounterClass: 'amb' } }))).toEqual([
      { path: '/data/encounterClass', code: 'INVALID_FORMAT' },
    ]);
  });

  it.each([
    ['nik', { nik: '9271060312000001', mrn: 'M1' }],
    ['motherNik + birthDate', { motherNik: '9271060312000002', birthDate: '2026-02-28', mrn: 'M1' }],
    ['name + birthDate + gender', { name: 'Budi Santoso', birthDate: '1980-01-31', gender: 'male', mrn: 'M1' }],
  ])('accepts a patient identified by %s', async (_label, patient) => {
    const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { patient } }) });

    expect(res.status).toBe(202);
  });

  it('rejects a patient with none of the three identifying combinations', async () => {
    const patient = { name: 'Budi Santoso', birthDate: '1980-01-31', mrn: 'M1' };

    expect(await violations(visitStarted({ data: { patient } }))).toEqual([{ path: '/data/patient', code: 'REQUIRED' }]);
  });

  it('requires the patient mrn and checks field formats', async () => {
    const patient = { nik: '12345', motherNik: 'x', birthDate: '1980-02-30', gender: 'man' };

    expect(await violations(visitStarted({ data: { patient } }))).toEqual([
      { path: '/data/patient/mrn', code: 'REQUIRED' },
      { path: '/data/patient/nik', code: 'INVALID_FORMAT' },
      { path: '/data/patient/motherNik', code: 'INVALID_FORMAT' },
      { path: '/data/patient/birthDate', code: 'INVALID_FORMAT' },
      { path: '/data/patient/gender', code: 'INVALID_FORMAT' },
    ]);
  });

  it('accepts a practitioner by nik or by name + birthDate + gender, and rejects anything else', async () => {
    const byName = { name: 'dr. Siti', birthDate: '1975-05-05', gender: 'female' };
    const accepted = await postEvent(hub.baseUrl, { body: visitStarted({ data: { practitioner: byName } }) });

    expect(accepted.status).toBe(202);
    expect(await violations(visitStarted({ data: { practitioner: { name: 'dr. Siti' } } }))).toEqual([
      { path: '/data/practitioner', code: 'REQUIRED' },
    ]);
  });

  it.each([
    ['naive', '2026-03-02T08:00:00'],
    ['date only', '2026-03-02'],
  ])('rejects a %s time with TIME_OFFSET_MISSING', async (_label, startedAt) => {
    expect(await violations(visitStarted({ data: { startedAt } }))).toEqual([
      { path: '/data/startedAt', code: 'TIME_OFFSET_MISSING' },
    ]);
  });

  it('rejects a time that is not ISO 8601 or not a real instant with INVALID_FORMAT', async () => {
    expect(await violations(visitStarted({ data: { startedAt: 'yesterday' } }))).toEqual([
      { path: '/data/startedAt', code: 'INVALID_FORMAT' },
    ]);
    expect(await violations(visitStarted({ data: { startedAt: '2026-02-30T08:00:00+07:00' } }))).toEqual([
      { path: '/data/startedAt', code: 'INVALID_FORMAT' },
    ]);
  });

  it('accepts Z and any explicit offset', async () => {
    for (const startedAt of ['2026-03-02T01:00:00Z', '2026-03-02T08:00+07:00', '2026-03-02T08:00:00.123-03:30']) {
      const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { startedAt } }) });
      expect(res.status, startedAt).toBe(202);
    }
  });

  it('requires an offset on occurredAt too', async () => {
    expect(await violations({ ...visitStarted(), occurredAt: '2026-03-02T08:00:00' })).toEqual([
      { path: '/occurredAt', code: 'TIME_OFFSET_MISSING' },
    ]);
  });

  it('compares the date floor on the UTC value: 2014-06-03T05:00+07:00 is before 2014-06-03T00:00:00+00:00', async () => {
    expect(await violations(visitStarted({ data: { startedAt: '2014-06-03T05:00+07:00' } }))).toEqual([
      { path: '/data/startedAt', code: 'DATE_BEFORE_FLOOR' },
    ]);

    const atFloor = await postEvent(hub.baseUrl, { body: visitStarted({ data: { startedAt: '2014-06-03T07:00:00+07:00' } }) });
    expect(atFloor.status).toBe(202);
  });

  it('reports envelope and data violations together', async () => {
    const event = { ...visitStarted({ data: { encounterClass: 'X', startedAt: '2001-01-01T00:00:00Z' } }), visitId: '' };

    expect(await violations(event)).toEqual([
      { path: '/visitId', code: 'INVALID_FORMAT' },
      { path: '/data/encounterClass', code: 'INVALID_FORMAT' },
      { path: '/data/startedAt', code: 'DATE_BEFORE_FLOOR' },
    ]);
  });
});
