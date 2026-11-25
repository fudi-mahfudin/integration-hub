import type { OperationOutcome } from 'fhir/r4.js';
import { defineTemplate, fhirSpec } from './provenance.js';

/** Body of an injected 5xx / 429 / 401 (#33). The real platform's bodies for these are unknown. */
export const faultOutcome = defineTemplate({
  name: 'injected fault OperationOutcome (5xx / 429 / 401)',
  provenance: { tag: 'assumed', note: 'gateway error bodies are undocumented; a single-issue OperationOutcome is our guess', link: fhirSpec.operationOutcome },
  fields: { 'issue[].details.text': { tag: 'assumed', note: 'names the fault rule; the mock\'s own wording' } },
  build: (status: number, ruleId: string): OperationOutcome => ({
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code: status === 401 ? 'security' : status === 429 ? 'throttled' : 'exception',
        details: { text: `injected fault ${ruleId} (${status})` },
      },
    ],
  }),
});
