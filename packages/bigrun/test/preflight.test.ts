import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTopology, officialGuard, type ContainerFacts, type GitFacts } from '../src/preflight.js';
import { loadSettings } from '../src/settings.js';

const { bigRun } = loadSettings(JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8')), []);

const cleanGit: GitFacts = {
  headSha: 'a'.repeat(40),
  uncommitted: [],
  commitments: { sha256: 'f'.repeat(64), lastCommit: { sha: 'b'.repeat(40), date: '2026-11-27T10:00:00+07:00' }, matchesLastCommit: true },
};

describe('officialGuard', () => {
  it('lets an official run start from a clean tree whose commitments are as committed', () => {
    expect(officialGuard(cleanGit)).toEqual([]);
  });

  it('refuses a dirty tree, naming what is uncommitted', () => {
    expect(officialGuard({ ...cleanGit, uncommitted: [' M compose.yaml', '?? notes.txt'] })).toEqual([
      'the working tree has uncommitted changes: M compose.yaml, ?? notes.txt',
    ]);
  });

  it('refuses commitments that changed since their own commit, or were never committed', () => {
    expect(officialGuard({ ...cleanGit, commitments: { ...cleanGit.commitments, matchesLastCommit: false } })).toEqual([
      `bigrun.commitments.json differs from its last commit ${'b'.repeat(7)}`,
    ]);
    expect(officialGuard({ ...cleanGit, commitments: { ...cleanGit.commitments, lastCommit: null, matchesLastCommit: false } })).toEqual([
      'bigrun.commitments.json has never been committed',
    ]);
  });
});

const MiB = 1024 * 1024;
const workerEnv = {
  SATUSEHAT_AUTH_URL: 'http://mock:3001/oauth2/v1/',
  SATUSEHAT_FHIR_URL: 'http://mock:3001/fhir-r4/v1/',
  SATUSEHAT_KFA_URL: 'http://mock:3001/kfa-v2/',
  WORKER_PROCESSES: '2',
  RECONCILIATION_INTERVAL_MS: '0',
  TRACE_SAMPLE_RATIO: '0.05',
};
const pinned: ContainerFacts[] = [
  { service: 'hub', cpus: 1, memoryBytes: 512 * MiB, env: { TRACE_SAMPLE_RATIO: '0.05' } },
  { service: 'worker-1', cpus: 1, memoryBytes: 512 * MiB, env: workerEnv },
  { service: 'worker-2', cpus: 1, memoryBytes: 512 * MiB, env: workerEnv },
  { service: 'mock', cpus: 1, memoryBytes: 512 * MiB, env: {} },
  { service: 'postgres', cpus: 2, memoryBytes: 1024 * MiB, env: {} },
  { service: 'redis', cpus: 0.5, memoryBytes: 256 * MiB, env: {} },
  { service: 'prometheus', cpus: 0.5, memoryBytes: 512 * MiB, env: {} },
  { service: 'jaeger', cpus: 1, memoryBytes: 1024 * MiB, env: {} },
];
const targets = { hubUrl: new URL('http://localhost:3000/'), mockUrl: new URL('http://127.0.0.1:3001/') };
const replaced = (service: string, change: Partial<ContainerFacts>) => pinned.map((c) => (c.service === service ? { ...c, ...change } : c));

describe('checkTopology', () => {
  it('accepts the committed topology: one hub, two workers, the pinned limits, delivering to the mock', () => {
    expect(checkTopology(bigRun, pinned, targets)).toEqual([]);
  });

  it('refuses a container whose limits are not the committed ones, or a missing one', () => {
    expect(checkTopology(bigRun, replaced('postgres', { cpus: 4 }), targets)).toEqual(['postgres runs with 4 CPUs, committed 2']);
    expect(checkTopology(bigRun, replaced('redis', { memoryBytes: null }), targets)).toEqual(['redis runs with no memory limit, committed 256m']);
    expect(checkTopology(bigRun, pinned.filter((c) => c.service !== 'worker-2'), targets)).toEqual(['1 worker processes run, committed 2']);
    expect(checkTopology(bigRun, pinned.filter((c) => c.service !== 'prometheus'), targets)).toEqual(['prometheus is not running']);
  });

  it('refuses workers delivering anywhere but the mock', () => {
    const live = { ...workerEnv, SATUSEHAT_FHIR_URL: 'https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1/' };
    expect(checkTopology(bigRun, replaced('worker-1', { env: live }), targets)).toEqual([
      'worker-1 SATUSEHAT_FHIR_URL is https://api-satusehat-stg.dto.kemkes.go.id/fhir-r4/v1/, not the mock',
    ]);
    expect(checkTopology(bigRun, replaced('worker-2', { env: { ...workerEnv, SATUSEHAT_PROFILE: 'live-sandbox' } }), targets)).toEqual([
      'worker-2 SATUSEHAT_PROFILE is live-sandbox, not mock',
    ]);
  });

  it('refuses a hub or mock base URL off this machine', () => {
    expect(checkTopology(bigRun, pinned, { ...targets, mockUrl: new URL('https://mock.example.org/') })).toEqual([
      'the mock base URL https://mock.example.org/ is not on this machine',
    ]);
  });

  it('refuses scheduled reconciliation, or another trace sampling than committed', () => {
    expect(checkTopology(bigRun, replaced('worker-1', { env: { ...workerEnv, RECONCILIATION_INTERVAL_MS: '900000' } }), targets)).toEqual([
      'worker-1 RECONCILIATION_INTERVAL_MS is 900000, not 0: scheduled reconciliation must be off',
    ]);
    expect(checkTopology(bigRun, replaced('hub', { env: {} }), targets)).toEqual(['hub TRACE_SAMPLE_RATIO is unset, committed 0.05']);
  });
});
