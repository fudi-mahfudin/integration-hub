import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSandboxObserved, TEMPLATE_PROVENANCE, type TemplateName } from '@integration-hub/mock-satusehat/contract';
import { PROBES, type Probe, type ProbeContext, type ProbeRequest } from './probes.js';
import { renderReport } from './report.js';
import { diffExchanges, type Exchange, type Finding } from './shape-diff.js';
import type { Target } from './target.js';

/**
 * What became of one probe: `pass` (no fail finding), `fail`, `skipped`
 * (it needed an answer one side did not give) or `error` (a side gave no
 * answer at all: the sandbox is unavailable, which is no mismatch).
 */
export type ProbeOutcome = 'pass' | 'fail' | 'skipped' | 'error';

/** One probe's result. Findings and the error name shapes only, never values. */
export interface ProbeResult {
  name: string;
  outcome: ProbeOutcome;
  findings: Finding[];
  /** Why a side gave no answer, for `error`. */
  error?: string;
}

/** How each template's sandbox-observed tag changed. */
export interface TemplateChanges {
  /** Passed by this check: re-tagged with its date. */
  promoted: TemplateName[];
  /** Failed by this check: its earlier re-tag, if any, is dropped. */
  failed: TemplateName[];
  /** Not checked or not fully checked: left as it was. */
  unchanged: TemplateName[];
}

/** The result of a contract check: `inconclusive` when nothing failed but something could not be checked. */
export interface ContractCheckResult {
  runId: string;
  checkedOn: string;
  outcome: 'pass' | 'fail' | 'inconclusive';
  probes: ProbeResult[];
  templates: TemplateChanges;
  /** The value-free report, also written next to the recordings; the only output that may be shared. */
  report: string;
  /** Where this run's raw recordings and report are. */
  runDir: string;
}

/** What one run of the check needs. */
export interface ContractCheckDeps {
  sandbox: Target;
  mock: Target;
  clock: () => Date;
  /** Git-ignored directory the raw answers go to, one subdirectory per run. */
  recordingsDir: string;
  /** The mock's `sandbox-observed.ts` ledger, rewritten with this run's promotions. */
  ledgerPath: string;
}

const CALL_TIMEOUT_MS = 15_000;

/**
 * Runs the contract check (#48): sends the fixed requests, in order, to the
 * sandbox and to the mock, records every raw answer, diffs each pair by
 * shape, and re-tags the templates whose every request passed.
 */
export async function runContractCheck(deps: ContractCheckDeps): Promise<ContractCheckResult> {
  const now = deps.clock();
  const runId = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const checkedOn = now.toISOString().slice(0, 10);
  const runDir = join(deps.recordingsDir, runId);
  await mkdir(runDir, { recursive: true });

  const run = { visitId: `CONTRACT-${runId}`, prescriptionId: `CONTRACT-${runId}`, itemId: '1' };
  const sides = {
    sandbox: { target: deps.sandbox, run, now, learned: {} } satisfies ProbeContext,
    mock: { target: deps.mock, run, now, learned: {} } satisfies ProbeContext,
  };

  const probes: ProbeResult[] = [];
  for (const [index, probe] of PROBES.entries()) {
    const prefix = `${String(index + 1).padStart(2, '0')}-${probe.name}`;
    probes.push(await runProbe(probe, sides, (side, recording) => writeFile(join(runDir, `${prefix}.${side}.json`), `${JSON.stringify(recording, null, 2)}\n`)));
  }

  const templates = await updateLedger(deps.ledgerPath, probes, checkedOn);
  const outcome = probes.some((p) => p.outcome === 'fail') ? 'fail' : probes.every((p) => p.outcome === 'pass') ? 'pass' : 'inconclusive';
  const report = renderReport({ runId, checkedOn, outcome, probes, templates });
  await writeFile(join(runDir, 'report.md'), report);
  return { runId, checkedOn, outcome, probes, templates, report, runDir };
}

type Side = 'sandbox' | 'mock';

