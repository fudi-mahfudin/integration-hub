/**
 * Where a fixture's shape comes from (#16). `assumed` entries are the to-do
 * list for the contract check; a passing check re-tags them `sandbox-observed`.
 */
export type ProvenanceTag = 'fhir-spec' | 'satusehat-docs' | 'sandbox-observed' | 'assumed';

export interface Provenance {
  tag: ProvenanceTag;
  /** One line: what the shape is based on. */
  note: string;
  /** Required for `satusehat-docs` (a link only, never copied content). */
  link?: string;
  /** For `sandbox-observed`: the contract-check date, YYYY-MM-DD. */
  checkedOn?: string;
}

export interface Template<Args extends unknown[], Body> {
  name: string;
  provenance: Provenance;
  /** Guessed fields inside the template, keyed by JSON path. */
  fields?: Record<string, Provenance>;
  build: (...args: Args) => Body;
}

const registry: Template<any[], unknown>[] = [];

/** Every response body the mock sends is built by a template defined here. */
export function defineTemplate<Args extends unknown[], Body>(t: Template<Args, Body>): Template<Args, Body> {
  registry.push(t as Template<any[], unknown>);
  return t;
}

export function allTemplates(): readonly Template<any[], unknown>[] {
  return registry;
}

export const docs = {
  token: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/authentication/apis/token/',
  encounter: 'https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/encounter/',
  validation: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/validasi/kamus-validasi/',
  patient: 'https://satusehat.kemkes.go.id/platform/docs/id/api-catalogue/onboardings/apis/patient/',
  kfa: 'https://satusehat.kemkes.go.id/platform/docs/id/master-data/kfa/rest-api-kfa/',
  medicationRequest: 'https://satusehat.kemkes.go.id/platform/docs/id/fhir/resources/medication-request/',
  pharmacyGuide: 'https://satusehat.kemkes.go.id/platform/docs/id/interoperability/kefarmasian/',
} as const;

export const fhirSpec = {
  bundle: 'https://hl7.org/fhir/R4/bundle.html',
  operationOutcome: 'https://hl7.org/fhir/R4/operationoutcome.html',
  patient: 'https://hl7.org/fhir/R4/patient.html',
  practitioner: 'https://hl7.org/fhir/R4/practitioner.html',
  location: 'https://hl7.org/fhir/R4/location.html',
  encounter: 'https://hl7.org/fhir/R4/encounter.html',
} as const;
