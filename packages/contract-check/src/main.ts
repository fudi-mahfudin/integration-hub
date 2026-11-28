// `pnpm contract:check` (#48): the composition root of the contract check.
// Reads the sandbox's settings from the environment (`.env.live`), boots a
// mock SATUSEHAT in-process, runs the check and prints the value-free report.
// Exits 0 on pass, 1 on fail, 3 when inconclusive, 2 when it refused to run, 4 when it crashed.
import { SANDBOX_OBSERVED_PATH } from '@integration-hub/mock-satusehat/contract';
import { createMockSatusehat } from '@integration-hub/mock-satusehat/server';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { fileURLToPath } from 'node:url';
import { runContractCheck } from './check.js';
import { ContractCheckRefused, loadContractCheckConfig, loadLiveSeed } from './config.js';
import { mockTarget } from './target.js';

async function main(): Promise<number> {
  const config = loadContractCheckConfig(process.env);
  const subjects = await loadLiveSeed(config.liveSeedPath);
  const mock = await createMockSatusehat(
    { host: '127.0.0.1', port: 0, worldPath: DEFAULT_WORLD_PATH, tokenExpiresInSeconds: 3599, tokenThrottleWindowSeconds: 60 },
    { clock: () => new Date() },
  );
  try {
    const baseUrl = await mock.listen();
    const result = await runContractCheck({
      sandbox: { ...config, subjects },
      mock: mockTarget(baseUrl, await loadWorld(DEFAULT_WORLD_PATH)),
      clock: () => new Date(),
      recordingsDir: config.recordingsDir,
      ledgerPath: fileURLToPath(SANDBOX_OBSERVED_PATH),
    });
    process.stdout.write(result.report);
    process.stdout.write(
      `\nRaw recordings (never commit or share): ${result.runDir}\n` +
        (result.templates.promoted.length + result.templates.failed.length > 0
          ? 'Commit the tag change: git add packages/mock-satusehat/src/templates/sandbox-observed.ts\n'
          : ''),
    );
    return { pass: 0, fail: 1, inconclusive: 3 }[result.outcome];
  } finally {
    await mock.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ContractCheckRefused) {
      process.stderr.write(`contract check refused: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`contract check crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(4);
  },
);
