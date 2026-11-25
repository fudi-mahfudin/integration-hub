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
    const problem = (await res.json()) as { code: string; errors: { path: string; code: string }[] };
    expect(problem.code).toBe('VALIDATION_FAILED');
    return problem.errors.map(({ path, code }) => ({ path, code }));
  }

  it('reports every violation at once, each with path, code and message', async () => {
    const event = visitStarted({
      data: {
        patient: { nik: '123', mrn: 'MRN-1' },
        encounterClass: 'OUTPATIENT',
        startedAt: '2026-03-02T08:00:00',
        locationCode: undefined,
      },
    });

    const res = await postEvent(hub.baseUrl, { body: event });
    const problem = (await res.json()) as { errors: { path: string; code: string; message: string }[] };

    expect(res.status).toBe(422);
    expect(problem.errors.map(({ path, code }) => ({ path, code }))).toEqual(
      expect.arrayContaining([
        { path: '/data/patient/nik', code: 'INVALID_FORMAT' },
        { path: '/data/encounterClass', code: 'INVALID_FORMAT' },
        { path: '/data/locationCode', code: 'REQUIRED' },
        { path: '/data/startedAt', code: 'TIME_OFFSET_MISSING' },
      ]),
    );
    expect(problem.errors).toHaveLength(4);
    for (const e of problem.errors) expect(e.message).not.toBe('');
  });

  it.each([
    ['naive', '2026-03-02T08:00:00'],
    ['date only', '2026-03-02'],
    ['without seconds', '2026-03-02T08:00'],
  ])('a %s time is TIME_OFFSET_MISSING', async (_, startedAt) => {
    expect(await violations(visitStarted({ data: { startedAt } }))).toEqual([
      { path: '/data/startedAt', code: 'TIME_OFFSET_MISSING' },
    ]);
  });

  it('occurredAt also needs an offset', async () => {
    const event = { ...visitStarted(), occurredAt: '2026-03-02T08:00:00' };

    expect(await violations(event)).toEqual([{ path: '/occurredAt', code: 'TIME_OFFSET_MISSING' }]);
  });

  it.each([
    ['Z', '2026-03-02T01:00:00Z'],
    ['+07:00 with a fraction', '2026-03-02T08:00:00.123+07:00'],
    ['-03:00 without seconds', '2026-03-01T22:00-03:00'],
  ])('a time with an explicit offset (%s) is accepted', async (_, startedAt) => {
    const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { startedAt } }) });

    expect(res.status).toBe(202);
  });

  it('the date floor is compared on the UTC value: 2014-06-03T05:00:00+07:00 is before it', async () => {
    expect(await violations(visitStarted({ data: { startedAt: '2014-06-03T05:00:00+07:00' } }))).toEqual([
      { path: '/data/startedAt', code: 'DATE_BEFORE_FLOOR' },
    ]);
  });

  it('a time exactly on the floor in UTC is accepted: 2014-06-03T07:00:00+07:00', async () => {
    const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { startedAt: '2014-06-03T07:00:00+07:00' } }) });

    expect(res.status).toBe(202);
  });

  it('a nonexistent date is INVALID_FORMAT', async () => {
    expect(await violations(visitStarted({ data: { startedAt: '2026-02-30T08:00:00+07:00' } }))).toEqual([
      { path: '/data/startedAt', code: 'INVALID_FORMAT' },
    ]);
  });

  it.each([
    ['nik', { nik: '9271060312000001', mrn: 'MRN-1' }],
    ['motherNik + birthDate', { motherNik: '9271060312000002', birthDate: '2026-02-01', mrn: 'MRN-1' }],
    ['name + birthDate + gender', { name: 'Pasien Fiktif', birthDate: '1990-05-17', gender: 'female', mrn: 'MRN-1' }],
  ])('a patient identified by %s is accepted', async (_, patient) => {
    const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { patient } }) });

    expect(res.status).toBe(202);
  });

  it.each([
    ['motherNik without birthDate', { motherNik: '9271060312000002', mrn: 'MRN-1' }],
    ['name + birthDate without gender', { name: 'Pasien Fiktif', birthDate: '1990-05-17', mrn: 'MRN-1' }],
    ['only mrn', { mrn: 'MRN-1' }],
  ])('a patient with %s is REQUIRED at /data/patient', async (_, patient) => {
    expect(await violations(visitStarted({ data: { patient } }))).toEqual([{ path: '/data/patient', code: 'REQUIRED' }]);
  });

  it('a patient needs an mrn', async () => {
    expect(await violations(visitStarted({ data: { patient: { nik: '9271060312000001' } } }))).toEqual([
      { path: '/data/patient/mrn', code: 'REQUIRED' },
    ]);
  });

  it('a practitioner may be identified by name + birthDate + gender instead of nik', async () => {
    const practitioner = { name: 'Dokter Fiktif', birthDate: '1980-01-02', gender: 'male' };

    const res = await postEvent(hub.baseUrl, { body: visitStarted({ data: { practitioner } }) });

    expect(res.status).toBe(202);
  });

  it('a practitioner with neither nik nor name + birthDate + gender is REQUIRED', async () => {
    expect(await violations(visitStarted({ data: { practitioner: { name: 'Dokter Fiktif' } } }))).toEqual([
      { path: '/data/practitioner', code: 'REQUIRED' },
    ]);
  });

  it('a missing envelope reports type, visitId, occurredAt and data as REQUIRED', async () => {
    expect(await violations({})).toEqual([
      { path: '/type', code: 'REQUIRED' },
      { path: '/visitId', code: 'REQUIRED' },
      { path: '/occurredAt', code: 'REQUIRED' },
      { path: '/data', code: 'REQUIRED' },
    ]);
  });

  it('an unknown event type is INVALID_FORMAT at /type', async () => {
    const event = { ...visitStarted(), type: 'visit.cancelled' };

    expect(await violations(event)).toEqual([{ path: '/type', code: 'INVALID_FORMAT' }]);
  });

  it('a body that is not JSON is VALIDATION_FAILED', async () => {
    expect(await violations('{ not json')).toEqual([{ path: '', code: 'INVALID_FORMAT' }]);
  });

  it('a rejected event consumes no key: the same key then carries a corrected event', async () => {
    const idempotencyKey = crypto.randomUUID();
    const bad = visitStarted({ data: { startedAt: '2026-03-02T08:00:00' } });

    const rejected = await postEvent(hub.baseUrl, { idempotencyKey, body: bad });
    const fixed = await postEvent(hub.baseUrl, {
      idempotencyKey,
      body: { ...bad, data: { ...bad.data, startedAt: '2026-03-02T08:00:00+07:00' } },
    });

    expect(rejected.status).toBe(422);
    expect(fixed.status).toBe(202);
    expect(fixed.headers.get('idempotent-replayed')).toBeNull();
  });
});
