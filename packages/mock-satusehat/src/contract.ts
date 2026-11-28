// What the contract check (#48) needs from the mock: which templates exist
// with their provenance, and the ledger that re-tags the ones it passed.
import type { Provenance } from './templates/provenance.js';
import * as templates from './templates/index.js';

export type { Provenance, ProvenanceTag } from './templates/provenance.js';
export { renderSandboxObserved, SANDBOX_OBSERVED_PATH } from './templates/provenance.js';
export { SANDBOX_OBSERVED } from './templates/sandbox-observed.js';

/** The name of a response template, as the ledger lists it. */
export type TemplateName = keyof typeof templates;

/** Every response template's provenance, by name. */
export const TEMPLATE_PROVENANCE: Readonly<Record<TemplateName, Provenance>> = Object.fromEntries(
  Object.entries(templates).map(([name, template]) => [name, template.provenance]),
  // fromEntries loses the key type; the entries are exactly the templates module's exports.
) as Record<TemplateName, Provenance>;
