import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as templates from '../src/templates/index.js';
import { observedProvenance, renderSandboxObserved, SANDBOX_OBSERVED_PATH } from '../src/templates/provenance.js';
import { SANDBOX_OBSERVED } from '../src/templates/sandbox-observed.js';

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

describe('the sandbox-observed ledger', () => {
  const declared = { tag: 'assumed', note: 'a guess', fields: { 'meta.versionId': { tag: 'assumed', note: 'format unverified' } } } as const;

  it('re-tags a template the contract check passed as sandbox-observed with its check date', () => {
    expect(observedProvenance(declared, '2026-11-28')).toEqual({
      tag: 'sandbox-observed',
      note: 'contract check passed on 2026-11-28; declared assumed: a guess',
      checkedOn: '2026-11-28',
      fields: declared.fields,
    });
  });

  it('leaves a template the check has not passed as declared', () => {
    expect(observedProvenance(declared, undefined)).toEqual(declared);
  });

  it('names only templates that exist, each under its export name', () => {
    const names = Object.keys(templates);
    for (const name of Object.keys(SANDBOX_OBSERVED)) expect(names, `ledger entry ${name}`).toContain(name);
    for (const [name, template] of Object.entries(templates)) expect(template.templateName, name).toBe(name);
  });

  it('round-trips through its rendered source', () => {
    const source = renderSandboxObserved({ tokenIssued: '2026-11-28', kfaLookup: '2026-11-27' });
    expect(source).toContain("  kfaLookup: '2026-11-27',\n  tokenIssued: '2026-11-28',\n");
    expect(source).toContain('export const SANDBOX_OBSERVED');
  });

  it('is exactly what the contract check writes, so it was not edited by hand', async () => {
    const source = await readFile(SANDBOX_OBSERVED_PATH, 'utf8');
    expect(source).toBe(renderSandboxObserved(SANDBOX_OBSERVED));
  });

  it('gives every sandbox-observed template a check date', () => {
    for (const [name, template] of Object.entries(templates)) {
      if (template.provenance.tag === 'sandbox-observed') expect(template.provenance.checkedOn, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
