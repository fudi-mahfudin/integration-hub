import type { LogEntry, Report } from './log.js';

/** Expected per-visit order of effects (#12). */
const STAGE: Record<string, number> = {
  'Encounter created': 0,
  'MedicationRequest created': 1,
  'MedicationDispense created': 2,
  'Encounter updated': 3,
};

/**
 * Invariant violations computed from a log alone, so the same function can
 * re-check a saved `log.ndjson`. Rejected or pre-apply-faulted requests have
 * `effect: none` and never count.
 */
export function reportFromLog(log: readonly LogEntry[], faultSeed: number | null): Report {
  const platform = [...log].filter((e) => e.kind === 'platform').sort((a, b) => a.seq - b.seq);
  return {
    faultSeed,
    duplicateSubmissions: duplicates(platform),
    outOfOrderEffects: outOfOrder(platform),
    overlappingInFlight: overlaps(platform),
  };
}

function duplicates(log: LogEntry[]): Report['duplicateSubmissions'] {
  const groups = new Map<string, Report['duplicateSubmissions'][number]>();
  for (const e of log) {
    let key: string | null = null;
    if (e.effect === 'created' && e.resourceType && e.businessIdentifier) key = e.businessIdentifier;
    // Update visit: more than one applied change per visit.
    if (e.effect === 'updated' && e.resourceType === 'Encounter' && e.visitKey) key = e.visitKey;
    if (key === null || e.effect === 'none') continue;
    const id = `${e.resourceType}\u0000${e.effect}\u0000${key}`;
    const g = groups.get(id) ?? { resourceType: e.resourceType!, key, effect: e.effect, seqs: [] };
    g.seqs.push(e.seq);
    groups.set(id, g);
  }
  return [...groups.values()].filter((g) => g.seqs.length > 1);
}

function outOfOrder(log: LogEntry[]): Report['outOfOrderEffects'] {
  const latest = new Map<string, { seq: number; effect: string; stage: number }>();
  const out: Report['outOfOrderEffects'] = [];
  for (const e of log) {
    if (e.effect === 'none' || !e.visitKey) continue;
    const name = `${e.resourceType} ${e.effect}`;
    const stage = STAGE[name];
    if (stage === undefined) continue;
    const prev = latest.get(e.visitKey);
    if (prev && stage < prev.stage) {
      out.push({ visitKey: e.visitKey, seq: e.seq, effect: name, after: { seq: prev.seq, effect: prev.effect } });
      continue;
    }
    latest.set(e.visitKey, { seq: e.seq, effect: name, stage });
  }
  return out;
}

function overlaps(log: LogEntry[]): Report['overlappingInFlight'] {
  const byVisit = new Map<string, LogEntry[]>();
  for (const e of log) {
    if (!e.visitKey) continue;
    byVisit.set(e.visitKey, [...(byVisit.get(e.visitKey) ?? []), e]);
  }
  const out: Report['overlappingInFlight'] = [];
  for (const [visitKey, entries] of byVisit) {
    const spans = entries.map((e) => ({ seq: e.seq, from: Date.parse(e.receivedAt), to: Date.parse(e.respondedAt) }));
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i]!;
        const b = spans[j]!;
        // Strict: a request that starts the moment another responds is sequential.
        if (a.from < b.to && b.from < a.to) {
          out.push({ visitKey, seqs: a.seq < b.seq ? [a.seq, b.seq] : [b.seq, a.seq] });
        }
      }
    }
  }
  return out.sort((x, y) => x.seqs[0] - y.seqs[0] || x.seqs[1] - y.seqs[1]);
}
