import { createHash, timingSafeEqual } from 'node:crypto';
import type { SourceSystemConfig } from '../config.js';
import { Problem } from '../http/problem.js';

/** The authenticated caller. Identity always comes from the API key, never the body (#6). */
export interface SourceSystem {
  id: string;
  organizationId: string;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Resolves `Authorization: Bearer <key>` to its source system. Only key hashes are held. */
export class SourceSystems {
  private readonly byKeyHash: { hash: Buffer; source: SourceSystem }[];

  constructor(sources: SourceSystemConfig[]) {
    this.byKeyHash = sources.map((s) => ({
      hash: sha256(s.apiKey),
      source: { id: s.id, organizationId: s.organizationId },
    }));
  }

  /** @throws Problem 401 `UNAUTHENTICATED` on a missing, malformed or unknown key. */
  authenticate(authorization: string | undefined): SourceSystem {
    const match = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (match) {
      const presented = sha256(match[1] as string);
      // Compare against every entry so timing does not reveal which keys exist.
      let found: SourceSystem | undefined;
      for (const entry of this.byKeyHash) {
        if (timingSafeEqual(entry.hash, presented)) found = entry.source;
      }
      if (found) return found;
    }
    throw new Problem(401, 'UNAUTHENTICATED');
  }
}
