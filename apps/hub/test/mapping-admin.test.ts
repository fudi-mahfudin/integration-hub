import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { ADMIN_API_KEY, adminRequest, SOURCE_API_KEY, TEST_SOURCES } from './support/events.js';

describe('mapping administration: PUT and DELETE /v1/admin/mappings/{drugs|locations}/{localCode} (#10)', () => {
  let hub: BootedHub;

  beforeAll(async () => {
    hub = await bootHub({ HUB_SOURCES: TEST_SOURCES, HUB_ADMIN_API_KEY: ADMIN_API_KEY });
  });
  afterAll(async () => {
    await hub?.close();
  });

  const fresh = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

  it('upserts a drug mapping with its note and updatedAt, and replaces it on a second PUT', async () => {
    const drugCode = fresh('DRUG');
    const first = await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/drugs/${drugCode}`, {
      body: { source: 'test-source', kfaCode: '92000001', note: 'Parasetamol 500 mg Tablet' },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      source: 'test-source',
      localCode: drugCode,
      kfaCode: '92000001',
      note: 'Parasetamol 500 mg Tablet',
      updatedAt: expect.stringMatching(/Z$/),
    });

    const second = await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/drugs/${drugCode}`, {
      body: { source: 'test-source', kfaCode: '92000002' },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ source: 'test-source', localCode: drugCode, kfaCode: '92000002', note: null, updatedAt: expect.any(String) });
  });

  it('upserts a location mapping', async () => {
    const locationCode = fresh('POLI');
    const res = await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/locations/${locationCode}`, {
      body: { source: 'test-source', locationId: 'b017aa54-f1df-4ec2-9d84-8823815d7228' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'test-source', localCode: locationCode, locationId: 'b017aa54-f1df-4ec2-9d84-8823815d7228', note: null });
  });

  it('deletes a mapping; deleting it again is 404', async () => {
    const drugCode = fresh('DRUG');
    await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/drugs/${drugCode}`, { body: { source: 'test-source', kfaCode: '92000001' } });

    const deleted = await adminRequest(hub.baseUrl, 'DELETE', `v1/admin/mappings/drugs/${drugCode}?source=test-source`);
    expect(deleted.status).toBe(204);
    const again = await adminRequest(hub.baseUrl, 'DELETE', `v1/admin/mappings/drugs/${drugCode}?source=test-source`);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['an unregistered source', { source: 'nobody', kfaCode: '92000001' }, '/source'],
    ['a KFA code that is not digits', { source: 'test-source', kfaCode: 'PCT' }, '/kfaCode'],
    ['no KFA code', { source: 'test-source' }, '/kfaCode'],
    ['an empty note', { source: 'test-source', kfaCode: '92000001', note: '' }, '/note'],
  ])('rejects %s with 422 VALIDATION_FAILED', async (_, body, path) => {
    const res = await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/drugs/${fresh('DRUG')}`, { body });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [expect.objectContaining({ path })] });
  });

  it('is 404 for a mapping kind other than drugs or locations', async () => {
    const res = await adminRequest(hub.baseUrl, 'PUT', `v1/admin/mappings/patients/X`, { body: { source: 'test-source' } });
    expect(res.status).toBe(404);
  });

  it('answers 401 without a key, and 403 FORBIDDEN to a source system’s key', async () => {
    const path = `v1/admin/mappings/drugs/${fresh('DRUG')}`;
    const body = { source: 'test-source', kfaCode: '92000001' };
    const anonymous = await adminRequest(hub.baseUrl, 'PUT', path, { body, apiKey: null });
    expect(anonymous.status).toBe(401);
    const source = await adminRequest(hub.baseUrl, 'PUT', path, { body, apiKey: SOURCE_API_KEY });
    expect(source.status).toBe(403);
    expect(await source.json()).toMatchObject({ code: 'FORBIDDEN' });
    const deleted = await adminRequest(hub.baseUrl, 'DELETE', `${path}?source=test-source`, { apiKey: SOURCE_API_KEY });
    expect(deleted.status).toBe(403);
  });
});
