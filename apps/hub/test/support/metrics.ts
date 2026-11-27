import { expect } from 'vitest';

/** One sample of a Prometheus text exposition: a series and its value. */
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** The samples a process's `GET /metrics` exposes now, parsed from the Prometheus text format. */
export async function scrapeMetrics(baseUrl: URL): Promise<Sample[]> {
  const res = await fetch(new URL('metrics', baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return parseExposition(await res.text());
}

function parseExposition(text: string): Sample[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
      if (!match) throw new Error(`not a Prometheus sample line: ${line}`);
      const [, name = '', rawLabels = '', value = ''] = match;
      const labels: Record<string, string> = {};
      for (const [, key = '', raw = ''] of rawLabels.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[key] = raw.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
      }
      return { name, labels, value: Number(value) };
    });
}

/**
 * The value of the one sample named `name` whose labels include `labels`, or
 * the sum over all of them; 0 when none matches (a counter never incremented).
 */
export function valueOf(samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number {
  return samples
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);
}
