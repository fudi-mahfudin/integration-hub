import { createHash, timingSafeEqual } from 'node:crypto';
import { Problem } from '../http/problem.js';
import type { SourceSystems } from './source-systems.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * The operator's static admin API key (#10, #21): it guards mapping
 * administration, replay and abandonment. Holds only the key's hash.
 */
export class AdminKey {
  private readonly hash: Buffer;

  constructor(
    adminApiKey: string,
    private readonly sources: SourceSystems,
  ) {
    this.hash = sha256(adminApiKey);
  }

  /** Whether `Authorization: Bearer <key>` presents the admin key. */
  presentedBy(authorization: string | undefined): boolean {
    const key = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    return key !== undefined && timingSafeEqual(sha256(key), this.hash);
  }

  /**
   * Lets only the admin key through.
   * @throws Problem `FORBIDDEN` (403) for a source system's key; `UNAUTHENTICATED` (401) for a missing or unknown key.
   */
  authenticate(authorization: string | undefined): void {
    if (this.presentedBy(authorization)) return;
    this.sources.authenticate(authorization);
    throw new Problem('FORBIDDEN', []);
  }
}
