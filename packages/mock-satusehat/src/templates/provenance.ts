/**
 * Where a fixture's shape comes from (see GLOSSARY.md, Fixture):
 * - `fhir-spec`: the HL7 FHIR R4 specification (CC0);
 * - `satusehat-docs`: a SATUSEHAT documentation page, rewritten with fake values (link only, no content);
 * - `sandbox-observed`: confirmed by a contract check against the sandbox;
 * - `assumed`: a guess; the to-do list for contract and live checks.
 */
export type ProvenanceTag = 'fhir-spec' | 'satusehat-docs' | 'sandbox-observed' | 'assumed';

/** The provenance of a template or of one field inside it. */
export interface ProvenanceNote {
  tag: ProvenanceTag;
  /** One line saying what the source is or why the shape is guessed. */
  note: string;
  /** The source page; required for `satusehat-docs`, and only a link, never copied content. */
  link?: string;
}

/** A template's provenance, plus any field inside it whose shape has a different (usually weaker) source. */
export interface Provenance extends ProvenanceNote {
  /** Per-field notes, keyed by dotted path, e.g. `{ 'meta.versionId': { tag: 'assumed', ... } }`. */
  fields?: Record<string, ProvenanceNote>;
}

/** A typed FHIR response builder that carries its provenance. */
export type Template<Args extends unknown[], Body> = ((...args: Args) => Body) & { readonly provenance: Provenance };

/**
 * Defines a response template. Every template goes through here, so none can
 * exist without provenance; a test checks each one is complete.
 */
export function defineTemplate<Args extends unknown[], Body>(
  provenance: Provenance,
  build: (...args: Args) => Body,
): Template<Args, Body> {
  return Object.assign(build, { provenance });
}

/** SATUSEHAT documentation pages the `satusehat-docs` templates link to. */
export const DOCS = {
  token: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/apis/token/',
  encounter: 'https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/encounter/',
  outpatientGuide: 'https://satusehat.kemkes.go.id/platform/docs/id/interoperability/rme-rawat-jalan/',
  patient: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/patient/',
} as const;
