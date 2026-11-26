import { describe, expect, it } from 'vitest';
import * as templates from '../src/templates/index.js';

const TAGS = ['fhir-spec', 'satusehat-docs', 'sandbox-observed', 'assumed'];

function checkNote(name: string, note: unknown): void {
  expect(note, name).toMatchObject({ tag: expect.any(String), note: expect.any(String) });
  if (typeof note !== 'object' || note === null || !('tag' in note) || !('note' in note)) return;
  expect(TAGS, `${name}: tag`).toContain(note.tag);
  expect(String(note.note).trim(), `${name}: note`).not.toBe('');
  expect(String(note.note), `${name}: note is one line`).not.toContain('\n');
  if (note.tag === 'satusehat-docs') {
    expect('link' in note && String(note.link), `${name}: satusehat-docs needs a link`).toMatch(/^https:\/\/satusehat\.kemkes\.go\.id\//);
  }
}

describe('fixture templates', () => {
  const entries = Object.entries(templates);

  it('are exported for this check', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s carries provenance for itself and each guessed field', (name, template) => {
    const provenance: unknown = 'provenance' in template ? template.provenance : undefined;
    checkNote(name, provenance);
    const fields = typeof provenance === 'object' && provenance !== null && 'fields' in provenance ? provenance.fields : {};
    for (const [field, note] of Object.entries(fields ?? {})) checkNote(`${name}.${field}`, note);
  });
});
