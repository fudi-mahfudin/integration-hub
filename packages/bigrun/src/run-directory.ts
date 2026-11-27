// A new results directory for one run, never reusing an existing one.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

/**
 * Creates `<repoRoot><parent>/<base>`, or `<base>-2`, `<base>-3`… when one
 * already exists, so a rerun on the same day and commit never overwrites a
 * run's results. `base` is `<YYYY-MM-DD>-<shortsha>` plus any suffix.
 */
export async function newRunDirectory(repoRoot: string, parent: string, base: string): Promise<{ name: string; path: string }> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const path = `${repoRoot}${parent}/${name}`;
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
      return { name, path };
    }
  }
}

/** A run directory's base name: the run's UTC start date and HEAD's short SHA, `2026-11-27-abc1234`. */
export function runDirectoryBase(at: Date, sha: string): string {
  return `${at.toISOString().slice(0, 10)}-${sha.slice(0, 7)}`;
}
