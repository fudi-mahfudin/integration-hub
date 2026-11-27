// `pnpm bigrun:publish`: publishes the latest official run. Uploads its
// gzipped mock log as the asset of GitHub Release `bigrun-<dir>` (once), then
// rewrites the README's big run section from its report.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publishSection } from './publish.js';
import { indexedRun, type Report } from './report.js';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const resultsDir = `${repoRoot}results/bigrun`;

const runs = existsSync(resultsDir) ? (await readdir(resultsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const reports: Report[] = [];
for (const name of runs) {
  const path = `${resultsDir}/${name}/report.json`;
  // report.json is the harness's own output, in the shape it wrote.
  if (existsSync(path)) reports.push(JSON.parse(await readFile(path, 'utf8')) as Report);
}
const latest = reports.filter((r) => r.kind === 'official').toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
if (!latest) {
  console.error('no official run to publish: run `pnpm bigrun --official` first');
  process.exit(2);
}

const tag = latest.mockLog.releaseTag;
const asset = `${resultsDir}/${latest.dir}/${latest.mockLog.file}`;
if (tag !== null) {
  const released = await exec('gh', ['release', 'view', tag]).then(
    () => true,
    // `gh release view` fails for a release that doesn't exist yet: that is the case handled here.
    () => false,
  );
  if (released) console.log(`release ${tag} already exists; its mock log is not uploaded again`);
  else if (!existsSync(asset)) console.error(`warning: ${asset} is missing, so release ${tag} is not created and the report's mock-log link is dead`);
  else {
    await exec('gh', ['release', 'create', tag, asset, '--title', `Big run ${latest.dir} (${latest.verdict})`, '--notes', `The mock SATUSEHAT's submission log of official big run ${latest.dir}. Report: results/bigrun/${latest.dir}/report.md`]);
    console.log(`release ${tag} created with ${latest.mockLog.file}`);
  }
}

const readmePath = `${repoRoot}README.md`;
await writeFile(readmePath, publishSection(await readFile(readmePath, 'utf8'), indexedRun(latest)));
console.log(`README big run section now shows ${latest.dir} (${latest.verdict}); review and commit it with results/bigrun/`);
