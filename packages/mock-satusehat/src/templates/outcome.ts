import type { OperationOutcome } from 'fhir/r4.js';
import { defineTemplate, docs, fhirSpec } from './provenance.js';

/** Code system carrying the hub's step codes (#9) in `issue.details.coding`. */
export const STEP_CODE_SYSTEM = 'urn:mock-satusehat:step-code';
/** Code system naming the exact mock rule that fired. */
export const RULE_CODE_SYSTEM = 'urn:mock-satusehat:rule';

export interface Violation {
  /** Step code from #9, e.g. `PAYLOAD_INVALID`. */
  code: string;
  /** Mock rule id, e.g. `TIME_FORMAT`. */
  rule: string;
  /** FHIRPath-ish location, e.g. `Encounter.period.start`. */
  path: string;
  message: string;
}

export const validationOutcome = defineTemplate({
  name: '400 OperationOutcome (validation)',
  provenance: { tag: 'satusehat-docs', note: 'OperationOutcome error envelope with issue[].severity/code/details', link: docs.validation },
  fields: {
    'issue[].details.coding': { tag: 'assumed', note: 'step and rule codes are the mock\'s own systems, not SATUSEHAT codes' },
    'issue[].expression': { tag: 'fhir-spec', note: 'OperationOutcome.issue.expression' },
  },
  build: (violations: Violation[]): OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: violations.map((v) => ({
      severity: 'error',
      code: v.rule === 'REQUIRED' ? 'required' : 'invalid',
      details: {
        coding: [
          { system: STEP_CODE_SYSTEM, code: v.code },
          { system: RULE_CODE_SYSTEM, code: v.rule },
        ],
        text: v.message,
      },
      expression: [v.path],
    })),
  }),
});

export const simpleOutcome = defineTemplate({
  name: 'OperationOutcome (401 / 404 / bad search)',
  provenance: { tag: 'fhir-spec', note: 'single-issue OperationOutcome', link: fhirSpec.operationOutcome },
  fields: {
    'issue[].details.text': { tag: 'assumed', note: 'wording is the mock\'s own' },
  },
  build: (code: 'security' | 'not-found' | 'not-supported' | 'invalid' | 'throttled', text: string): OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code, details: { text } }],
  }),
});

export const tokenThrottled = defineTemplate({
  name: 'token-endpoint throttle 429',
  provenance: { tag: 'assumed', note: 'docs say 1 req/min after a failure; status and body undocumented, 429 is our choice (#12)' },
  build: (retryAfterSeconds: number) => ({
    resourceType: 'OperationOutcome' as const,
    issue: [{ severity: 'error' as const, code: 'throttled' as const, details: { text: `token endpoint throttled; retry after ${retryAfterSeconds}s` } }],
  }),
});

export const tokenRejected = defineTemplate({
  name: 'token request rejected (401 / 400)',
  provenance: { tag: 'satusehat-docs', note: '4xx error envelope is an OperationOutcome', link: docs.token },
  fields: { 'issue[].details.text': { tag: 'assumed', note: 'wording is the mock\'s own' } },
  build: (text: string): OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'security', details: { text } }],
  }),
});
