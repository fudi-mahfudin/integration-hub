import { createHash, timingSafeEqual } from 'node:crypto';
import type { Brand } from '../brand.js';
import type { SourceSystemConfig } from '../config.js';
import { Problem } from '../http/problem.js';

/** A source system's stable id; part of every case and idempotency key. */
export type SourceSystemId = Brand<string, 'SourceSystemId'>;

/** A SATUSEHAT Organization id, configured per source system (#10). */
export type OrganizationId = Brand<string, 'OrganizationId'>;

/** The authenticated caller. Its identity always comes from the API key, never the body (#6). */
export interface SourceSystem {
  id: SourceSystemId;
  organizationId: OrganizationId;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Resolves `Authorization: Bearer <key>` to its source system: one static API
 * key per source system. Holds only hashes of the keys.
 */
export class SourceSystems {
  private readonly byKeyHash: { hash: Buffer; source: SourceSystem }[];

  constructor(sources: readonly SourceSystemConfig[]) {
    this.byKeyHash = sources.map((s) => ({
      hash: sha256(s.apiKey),
      // Config validated both ids as non-empty strings at startup; this is where they get their domain types.
      source: { id: s.id as SourceSystemId, organizationId: s.organizationId as OrganizationId },
    }));
  }

  /** @throws Problem `UNAUTHENTICATED` (401) on a missing, malformed or unknown key. */
  authenticate(authorization: string | undefined): SourceSystem {
    const match = /^Bearer (\S+)$/.exec(authorization ?? '');
    const presentedKey = match?.[1];
    if (presentedKey !== undefined) {
      const presented = sha256(presentedKey);
      // Compare against every entry so timing does not reveal which keys exist.
      let found: SourceSystem | undefined;
      for (const entry of this.byKeyHash) {
        if (timingSafeEqual(entry.hash, presented)) found = entry.source;
      }
      if (found) return found;
    }
    throw new Problem('UNAUTHENTICATED', []);
  }
}