async function runProbe(probe: Probe, sides: Record<Side, ProbeContext>, record: (side: Side, recording: unknown) => Promise<void>): Promise<ProbeResult> {
  const sandboxRequest = probe.request(sides.sandbox);
  const mockRequest = probe.request(sides.mock);
  if (!sandboxRequest || !mockRequest) return { name: probe.name, outcome: 'skipped', findings: [] };
  const requests: Record<Side, ProbeRequest> = { sandbox: sandboxRequest, mock: mockRequest };

  const answers: Partial<Record<Side, Exchange>> = {};
  for (const side of ['sandbox', 'mock'] as const) {
    const request = requests[side];
    try {
      const { exchange, text } = await send(request);
      answers[side] = exchange;
      await record(side, recordingOf(request, exchange, text));
    } catch (err) {
      // No answer at all (network, timeout): logged by name only, the probe is inconclusive.
      const reason = err instanceof Error ? err.name : 'unknown error';
      await record(side, { request: redactRequest(request), error: reason });
      return { name: probe.name, outcome: 'error', findings: [], error: `${side} gave no answer (${reason})` };
    }
  }
  const { sandbox, mock } = answers;
  if (!sandbox || !mock) throw new Error(`probe ${probe.name} must have both answers once neither failed`);

  const findings = diffExchanges({ sandbox, mock, hubReads: probe.hubReads });
  for (const side of ['sandbox', 'mock'] as const) {
    const answer = answers[side];
    if (!probe.learn || answer?.status !== probe.expectedStatus) continue;
    try {
      probe.learn(sides[side], answer);
    } catch {
      // The body lacks what later probes need: the diff above names the missing paths; later probes are skipped.
      findings.push({ severity: 'fail', where: '(answer)', what: `${side} answer lacks what later requests need` });
    }
  }
  if (sandbox.status !== probe.expectedStatus) {
    findings.push({ severity: 'fail', where: 'status', what: `sandbox ${sandbox.status}, expected ${probe.expectedStatus}` });
  }
  const unique = findings.filter((f, i) => findings.findIndex((g) => g.where === f.where && g.what === f.what) === i);
  return { name: probe.name, outcome: unique.some((f) => f.severity === 'fail') ? 'fail' : 'pass', findings: unique };
}

async function send(request: ProbeRequest): Promise<{ exchange: Exchange; text: string }> {
  const body = request.body === undefined ? undefined : 'form' in request.body ? new URLSearchParams(request.body.form) : JSON.stringify(request.body.json);
  const res = await fetch(request.url, { method: request.method, headers: request.headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: compared as a body without keys; the content-type finding says what it was.
    parsed = undefined;
  }
  return { exchange: { status: res.status, headers, body: parsed }, text };
}

const REDACTED = '(redacted)';

function redactRequest(request: ProbeRequest) {
  const headers = { ...request.headers, ...(request.headers.authorization ? { authorization: REDACTED } : {}) };
  const body = request.body && 'form' in request.body ? { form: { ...request.body.form, client_secret: REDACTED } } : request.body;
  return { method: request.method, url: request.url.href, headers, body };
}

/** The raw exchange, kept only in the git-ignored recordings; credentials and issued tokens are left out. */
function recordingOf(request: ProbeRequest, exchange: Exchange, text: string) {
  const body = exchange.body;
  const redactedBody =
    typeof body === 'object' && body !== null && !Array.isArray(body) && 'access_token' in body ? { ...body, access_token: REDACTED } : body === undefined ? text : body;
  return { request: redactRequest(request), response: { status: exchange.status, headers: exchange.headers, body: redactedBody } };
}

const LEDGER_LINE = /^ {2}(\w+): '(\d{4}-\d{2}-\d{2})',$/;

/** Reads the ledger, refusing one that is not exactly as the check writes it. A missing file is an empty ledger. */
async function readLedger(path: string): Promise<Record<string, string>> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {};
    throw new Error(`the sandbox-observed ledger at "${path}" must be readable`, { cause: err });
  }
  const observed: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const match = LEDGER_LINE.exec(line);
    if (match?.[1] && match[2]) observed[match[1]] = match[2];
  }
  if (renderSandboxObserved(observed) !== source) {
    throw new Error(`the sandbox-observed ledger at "${path}" must be exactly as the contract check writes it; restore it from git`);
  }
  return observed;
}

async function updateLedger(path: string, probes: readonly ProbeResult[], checkedOn: string): Promise<TemplateChanges> {
  const observed = await readLedger(path);
  const changes: TemplateChanges = { promoted: [], failed: [], unchanged: [] };
  // The keys of TEMPLATE_PROVENANCE are exactly the template names.
  for (const name of Object.keys(TEMPLATE_PROVENANCE).sort() as TemplateName[]) {
    const covering = PROBES.flatMap((probe, i) => (probe.templates.includes(name) ? [probes[i]] : []));
    if (covering.some((p) => p?.outcome === 'fail')) {
      delete observed[name];
      changes.failed.push(name);
    } else if (covering.length > 0 && covering.every((p) => p?.outcome === 'pass')) {
      observed[name] = checkedOn;
      changes.promoted.push(name);
    } else {
      changes.unchanged.push(name);
    }
  }
  await writeFile(path, renderSandboxObserved(observed));
  return changes;
}
