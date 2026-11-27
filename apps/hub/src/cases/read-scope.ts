import type { AdminKey } from '../auth/admin-key.js';
import type { SourceSystems } from '../auth/source-systems.js';
import type { CaseScope } from './case-summary.js';

/**
 * The cases a read request's key may see: every case for the admin key, a
 * source system's own for its key.
 * @throws Problem `UNAUTHENTICATED` for a missing or unknown key.
 */
export function readScopeOf(authorization: string | undefined, keys: { admin: AdminKey; sources: SourceSystems }): CaseScope {
  return keys.admin.presentedBy(authorization) ? 'operator' : { sourceSystemId: keys.sources.authenticate(authorization).id };
}
