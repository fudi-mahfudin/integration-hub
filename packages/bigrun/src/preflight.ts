// What must hold before a big run sends anything: an official run's tree and
// commitments are as committed, and the stack is the committed topology,
// delivering only to the mock.
import type { BigRunCommitments } from './settings.js';

/** What git says about the tree a run starts from. */
export interface GitFacts {
  /** HEAD's full SHA. */
  headSha: string;
  /** `git status --porcelain` lines; empty for a clean tree. */
  uncommitted: string[];
  commitments: {
    /** SHA-256 of the commitments file as read. */
    sha256: string;
    /** The last commit that changed the file, or null if it never was committed. */
    lastCommit: { sha: string; date: string } | null;
    /** Whether the file as read is byte-identical to its version in that commit. */
    matchesLastCommit: boolean;
  };
}

/**
 * Why an official run must not start, or nothing: a dirty tree, or a
 * commitments file that differs from its own last commit (or never had one).
 * Together these make the commitments the run reports provably the committed ones.
 */
export function officialGuard(git: GitFacts): string[] {
  const problems: string[] = [];
  if (git.uncommitted.length > 0) problems.push(`the working tree has uncommitted changes: ${git.uncommitted.map((line) => line.trim()).join(', ')}`);
  const { lastCommit, matchesLastCommit } = git.commitments;
  if (lastCommit === null) problems.push('bigrun.commitments.json has never been committed');
  else if (!matchesLastCommit) problems.push(`bigrun.commitments.json differs from its last commit ${lastCommit.sha.slice(0, 7)}`);
  return problems;
}

/** A running compose container as `docker inspect` shows it. */
export interface ContainerFacts {
  /** Its compose service, e.g. `worker-1`. */
  service: string;
  /** Its CPU limit, or null for none. */
  cpus: number | null;
  /** Its memory limit in bytes, or null for none. */
  memoryBytes: number | null;
  /** Its environment. */
  env: Record<string, string>;
}

/** Where the harness itself sends: the hub service and the mock's control API. */
export interface Targets {
  hubUrl: URL;
  mockUrl: URL;
}

/** The SATUSEHAT base URLs a worker delivers to; each must name the compose service `mock`. */
const SATUSEHAT_URLS = ['SATUSEHAT_AUTH_URL', 'SATUSEHAT_FHIR_URL', 'SATUSEHAT_KFA_URL'] as const;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why the running stack is not the committed one, or nothing: each pinned
 * container with exactly its committed limits, one hub service and the
 * committed number of workers, workers that deliver only to the mock with
 * scheduled reconciliation off, the committed trace sampling, and a hub and
 * mock reached on this machine.
 */
export function checkTopology(bigRun: BigRunCommitments, containers: readonly ContainerFacts[], targets: Targets): string[] {
  const { topology } = bigRun;
  const problems: string[] = [];
  for (const [name, url] of [['hub', targets.hubUrl], ['mock', targets.mockUrl]] as const) {
    if (!LOOPBACK.has(url.hostname)) problems.push(`the ${name} base URL ${url.href} is not on this machine`);
  }

  const hubs = containers.filter((c) => c.service === 'hub');
  const workers = containers.filter((c) => /^worker-\d+$/.test(c.service));
  if (hubs.length !== topology.hubServices) problems.push(`${hubs.length} hub services run, committed ${topology.hubServices}`);
  if (workers.length !== topology.workerProcesses) problems.push(`${workers.length} worker processes run, committed ${topology.workerProcesses}`);

  const { worker, ...single } = topology.composeLimits;
  const pinned = [...Object.entries(single).map(([service, limits]) => ({ service, limits })), ...workers.map((w) => ({ service: w.service, limits: worker }))];
  for (const { service, limits } of pinned) {
    const container = containers.find((c) => c.service === service);
    if (!container) {
      if (service !== 'hub') problems.push(`${service} is not running`);
      continue;
    }
    if (container.cpus !== limits.cpus) problems.push(`${service} runs with ${container.cpus === null ? 'no CPU limit' : `${container.cpus} CPUs`}, committed ${limits.cpus}`);
    const memory = memoryBytes(limits.memory);
    if (container.memoryBytes !== memory) {
      problems.push(`${service} runs with ${container.memoryBytes === null ? 'no memory limit' : `${container.memoryBytes} bytes of memory`}, committed ${limits.memory}`);
    }
  }

  for (const w of workers) {
    for (const name of SATUSEHAT_URLS) {
      const value = w.env[name];
      if (value === undefined || hostOf(value) !== 'mock') problems.push(`${w.service} ${name} is ${value ?? 'unset'}, not the mock`);
    }
    const profile = w.env.SATUSEHAT_PROFILE;
    if (profile !== undefined && profile !== 'mock') problems.push(`${w.service} SATUSEHAT_PROFILE is ${profile}, not mock`);
    if (w.env.RECONCILIATION_INTERVAL_MS !== '0') {
      problems.push(`${w.service} RECONCILIATION_INTERVAL_MS is ${w.env.RECONCILIATION_INTERVAL_MS ?? 'unset'}, not 0: scheduled reconciliation must be off`);
    }
    if (w.env.WORKER_PROCESSES !== String(topology.workerProcesses)) {
      problems.push(`${w.service} WORKER_PROCESSES is ${w.env.WORKER_PROCESSES ?? 'unset'}, committed ${topology.workerProcesses}`);
    }
  }
  for (const c of [...hubs, ...workers]) {
    const ratio = c.env.TRACE_SAMPLE_RATIO;
    if (ratio === undefined || Number(ratio) !== bigRun.tracing.sampleRatio) {
      problems.push(`${c.service} TRACE_SAMPLE_RATIO is ${ratio ?? 'unset'}, committed ${bigRun.tracing.sampleRatio}`);
    }
  }
  return problems;
}

/** A compose memory limit (`512m`, `1g`) in bytes. */
export function memoryBytes(limit: string): number {
  const amount = Number.parseInt(limit, 10);
  return amount * 1024 * 1024 * (limit.endsWith('g') ? 1024 : 1);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a URL at all: certainly not the mock.
    return null;
  }
}
