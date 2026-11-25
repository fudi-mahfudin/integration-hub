import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const hubDir = fileURLToPath(new URL('..', import.meta.url));

describe('migrate command', () => {
  it('is a one-shot command that exits 0 and can be rerun safely', async () => {
    // Global setup has already migrated, so this run finds nothing pending.
    const { stdout } = await run('pnpm', ['run', '--silent', 'migrate'], {
      cwd: hubDir,
      env: process.env,
    });

    expect(stdout).toContain('schema already up to date');
  });
});
