import { describe, expect, it } from 'vitest';
import { publishLoadTestSection, updateLoadTestIndex, type IndexedLoadTest } from '../src/loadtest/publish.js';
import { PublishError } from '../src/publish.js';

const run = (overrides: Partial<IndexedLoadTest> = {}): IndexedLoadTest => ({
  dir: '2026-11-27-abc1234',
  kind: 'official',
  verdict: 'PASS',
  gitSha: 'abc1234def5678abc1234def5678abc1234def56',
  startedAt: '2026-11-27T01:00:00.000Z',
  headline: { eventsPerSecond: 200, requestsPerSecond: 200, ingestP95Ms: 41.2, ingestP99Ms: 88.7, non2xxRate: 0 },
  environment: 'Apple M3 Pro, 12 cores, 36 GiB RAM, Darwin 25.1.0, Docker 28.5.1, Node v24.11.0',
  ...overrides,
});

const README = ['# Title', '', '<!-- bigrun:start -->', 'big', '<!-- bigrun:end -->', '', '## Load test results', '', '<!-- loadtest:start -->', 'No official load test yet.', '<!-- loadtest:end -->', '', 'kept'].join('\n');

describe('publishLoadTestSection', () => {
  it('rewrites only the text between the load test markers with the run', () => {
    const published = publishLoadTestSection(README, run());
    const [before, rest] = published.split('<!-- loadtest:start -->');
    const [section, after] = (rest ?? '').split('<!-- loadtest:end -->');
    expect(before).toBe('# Title\n\n<!-- bigrun:start -->\nbig\n<!-- bigrun:end -->\n\n## Load test results\n\n');
    expect(after).toBe('\n\nkept');
    expect(section).toContain('**PASS**');
    expect(section).toContain('results/k6/2026-11-27-abc1234/report.md');
    expect(section).toContain('results/k6/INDEX.md');
    expect(section).toContain('41 ms');
    expect(section).toContain('89 ms');
    expect(section).toContain('Apple M3 Pro');
    expect(section).not.toContain('No official load test yet.');
  });

  it('publishes a FAIL as plainly as a PASS, and refuses an unofficial run or a README without the markers', () => {
    expect(publishLoadTestSection(README, run({ verdict: 'FAIL' }))).toContain('**FAIL**');
    expect(() => publishLoadTestSection(README, run({ kind: 'unofficial' }))).toThrow(PublishError);
    expect(() => publishLoadTestSection('# no markers', run())).toThrow(/loadtest:start/);
  });
});

describe('updateLoadTestIndex', () => {
  it('lists every official run newest first, pass or fail, and replaces a rerun of the same directory', () => {
    const first = updateLoadTestIndex(null, run({ dir: '2026-11-26-aaa1111', verdict: 'FAIL', startedAt: '2026-11-26T01:00:00.000Z' }));
    const second = updateLoadTestIndex(first, run());
    const rows = second.split('\n').filter((l) => l.startsWith('| 2026'));
    expect(rows.map((r) => r.split(' | ')[0])).toEqual(['| 2026-11-27-abc1234', '| 2026-11-26-aaa1111']);
    expect(rows[1]).toContain('[FAIL](2026-11-26-aaa1111/report.md)');
    expect(updateLoadTestIndex(second, run({ verdict: 'FAIL' })).split('\n').filter((l) => l.startsWith('| 2026-11-27'))).toHaveLength(1);
    expect(() => updateLoadTestIndex(null, run({ kind: 'unofficial' }))).toThrow(PublishError);
  });
});
