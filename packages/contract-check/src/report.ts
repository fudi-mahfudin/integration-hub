import type { ContractCheckResult } from './check.js';

/**
 * The contract check's report: per request, its outcome and the shape
 * differences found; per template, how its tag changed. It holds no value
 * from either side's answers, so it is the one output that may be shared (#16).
 */
export function renderReport(result: Pick<ContractCheckResult, 'runId' | 'checkedOn' | 'outcome' | 'probes' | 'templates'>): string {
  const lines = [
    `# Contract check ${result.runId}`,
    '',
    `Checked on ${result.checkedOn}: **${result.outcome}**. Shape only (status, headers, key paths and types, resourceType, issue severity/code).`,
    '',
    '| # | Request | Outcome | Fail | Warn | Info |',
    '|---|---|---|---|---|---|',
    ...result.probes.map((p, i) => {
      const count = (severity: string) => p.findings.filter((f) => f.severity === severity).length;
      return `| ${i + 1} | ${p.name} | ${p.outcome} | ${count('fail')} | ${count('warn')} | ${count('info')} |`;
    }),
    '',
  ];
  for (const probe of result.probes) {
    if (probe.findings.length === 0 && probe.error === undefined) continue;
    lines.push(`## ${probe.name}`, '');
    if (probe.error !== undefined) lines.push(`- error: ${probe.error}`);
    for (const f of probe.findings) lines.push(`- ${f.severity}: \`${f.where}\`: ${f.what}`);
    lines.push('');
  }
  const list = (names: readonly string[]) => (names.length === 0 ? '(none)' : names.join(', '));
  lines.push(
    '## Templates',
    '',
    `- re-tagged sandbox-observed (${result.checkedOn}): ${list(result.templates.promoted)}`,
    `- failed, re-tag dropped: ${list(result.templates.failed)}`,
    `- not checked, left as they were: ${list(result.templates.unchanged)}`,
    '',
  );
  return lines.join('\n');
}
