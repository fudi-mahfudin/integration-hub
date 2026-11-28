import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockSatusehatClient } from '@integration-hub/mock-satusehat/client';
import { renderSandboxObserved } from '@integration-hub/mock-satusehat/contract';
import { createMockSatusehat } from '@integration-hub/mock-satusehat/server';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { mockTarget, type Target } from '../../src/target.js';

/** A mock booted on a random port, as a target of the check. */
export interface BootedTarget {
  target: Target;
  client: MockSatusehatClient;
  close(): Promise<void>;
}

/** Boots a mock SATUSEHAT through its composition root and describes it as a target. */
export async function bootTarget(): Promise<BootedTarget> {
  const mock = await createMockSatusehat(
    { host: '127.0.0.1', port: 0, worldPath: DEFAULT_WORLD_PATH, tokenExpiresInSeconds: 3599, tokenThrottleWindowSeconds: 60 },
    { clock: () => new Date() },
  );
  const baseUrl = await mock.listen();
  return { target: mockTarget(baseUrl, await loadWorld(DEFAULT_WORLD_PATH)), client: new MockSatusehatClient(baseUrl), close: () => mock.close() };
}

/** A scratch directory for one test's recordings and ledger. */
export async function scratch(): Promise<{ recordingsDir: string; ledgerPath: string; ledger(): Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'contract-check-'));
  const ledgerPath = join(dir, 'sandbox-observed.ts');
  return { recordingsDir: join(dir, 'recordings'), ledgerPath, ledger: () => readFile(ledgerPath, 'utf8') };
}

/** Writes a ledger listing `observed` (template → date) to `path`. */
export async function writeLedger(path: string, observed: Record<string, string>): Promise<void> {
  await writeFile(path, renderSandboxObserved(observed));
}
