import { describe, expect, it } from 'vitest';
import { allTemplates, type Provenance } from '../src/templates/index.js';

const TAGS = ['fhir-spec', 'satusehat-docs', 'sandbox-observed', 'assumed'];

function problems(p: Provenance | undefined): string[] {
  if (!p) return ['no provenance'];
  const out: string[] = [];
  if (!TAGS.includes(p.tag)) out.push(`unknown tag ${String(p.tag)}`);
  if (typeof p.note !== 'string' || p.note.trim() === '') out.push('empty source note');
  else if (p.note.includes('\n')) out.push('source note is not one line');
  if (p.tag === 'satusehat-docs' && !p.link?.startsWith('https://satusehat.kemkes.go.id/')) out.push('satusehat-docs without a docs link');
  if (p.tag === 'sandbox-observed' && !/^\d{4}-\d{2}-\d{2}$/.test(p.checkedOn ?? '')) out.push('sandbox-observed without a check date');
  return out;
}

describe('fixture provenance (#16)', () => {
  const templates = allTemplates();

  it('registers the templates this ticket needs', () => {
    expect(templates.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'token response',
        'token-endpoint throttle 429',
        'search Bundle (0, 1, 2+ hits)',
        '201 create / stored Encounter or MedicationRequest',
        '400 OperationOutcome (validation)',
        'KFA v2 product detail',
        'KFA v2 product not found (404)',
      ]),
    );
  });

  it.each(allTemplates().map((t) => [t.name, t] as const))('%s has provenance on itself and each guessed field', (_name, t) => {
    expect(problems(t.provenance)).toEqual([]);
    for (const [field, p] of Object.entries(t.fields ?? {})) {
      expect(problems(p), field).toEqual([]);
    }
  });

  it('has unique template names', () => {
    const names = templates.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
