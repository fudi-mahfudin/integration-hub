import { defineTemplate } from './provenance.js';

/** The coding system the mock puts its rejection codes under in `issue.details.coding`. */
export const MOCK_RULE_SYSTEM = 'urn:integration-hub:mock-satusehat:rule';

/** A rejection code the mock reports (#9: the same strings as the hub's step codes 2-5). */
export type RejectionCode = 'PAYLOAD_INVALID';

/** One rule a payload broke. */
export interface Violation {
  code: RejectionCode;
  /** FHIRPath-ish location of the bad element, e.g. `Encounter.period.start`. */
  path: string;
  /** What was wrong, naming the bad value and what was expected. */
  message: string;
}

/** 400 for a payload the mock's validator rejects: one issue per violation. */
export const payloadRejected = defineTemplate(
  {
    tag: 'fhir-spec',
    note: 'FHIR R4 OperationOutcome; rejection codes in issue.details.coding are ours (#9)',
    fields: {
      'issue.details.coding': { tag: 'assumed', note: 'the real platform reports rule numbers in its own form' },
    },
  },
  (violations: readonly Violation[]): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: violations.map((v) => ({
      severity: 'error',
      code: 'invalid',
      details: { coding: [{ system: MOCK_RULE_SYSTEM, code: v.code }], text: v.message },
      expression: [v.path],
    })),
  }),
);

/** 400 for a search parameter the mock doesn't implement: reaching the mock with one is a hub bug. */
export const unsupportedSearch = defineTemplate(
  { tag: 'assumed', note: 'FHIR R4 OperationOutcome; the real platform may ignore unknown parameters instead' },
  (resourceType: string, parameters: readonly string[]): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code: 'not-supported',
        details: {
          text: `${resourceType} search supports only the parameters the hub uses, got "${parameters.join('&') || '(none)'}"`,
        },
      },
    ],
  }),
);

/** 401 for a FHIR call without a valid (unexpired, unrevoked) access token. */
export const unauthorized = defineTemplate(
  { tag: 'assumed', note: 'FHIR R4 OperationOutcome; the real 401 body for a bad token is unverified' },
  (): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'login', details: { text: 'access token is missing, expired or revoked' } }],
  }),
);

/** 404 for a path the mock does not serve. */
export const notFound = defineTemplate(
  { tag: 'fhir-spec', note: 'FHIR R4 RESTful API: unknown resource or path gives 404 with an OperationOutcome' },
  (path: string): fhir4.OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'not-found', details: { text: `no such resource or path: ${path}` } }],
  }),
);
