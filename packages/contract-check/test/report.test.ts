import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runContractCheck } from '../src/check.js';
import { bootTarget, scratch, type BootedTarget } from './support/stand-ins.js';

let sandbox: BootedTarget;
let mock: BootedTarget;

beforeEach(async () => {
  [sandbox, mock] = await Promise.all([bootTarget(), bootTarget()]);
});
afterEach(async () => {
  await Promise.all([sandbox.close(), mock.close()]);
});

/** Every string in a JSON value, keys excluded. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

it('quotes no value from either side, even when the sandbox echoes a request with a NIK in its error', async () => {
  const files = await scratch();
  // The stand-in answers person searches with a 400 that quotes the URL (and so the NIK): the most a real error body could leak.
  await sandbox.client.setFaults({
    seed: 1,
    rules: [{ id: 'echo', match: { method: 'GET', resourceType: 'Patient' }, kind: 'http_400', firstN: 1000, params: { echoRequest: true } }],
  });

  const result = await runContractCheck({ sandbox: sandbox.target, mock: mock.target, clock: () => new Date('2026-11-28T03:04:05Z'), ...files });

  expect(result.probes.find((p) => p.name === 'patient-by-nik')?.outcome).toBe('fail');
  const recordings = await Promise.all(
    (await readdir(result.runDir)).filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await readFile(join(result.runDir, n), 'utf8'))),
  );
  // Values of both sides: what was sent and what came back, except what is compared by design:
  // resourceType (`Bundle`), issue severity and code (`invalid`), and short codes like `AMB`.
  const values = new Set(
    recordings.flatMap((r) => [...strings(r.request?.body), ...strings(r.response?.body), r.request?.url].filter((s): s is string => typeof s === 'string')),
  );
  for (const subject of [sandbox.target.subjects, mock.target.subjects]) for (const v of Object.values(subject)) values.add(v);
  values.add(sandbox.target.organizationId);
  const quotable = [...values].filter((v) => v.length >= 6 && !/^[A-Z][A-Za-z]+$/.test(v) && !/^[a-z-]+$/.test(v));
  expect(quotable).toContain(sandbox.target.subjects.patientNik);

  const report = await readFile(join(result.runDir, 'report.md'), 'utf8');
  expect(report).toBe(result.report);
  for (const value of quotable) expect(report, `report quotes "${value}"`).not.toContain(value);
});
