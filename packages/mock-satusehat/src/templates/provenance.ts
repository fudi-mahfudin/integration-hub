/**
 * Where a fixture's shape comes from (see GLOSSARY.md, Fixture):
 * - `fhir-spec`: the HL7 FHIR R4 specification (CC0);
 * - `satusehat-docs`: a SATUSEHAT documentation page, rewritten with fake values (link only, no content);
 * - `sandbox-observed`: confirmed by a contract check against the sandbox;
 * - `assumed`: a guess; the to-do list for contract and live checks.
 */
import { SANDBOX_OBSERVED } from './sandbox-observed.js';

export type ProvenanceTag = 'fhir-spec' | 'satusehat-docs' | 'sandbox-observed' | 'assumed';

/** The provenance of a template or of one field inside it. */
export interface ProvenanceNote {
  tag: ProvenanceTag;
  /** One line saying what the source is or why the shape is guessed. */
  note: string;
  /** The source page; required for `satusehat-docs`, and only a link, never copied content. */
  link?: string;
  /** The date (`YYYY-MM-DD`) of the contract check that confirmed it; only on `sandbox-observed`. */
  checkedOn?: string;
}

/** A template's provenance, plus any field inside it whose shape has a different (usually weaker) source. */
export interface Provenance extends ProvenanceNote {
  /** Per-field notes, keyed by dotted path, e.g. `{ 'meta.versionId': { tag: 'assumed', ... } }`. */
  fields?: Record<string, ProvenanceNote>;
}

/** A typed FHIR response builder that carries its name and provenance. */
export type Template<Args extends unknown[], Body> = ((...args: Args) => Body) & {
  /** Its export name, by which the contract check's ledger lists it. */
  readonly templateName: string;
  readonly provenance: Provenance;
};

/**
 * Defines a response template. Every template goes through here, so none can
 * exist without provenance; a test checks each one is complete. `name` must
 * be its export name: when the contract check has passed it, the ledger in
 * `sandbox-observed.ts` re-tags it `sandbox-observed`.
 */
export function defineTemplate<Args extends unknown[], Body>(
  name: string,
  provenance: Provenance,
  build: (...args: Args) => Body,
): Template<Args, Body> {
  return Object.assign(build, { templateName: name, provenance: observedProvenance(provenance, SANDBOX_OBSERVED[name]) });
}

/**
 * A template's provenance once the contract check has passed it on
 * `checkedOn`: re-tagged `sandbox-observed`, keeping the declared source in
 * the note. Field notes are kept: a passed check confirms the shape, not what
 * a guessed field means. Without a date, the declared provenance as it is.
 */
export function observedProvenance(declared: Provenance, checkedOn: string | undefined): Provenance {
  if (checkedOn === undefined) return declared;
  return {
    ...declared,
    tag: 'sandbox-observed',
    note: `contract check passed on ${checkedOn}; declared ${declared.tag}: ${declared.note}`,
    checkedOn,
  };
}

/** The ledger's source file (from `src/` or `dist/`, both two levels down); the contract check rewrites it. */
export const SANDBOX_OBSERVED_PATH = new URL('../../src/templates/sandbox-observed.ts', import.meta.url);

/**
 * The source of `sandbox-observed.ts` listing `observed` (template name →
 * check date). The contract check writes it; the tag change is committed, the
 * recordings never are.
 */
export function renderSandboxObserved(observed: Readonly<Record<string, string>>): string {
  const lines = Object.entries(observed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, checkedOn]) => `  ${name}: '${checkedOn}',\n`)
    .join('');
  return [
    '// Written by `pnpm contract:check` (#48); commit the change it makes, never edit it by hand.\n',
    '// Each entry is a template the contract check passed, with the date of that check.\n',
    '\n',
    '/** Template export name → the date (`YYYY-MM-DD`) a contract check last passed it. */\n',
    `export const SANDBOX_OBSERVED: Readonly<Record<string, string>> = {\n${lines}};\n`,
  ].join('');
}

/** SATUSEHAT documentation pages the `satusehat-docs` templates link to. */
export const DOCS = {
  token: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/apis/token/',
  encounter: 'https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/encounter/',
  outpatientGuide: 'https://satusehat.kemkes.go.id/platform/docs/id/interoperability/rme-rawat-jalan/',
  patient: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/patient/',
} as const;
