import { describe, expect, it } from 'vitest';
import { publishSection, updateIndex, type IndexedRun } from '../src/publish.js';

const run = (overrides: Partial<IndexedRun> = {}): IndexedRun => ({
  dir: '2026-11-27-abc1234',
  kind: 'official',
  verdict: 'PASS',
  gitSha: 'abc1234def5678abc1234def5678abc1234def56',
  startedAt: '2026-11-27T01:00:00.000Z',
  headline: {
    events: 10000,
    completedCases: 2000,
    totalSeconds: 1500,
    acceptedEventsPerSecond: 49.8,
    ingestP95Ms: 41,
    endToEndP95Seconds: 95,
    realizedReadFaultRate: 0.301,
    realizedWriteFaultRate: 0.299,
  },
  environment: 'Apple M3 Pro, 12 cores, 36 GiB RAM, Darwin 25.1.0, Docker 28.5.1, Node v24.11.0',
  ...overrides,
});

const README = ['# Title', '', '## Big run results', '', '<!-- bigrun:start -->', 'No official run yet.', '<!-- bigrun:end -->', '', '## After', 'kept'].join('\n');

describe('publishSection', () => {
  it('rewrites only the text between the markers with the latest official run', () => {
    const published = publishSection(README, run());
    const [before, rest] = published.split('<!-- bigrun:start -->');
    const [section, after] = (rest ?? '').split('<!-- bigrun:end -->');
    expect(before).toBe('# Title\n\n## Big run results\n\n');
    expect(after).toBe('\n\n## After\nkept');
    expect(section).toContain('**PASS**');
    expect(section).toContain('results/bigrun/2026-11-27-abc1234/report.md');
    expect(section).toContain('results/bigrun/INDEX.md');
    expect(section).toContain('commits/main/bigrun.commitments.json');
    expect(section).toContain('Apple M3 Pro');
    expect(section).toContain('10,000');
    expect(section).not.toContain('No official run yet.');
  });

  it('publishes again over the section it wrote before', () => {
    const once = publishSection(README, run());
    expect(publishSection(once, run({ dir: '2026-11-28-fff0000', verdict: 'FAIL' }))).toBe(publishSection(README, run({ dir: '2026-11-28-fff0000', verdict: 'FAIL' })));
  });

  it('refuses a run that is not official, and a README without the markers', () => {
    expect(() => publishSection(README, run({ kind: 'ci' }))).toThrow(/official/);
    expect(() => publishSection('# Title', run())).toThrow(/<!-- bigrun:start -->/);
  });
});

describe('updateIndex', () => {
  it('starts the index with the first official run', () => {
    const index = updateIndex(null, run());
    expect(index).toContain('| 2026-11-27-abc1234 |');
    expect(index).toContain('PASS');
  });

  it('keeps every official run, newest first, and lists a rerun of one directory once', () => {
    const first = updateIndex(null, run());
    const second = updateIndex(first, run({ dir: '2026-11-28-fff0000', verdict: 'FAIL' }));
    const rows = second.split('\n').filter((line) => /^\| 2026-/.test(line));
    expect(rows.map((row) => row.split('|')[1]?.trim())).toEqual(['2026-11-28-fff0000', '2026-11-27-abc1234']);
    expect(updateIndex(second, run({ verdict: 'FAIL' })).split('\n').filter((line) => line.startsWith('| 2026-11-27-abc1234'))).toHaveLength(1);
  });

  it('never lists a run that is not official', () => {
    expect(() => updateIndex(null, run({ kind: 'unofficial' }))).toThrow(/official/);
  });
});
