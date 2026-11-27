// The big run's one `PUT /__mock/faults`: the committed read and write weight
// groups as the mock's first-hit-wins rules.
import type { FaultRulesInput } from '@integration-hub/mock-satusehat/client';
import type { BigRunCommitments } from './settings.js';

type Rule = FaultRulesInput['rules'][number];
type Kind = Rule['kind'];

/** A fault group: which calls a weight is a percentage of. */
export type FaultGroup = 'reads' | 'writes';

/** The FHIR writes the hub sends, as the mock files them: every create, and the Encounter update. Token requests are POSTs too, so writes are named exactly. */
export const WRITES = [
  { method: 'POST', resourceType: 'Encounter' },
  { method: 'POST', resourceType: 'MedicationRequest' },
  { method: 'POST', resourceType: 'MedicationDispense' },
  { method: 'PUT', resourceType: 'Encounter' },
] as const;

/** One slice of a group's weight: a fault kind with its parameters, in percent of the group's calls. */
interface Slice {
  name: string;
  kind: Kind;
  params: Record<string, unknown>;
  percent: number;
}

/**
 * The fault rules for the committed `faults`, with the committed seed. Reads
 * are every GET (FHIR searches and KFA lookups); writes are the FHIR POSTs and
 * PUTs. The token endpoint (a POST with no resource type) matches neither.
 *
 * The mock tries rules in order and the first that hits wins, each hitting
 * on its own draw, so a slice's rate is its weight given that no earlier
 * slice of the group hit: `weight / (100 - weights before it)`. Each kind's
 * expected share of the group's calls is then its committed weight.
 *
 * Rule ids are `<group>:<kind>[:<variant>]`, so a log entry's `fault` names its group and kind.
 */
export function faultRulesFor(bigRun: BigRunCommitments): FaultRulesInput {
  const { reads, writes, params } = bigRun.faults;
  const holdMs = Math.round(params.timeoutHoldSeconds * 1000);
  const retryAfterSeconds = params.retryAfterSeconds;

  const readSlices: Slice[] = [];
  for (const [kind, percent] of entries(reads.weights)) {
    if (kind === 'http_503') {
      const withRetryAfter = reads.variants.http_503.withRetryAfter;
      readSlices.push({ name: 'http_503:retry-after', kind, params: { retryAfter: { form: 'seconds', seconds: retryAfterSeconds } }, percent: percent * withRetryAfter });
      readSlices.push({ name: 'http_503', kind, params: {}, percent: percent * (1 - withRetryAfter) });
    } else if (kind === 'http_429') {
      const { absent, seconds, httpDate } = reads.variants.http_429.retryAfter;
      const parts = absent + seconds + httpDate;
      readSlices.push({ name: 'http_429', kind, params: {}, percent: (percent * absent) / parts });
      readSlices.push({ name: 'http_429:seconds', kind, params: { retryAfter: { form: 'seconds', seconds: retryAfterSeconds } }, percent: (percent * seconds) / parts });
      readSlices.push({ name: 'http_429:http-date', kind, params: { retryAfter: { form: 'http-date', seconds: retryAfterSeconds } }, percent: (percent * httpDate) / parts });
    } else {
      readSlices.push({ name: kind, kind, params: kind === 'timeout' ? { ms: holdMs } : {}, percent });
    }
  }
  const writeSlices: Slice[] = entries(writes.weights).map(([kind, percent]) => ({
    name: kind,
    kind,
    params: kind === 'timeout' || kind === 'timeout_after_apply' ? { ms: holdMs } : {},
    percent,
  }));

  const rules: Rule[] = [
    ...ruled('reads', readSlices).map(({ id, slice, rate }) => rule(id, { method: 'GET' }, slice, rate)),
    // A write matches one of the four matches, so each is ruled with the same rates.
    ...ruled('writes', writeSlices).flatMap(({ id, slice, rate }) =>
      WRITES.map((match) => rule(`${id}:${match.method}-${match.resourceType}`, { ...match }, slice, rate)),
    ),
  ];
  return { seed: bigRun.seed, rules };
}

/**
 * The group and kind a log entry's `fault` (a rule id from
 * {@link faultRulesFor}) names, or null for a rule id of another form.
 */
export function faultOfRule(ruleId: string): { group: FaultGroup; kind: string } | null {
  const [group, kind] = ruleId.split(':');
  if ((group !== 'reads' && group !== 'writes') || kind === undefined) return null;
  return { group, kind };
}

/** A weights object's entries, keyed by its own kinds. */
function entries<K extends string>(weights: Record<K, number>): [K, number][] {
  // Object.entries widens keys to string; the weights schemas are strict, so every key is one of K.
  return Object.entries(weights) as [K, number][];
}

/** Each slice with its conditional rate, in order. */
function ruled(group: FaultGroup, slices: readonly Slice[]): { id: string; slice: Slice; rate: number }[] {
  let before = 0;
  return slices
    .filter((slice) => slice.percent > 0)
    .map((slice) => {
      const rate = slice.percent / (100 - before);
      before += slice.percent;
      return { id: `${group}:${slice.name}`, slice, rate: Math.min(1, rate) };
    });
}

function rule(id: string, match: Rule['match'], slice: Slice, rate: number): Rule {
  // The kind and its params come from the committed weights, built per kind above.
  return { id, match, kind: slice.kind, params: slice.params, rate } as Rule;
}
