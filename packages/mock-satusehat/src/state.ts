import { randomUUID } from 'node:crypto';
import type { Encounter } from 'fhir/r4.js';
import type { LogEntry } from './log.js';
import type { KfaProduct, World, WorldLocation, WorldPatient, WorldPractitioner, WorldSeed } from './world/world.js';

export interface MockSettings {
  tokenExpiresInSeconds: number;
  tokenThrottleWindowMs: number;
}

/** All mock state, in memory. `reset()` returns it to the loaded world. */
export class MockState {
  patientsByNik = new Map<string, WorldPatient>();
  practitionersByNik = new Map<string, WorldPractitioner>();
  locationsById = new Map<string, WorldLocation>();
  kfaByCode = new Map<string, KfaProduct>();
  organizationIds = new Set<string>();

  encounters = new Map<string, Encounter>();
  private versionCounter = 0;

  private tokens = new Map<string, number>();
  private tokenThrottleUntil = 0;

  log: LogEntry[] = [];
  private nextSeq = 1;
  faultSeed: number | null = null;

  constructor(
    private readonly world: World,
    readonly settings: MockSettings,
  ) {
    this.reset();
  }

  get organization() {
    return this.world.organization;
  }

  reset(): void {
    this.patientsByNik.clear();
    this.practitionersByNik.clear();
    this.locationsById.clear();
    this.kfaByCode.clear();
    this.organizationIds = new Set([this.world.organization.id]);
    this.encounters.clear();
    this.tokens.clear();
    this.tokenThrottleUntil = 0;
    this.log = [];
    this.nextSeq = 1;
    this.faultSeed = null;
    this.seed(this.world);
  }

  seed(s: WorldSeed): void {
    for (const p of s.patients ?? []) this.patientsByNik.set(p.nik, p);
    for (const p of s.practitioners ?? []) this.practitionersByNik.set(p.nik, p);
    for (const l of s.locations ?? []) {
      this.locationsById.set(l.id, l);
      this.organizationIds.add(l.organizationId);
    }
    for (const k of s.kfaProducts ?? []) this.kfaByCode.set(k.code, k);
  }

  // --- tokens -----------------------------------------------------------

  /** Remaining throttle in ms, or 0 if token requests are allowed. */
  tokenThrottleRemainingMs(now: number): number {
    return Math.max(0, this.tokenThrottleUntil - now);
  }

  recordFailedTokenRequest(now: number): void {
    this.tokenThrottleUntil = now + this.settings.tokenThrottleWindowMs;
  }

  issueToken(now: number): string {
    const token = randomUUID().replaceAll('-', '');
    this.tokens.set(token, now + this.settings.tokenExpiresInSeconds * 1000);
    return token;
  }

  isTokenValid(token: string, now: number): boolean {
    const expiresAt = this.tokens.get(token);
    return expiresAt !== undefined && now < expiresAt;
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  // --- records ----------------------------------------------------------

  nextVersionId(): string {
    this.versionCounter += 1;
    return `v${this.versionCounter}-${randomUUID().slice(0, 8)}`;
  }

  // --- log --------------------------------------------------------------

  append(entry: Omit<LogEntry, 'seq'>): LogEntry {
    const full = { seq: this.nextSeq++, ...entry };
    this.log.push(full);
    return full;
  }
}
