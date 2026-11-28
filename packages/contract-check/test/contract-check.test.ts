import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSandboxObserved } from '@integration-hub/mock-satusehat/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runContractCheck } from '../src/check.js';
import { bootTarget, scratch, writeLedger, type BootedTarget } from './support/stand-ins.js';

// A second mock stands in for the sandbox: the same requests reach both, and
// a fault rule on the stand-in plays a platform that answers differently.
let sandbox: BootedTarget;
let mock: BootedTarget;

beforeEach(async () => {
  [sandbox, mock] = await Promise.all([bootTarget(), bootTarget()]);
});
afterEach(async () => {
  await Promise.all([sandbox.close(), mock.close()]);
});

const checkedAt = new Date('2026-11-28T03:04:05Z');

describe('a contract check', () => {
  it('passes when both answer every request with the same shape, and re-tags every template it covered', async () => {
    const files = await scratch();
    const result = await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => checkedAt, ...files });

    expect(result.outcome).toBe('pass');
    expect(result.probes.map((p) => [p.name, p.outcome])).toEqual([
      ['token', 'pass'],
      ['kfa-product', 'pass'],
      ['patient-by-nik', 'pass'],
      ['practitioner-by-nik', 'pass'],
      ['pharmacist-by-nik', 'pass'],
      ['location-search', 'pass'],
      ['encounter-create', 'pass'],
      ['encounter-search', 'pass'],
      ['encounter-update', 'pass'],
      ['medication-request-create', 'pass'],
      ['medication-request-search', 'pass'],
      ['medication-dispense-create', 'pass'],
      ['invalid-payload', 'pass'],
      ['bogus-token', 'pass'],
      ['unknown-id', 'pass'],
    ]);
    const covered = [
      'kfaLookup',
      'locationResource',
      'notFound',
      'patientResource',
      'payloadRejected',
      'practitionerResource',
      'searchBundle',
      'storedEncounter',
      'storedMedicationDispense',
      'storedMedicationRequest',
      'tokenIssued',
      'unauthorized',
    ];
    expect(await files.ledger()).toBe(renderSandboxObserved(Object.fromEntries(covered.map((name) => [name, '2026-11-28']))));
  });

  it('sends each run its own business identifiers, so a rerun creates new records instead of finding old ones', async () => {
    await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => checkedAt, ...(await scratch()) });
    await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => new Date(checkedAt.getTime() + 1000), ...(await scratch()) });

    const created = (await sandbox.client.log({ resourceType: 'Encounter' })).filter((e) => e.effect === 'created');
    expect(new Set(created.map((e) => e.businessIdentifier)).size).toBe(2);
    expect((await sandbox.client.report()).duplicates).toEqual([]);
  });

  it('fails a template the sandbox answers differently, drops its earlier re-tag, and keeps a template it could not check', async () => {
    const files = await scratch();
    await writeLedger(files.ledgerPath, { locationResource: '2026-01-01', tokenRejected: '2026-01-01' });
    await sandbox.client.setFaults({ seed: 1, rules: [{ id: 'location-down', match: { path: '/fhir-r4/v1/Location' }, kind: 'http_503', firstN: 1000, params: {} }] });

    const result = await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => checkedAt, ...files });

    expect(result.outcome).toBe('fail');
    const location = result.probes.find((p) => p.name === 'location-search');
    expect(location?.outcome).toBe('fail');
    expect(location?.findings).toContainEqual({ severity: 'fail', where: 'status', what: 'sandbox 503, mock 200' });
    const ledger = await files.ledger();
    expect(ledger).not.toContain('locationResource');
    expect(ledger).not.toContain('searchBundle');
    expect(ledger).toContain("tokenRejected: '2026-01-01'");
    expect(ledger).toContain("storedEncounter: '2026-11-28'");
  });

  it('skips the requests that need an answer the sandbox did not give, and promotes nothing they cover', async () => {
    const files = await scratch();
    await sandbox.client.setFaults({ seed: 1, rules: [{ id: 'no-encounters', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_503', firstN: 1000, params: {} }] });

    const result = await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => checkedAt, ...files });

    const outcomes = Object.fromEntries(result.probes.map((p) => [p.name, p.outcome]));
    expect(outcomes).toMatchObject({ 'encounter-create': 'fail', 'encounter-search': 'skipped', 'medication-dispense-create': 'skipped', 'unknown-id': 'pass' });
    expect(await files.ledger()).not.toContain('storedMedicationDispense');
  });

  it('records every raw answer of both sides, with the client secret and the access token left out', async () => {
    const files = await scratch();
    await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => checkedAt, ...files });

    const runDir = join(files.recordingsDir, '20261128030405');
    const names = await readdir(runDir);
    expect(names).toContain('01-token.sandbox.json');
    expect(names).toContain('15-unknown-id.mock.json');
    expect(names).toContain('report.md');
    const token = JSON.parse(await readFile(join(runDir, '01-token.sandbox.json'), 'utf8'));
    expect(token.response).toMatchObject({ status: 200, body: { access_token: '(redacted)', expires_in: '3599' } });
    const all = (await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readFile(join(runDir, n), 'utf8')))).join('\n');
    expect(all).not.toContain(sandbox.target.clientSecret);
    expect(all).not.toMatch(/Bearer /);
  });
});
