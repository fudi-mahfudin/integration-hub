import { describe, expect, it } from 'vitest';
import { validEncounter } from './support/encounters.js';
import { encounterSystem, useMock } from './support/platform.js';

const ctx = useMock();

const search = async (visitKey: string) =>
  (await ctx.platform.fhir('GET', `/Encounter?identifier=${encodeURIComponent(`${encounterSystem()}|${visitKey}`)}`)).body;

describe('record mutation behind the hub\'s back', () => {
  it('reads a stored record by id', async () => {
    const created = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-REC0'));
    const read = await ctx.platform.fhir('GET', `/Encounter/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
    expect((await ctx.platform.fhir('GET', '/Encounter/no-such-id')).status).toBe(404);
  });

  it('DELETE: later reads, searches and PUTs see no record (404, never 410)', async () => {
    const created = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-REC1'));
    await ctx.client.deleteRecord('Encounter', created.body.id);

    expect((await ctx.platform.fhir('GET', `/Encounter/${created.body.id}`)).status).toBe(404);
    expect((await search('VISIT-REC1')).total).toBe(0);
    const put = await ctx.platform.fhir('PUT', `/Encounter/${created.body.id}`, { ...created.body, status: 'finished' });
    expect(put.status).toBe(404);
    expect(put.body.resourceType).toBe('OperationOutcome');
  });

  it('PATCH: merge-patches a field divergence and bumps versionId', async () => {
    const created = await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-REC2'));
    const patched = await ctx.client.patchRecord('Encounter', created.body.id, { status: 'finished', statusHistory: null });

    expect(patched.meta!.versionId).not.toBe(created.body.meta.versionId);
    const read = (await ctx.platform.fhir('GET', `/Encounter/${created.body.id}`)).body;
    expect(read).toEqual(patched);
    expect(read.status).toBe('finished');
    expect(read).not.toHaveProperty('statusHistory');
    expect(read.subject).toEqual(created.body.subject);
    expect(read.id).toBe(created.body.id);
  });

  it('POST: inserts a record directly, e.g. two remote matches for one identifier', async () => {
    const inserted = await ctx.client.insertRecord(validEncounter('VISIT-REC3'));
    await ctx.client.insertRecord({ ...validEncounter('VISIT-REC3'), id: 'fixed-id' });
    expect(typeof inserted.id).toBe('string');
    expect(typeof inserted.meta?.versionId).toBe('string');

    const hits = await search('VISIT-REC3');
    expect(hits.total).toBe(2);
    expect((await ctx.platform.fhir('GET', '/Encounter/fixed-id')).status).toBe(200);
  });

  it('logs admin mutations as admin entries that never count as submissions', async () => {
    const inserted = await ctx.client.insertRecord(validEncounter('VISIT-REC4'));
    await ctx.client.insertRecord(validEncounter('VISIT-REC4'));
    await ctx.client.patchRecord('Encounter', inserted.id!, { status: 'finished' });
    await ctx.client.deleteRecord('Encounter', inserted.id!);

    const log = await ctx.client.log();
    expect(log.map((e) => [e.kind, e.method, e.path.replace(inserted.id!, ':id'), e.visitKey])).toEqual([
      ['admin', 'POST', '/__mock/records', 'VISIT-REC4'],
      ['admin', 'POST', '/__mock/records', 'VISIT-REC4'],
      ['admin', 'PATCH', '/__mock/records/Encounter/:id', 'VISIT-REC4'],
      ['admin', 'DELETE', '/__mock/records/Encounter/:id', 'VISIT-REC4'],
    ]);
    expect((await ctx.client.report()).duplicateSubmissions).toEqual([]);
  });

  it('404s an admin mutation of an unknown record', async () => {
    await expect(ctx.client.deleteRecord('Encounter', 'nope')).rejects.toThrow(/404/);
    await expect(ctx.client.patchRecord('Encounter', 'nope', {})).rejects.toThrow(/404/);
  });

  it('reset clears inserted records', async () => {
    await ctx.client.insertRecord({ ...validEncounter('VISIT-REC5'), id: 'gone-after-reset' });
    await ctx.client.reset();
    ctx.platform.forgetToken();
    expect((await ctx.platform.fhir('GET', '/Encounter/gone-after-reset')).status).toBe(404);
  });
});
