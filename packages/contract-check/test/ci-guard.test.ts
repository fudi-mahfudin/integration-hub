import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bootTarget, scratch, type BootedTarget } from './support/stand-ins.js';

const run = promisify(execFile);
const main = new URL('../src/main.ts', import.meta.url).pathname;

let sandbox: BootedTarget;
beforeEach(async () => {
  sandbox = await bootTarget();
});
afterEach(async () => {
  await sandbox.close();
});

/** The entry point's environment, pointed at the stand-in sandbox. */
async function envFor(extra: Record<string, string>): Promise<Record<string, string>> {
  const { target } = sandbox;
  const files = await scratch();
  return {
    PATH: process.env.PATH ?? '',
    SATUSEHAT_AUTH_URL: target.authUrl.href,
    SATUSEHAT_FHIR_URL: target.fhirUrl.href,
    SATUSEHAT_KFA_URL: target.kfaUrl.href,
    SATUSEHAT_CLIENT_ID: target.clientId,
    SATUSEHAT_CLIENT_SECRET: target.clientSecret,
    SATUSEHAT_ORGANIZATION_ID: target.organizationId,
    CONTRACT_RECORDINGS_DIR: files.recordingsDir,
    ...extra,
  };
}

it('refuses to run when CI is set, before sending anything', async () => {
  const failure = await run(process.execPath, ['--import', 'tsx', main], { env: await envFor({ CI: 'true' }) }).then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(failure).toMatchObject({ code: 2, stderr: expect.stringContaining('CI is set') });
  expect(await sandbox.client.log()).toEqual([]);
});

it('names the missing credential instead of falling back to a default', async () => {
  const env = await envFor({});
  delete env.SATUSEHAT_CLIENT_SECRET;
  const failure = await run(process.execPath, ['--import', 'tsx', main], { env }).then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(failure).toMatchObject({ code: 2, stderr: expect.stringContaining('SATUSEHAT_CLIENT_SECRET') });
  expect(await sandbox.client.log()).toEqual([]);
});
