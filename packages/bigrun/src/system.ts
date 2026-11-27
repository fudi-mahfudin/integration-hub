// What the harnesses do on the machine they run on: read git, bring compose
// up and inspect it, and run k6. Each command's output is parsed here, at the boundary.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isWorker, type ContainerFacts, type GitFacts } from './preflight.js';

const exec = promisify(execFile);

/** Runs a command in the repository and resolves to its trimmed stdout; rejects naming the command on failure. */
async function run(repoRoot: string, command: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await exec(command, args, { cwd: repoRoot, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new Error(`\`${command} ${args.join(' ')}\` failed`, { cause: err });
  }
}

/** The commitments file's name, relative to the repository root. */
export const COMMITMENTS_FILE = 'bigrun.commitments.json';

/** What git says about the tree and the commitments file. */
export async function readGitFacts(repoRoot: string): Promise<GitFacts> {
  const content = await readFile(`${repoRoot}/${COMMITMENTS_FILE}`);
  const last = await run(repoRoot, 'git', ['log', '-1', '--format=%H %cI', '--', COMMITMENTS_FILE]);
  const [sha, date] = last.split(' ');
  const lastCommit = sha && date ? { sha, date } : null;
  let matchesLastCommit = false;
  if (lastCommit) {
    const committedBlob = await run(repoRoot, 'git', ['rev-parse', `${lastCommit.sha}:${COMMITMENTS_FILE}`]);
    const workingBlob = await run(repoRoot, 'git', ['hash-object', COMMITMENTS_FILE]);
    matchesLastCommit = committedBlob === workingBlob;
  }
  const status = await run(repoRoot, 'git', ['status', '--porcelain']);
  return {
    headSha: await run(repoRoot, 'git', ['rev-parse', 'HEAD']),
    uncommitted: status === '' ? [] : status.split('\n'),
    commitments: { sha256: createHash('sha256').update(content).digest('hex'), lastCommit, matchesLastCommit },
  };
}

/** The services a big run needs; compose starts their dependencies (the one-shot `migrate`) too. */
const INFRASTRUCTURE = ['postgres', 'redis', 'prometheus', 'jaeger'];
const APPLICATION = ['mock', 'hub', 'worker-1', 'worker-2'];

/**
 * Brings the stack up for a run: the infrastructure as it is, then the mock,
 * hub service and workers built and recreated, so the mock starts empty and
 * every process runs with `env` (trace sampling, reconciliation off).
 */
export async function composeUp(repoRoot: string, env: Record<string, string>): Promise<void> {
  await run(repoRoot, 'docker', ['compose', 'up', '-d', '--wait', ...INFRASTRUCTURE], env);
  await run(repoRoot, 'docker', ['compose', '--profile', 'app', 'up', '-d', '--build', '--wait', '--force-recreate', ...APPLICATION], env);
}

/**
 * Removes the Postgres and Redis containers with their anonymous volumes, so
 * the next `composeUp` starts both empty: no cases from an earlier run, and a
 * cold IHS-number cache (#47). Every run of a Cache run starts from the same state.
 */
export async function resetDataStores(repoRoot: string): Promise<void> {
  await run(repoRoot, 'docker', ['compose', '--profile', 'app', 'rm', '--stop', '--force', '-v', 'postgres', 'redis']);
}

const psLine = z.object({ ID: z.string(), Service: z.string() });
const inspected = z.array(
  z.object({
    Id: z.string(),
    HostConfig: z.object({ NanoCpus: z.number(), Memory: z.number() }),
    Config: z.object({ Env: z.array(z.string()).nullable() }),
  }),
);

/** Every running container of the compose project, with its limits and environment. */
export async function inspectContainers(repoRoot: string): Promise<ContainerFacts[]> {
  const ps = await run(repoRoot, 'docker', ['compose', '--profile', 'app', 'ps', '--format', 'json']);
  // Compose prints one JSON object per line (v2.21+) or one array (before).
  const rows = ps.startsWith('[') ? z.array(psLine).parse(JSON.parse(ps)) : ps.split('\n').filter(Boolean).map((line) => psLine.parse(JSON.parse(line)));
  if (rows.length === 0) return [];
  const details = inspected.parse(JSON.parse(await run(repoRoot, 'docker', ['inspect', ...rows.map((r) => r.ID)])));
  return rows.flatMap((row) => {
    const detail = details.find((d) => d.Id.startsWith(row.ID));
    if (!detail) return [];
    const env = Object.fromEntries((detail.Config.Env ?? []).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    return [
      {
        service: row.Service,
        cpus: detail.HostConfig.NanoCpus === 0 ? null : detail.HostConfig.NanoCpus / 1e9,
        memoryBytes: detail.HostConfig.Memory === 0 ? null : detail.HostConfig.Memory,
        env,
      },
    ];
  });
}

/** The machine a run ran on, captured automatically for the report. */
export interface Environment {
  cpuModel: string;
  cores: number;
  ramGiB: number;
  os: string;
  node: string;
  docker: string;
  compose: string;
  /** What Docker itself has: on macOS and Windows, its VM's share of the machine. */
  dockerCpus: number;
  dockerRamGiB: number;
  workerProcesses: number;
  /** Each container's limits as it actually ran. */
  containerLimits: { service: string; cpus: number | null; memoryBytes: number | null }[];
}

/** Captures the environment; the containers are those the topology check passed. */
export async function captureEnvironment(repoRoot: string, containers: readonly ContainerFacts[]): Promise<Environment> {
  const [dockerVersion, composeVersion, dockerInfo] = await Promise.all([
    run(repoRoot, 'docker', ['version', '--format', '{{.Server.Version}}']),
    run(repoRoot, 'docker', ['compose', 'version', '--short']),
    run(repoRoot, 'docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}']),
  ]);
  const [dockerCpus, dockerMem] = dockerInfo.split(' ').map(Number);
  const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
  return {
    cpuModel: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.cpus().length,
    ramGiB: gib(os.totalmem()),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    docker: dockerVersion,
    compose: composeVersion,
    dockerCpus: dockerCpus ?? 0,
    dockerRamGiB: gib(dockerMem ?? 0),
    workerProcesses: containers.filter(isWorker).length,
    containerLimits: containers.map(({ service, cpus, memoryBytes }) => ({ service, cpus, memoryBytes })).toSorted((a, b) => a.service.localeCompare(b.service)),
  };
}

/** `docker compose` arguments that run the load test's k6 once, as the compose service `k6` (profile `loadtest`) beside the running stack. */
const K6_COMPOSE_RUN = ['compose', '--profile', 'loadtest', 'run', '--rm', '--no-deps'];

/** The k6 version the compose service `k6` runs, as `k6 version` prints it. */
export async function k6Version(repoRoot: string): Promise<string> {
  return run(repoRoot, 'docker', [...K6_COMPOSE_RUN, 'k6', 'version']);
}

/**
 * Runs the load test's k6 script in the compose service `k6`, its output
 * shown as it comes, on the run directory `containerDir` (as the container
 * mounts it), with `apiKey` the source API key it sends with, passed in its
 * environment so it is never written to the run directory. It runs as this
 * user, so the files it writes there are ours.
 * Resolves to k6's exit code: 0, 99 when a threshold was crossed, anything
 * else when k6 itself failed.
 */
export function runK6(repoRoot: string, containerDir: string, apiKey: string): Promise<number> {
  const user = process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...K6_COMPOSE_RUN, ...user, '-e', `LOADTEST_DIR=${containerDir}`, '-e', 'LOADTEST_API_KEY', 'k6'], {
      cwd: repoRoot,
      env: { ...process.env, LOADTEST_API_KEY: apiKey },
      stdio: 'inherit',
    });
    child.on('error', (err) => reject(new Error('starting k6 through `docker compose run` failed', { cause: err })));
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}
