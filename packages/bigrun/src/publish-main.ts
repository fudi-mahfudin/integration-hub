// `pnpm bigrun:publish`: publishes the official runs. Every official run whose
// GitHub Release (`bigrun-<dir>`) doesn't exist yet gets one, with its gzipped
// mock log as the asset; then the README's big run section is rewritten from
// the latest official run.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { indexedRunSchema, publishSection } from './publish.js';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const resultsDir = `${repoRoot}results/bigrun`;

/** What publishing reads of a `report.json`. */
const publishedReport = z.object({ summary: indexedRunSchema, mockLog: z.object({ file: z.string(), releaseTag: z.string().nullable() }) });

const names = existsSync(resultsDir) ? (await readdir(resultsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const official: z.infer<typeof publishedReport>[] = [];
for (const name of names) {
  const path = `${resultsDir}/${name}/report.json`;
  if (!existsSync(path)) continue;
  const parsed = publishedReport.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is not a big-run report: ${parsed.error.issues[0]?.message}`);
  if (parsed.data.summary.kind === 'official') official.push(parsed.data);
}
official.sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt));
const latest = official[0];
if (!latest) {
  console.error('no official run to publish: run `pnpm bigrun --official` first');
  process.exit(2);
}

for (const { summary, mockLog } of official) {
  if (mockLog.releaseTag === null) continue;
  if (await releaseExists(mockLog.releaseTag)) continue;
  const asset = `${resultsDir}/${summary.dir}/${mockLog.file}`;
  if (!existsSync(asset)) {
    console.error(`warning: ${asset} is missing, so release ${mockLog.releaseTag} is not created and the report's mock-log link is dead`);
    continue;
  }
  await exec('gh', ['release', 'create', mockLog.releaseTag, asset, '--title', `Big run ${summary.dir} (${summary.verdict})`, '--notes', `The mock SATUSEHAT's submission log of official big run ${summary.dir}. Report: results/bigrun/${summary.dir}/report.md`]);
  console.log(`release ${mockLog.releaseTag} created with ${mockLog.file}`);
}

const readmePath = `${repoRoot}README.md`;
await writeFile(readmePath, publishSection(await readFile(readmePath, 'utf8'), latest.summary));
console.log(`README big run section now shows ${latest.summary.dir} (${latest.summary.verdict}); review and commit it with results/bigrun/`);

/** Whether the release exists; any failure other than "not found" (auth, network) stops publishing. */
async function releaseExists(tag: string): Promise<boolean> {
  try {
    await exec('gh', ['release', 'view', tag]);
    return true;
  } catch (err) {
    const stderr = typeof err === 'object' && err !== null && 'stderr' in err ? String(err.stderr) : '';
    if (/release not found/i.test(stderr)) return false;
    throw new Error(`checking release ${tag} failed: ${stderr.trim() || String(err)}`, { cause: err });
  }
}
