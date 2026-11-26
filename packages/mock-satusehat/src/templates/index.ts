// Every response template the mock sends. Only the mock reads these
// (the import-boundary rule keeps the hub out). Each one carries provenance.
export { notFound, payloadRejected, unauthorized, unsupportedSearch } from './operation-outcome.js';
export { locationResource, patientResource, practitionerResource, searchBundle, storedEncounter } from './resources.js';
export { tokenIssued, tokenRejected, tokenThrottled } from './token.js';
