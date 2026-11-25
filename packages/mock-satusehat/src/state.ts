import { randomUUID } from 'node:crypto';
import type { Encounter, Resource } from 'fhir/r4.js';
import { FaultEngine } from './faults.js';
import { Holds } from './holds.js';
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

  /** Stored records by resource type, then id. */
  private records = new Map<string, Map<string, Resource>>();
  private versionCounter = 0;

  private tokens = new Map<string, number>();
  private tokenThrottleUntil = 0;

  log: LogEntry[] = [];
  private nextSeq = 1;
  readonly faults = new FaultEngine();
  readonly holds = new Holds();
  private pending = new AbortController();
  /** Bumped on every reset; a request remembers the epoch it arrived in. */
  epoch = 0;

  constructor(
    private readonly world: World,
    readonly settings: MockSettings,
  ) {
    this.reset();
  }

  /** Aborted on reset and shutdown: delayed and parked requests stop waiting. */
  get pendingSignal(): AbortSignal {
    return this.pending.signal;
  }

  /** Drops every parked request and cuts every fault delay short. */
  abortPending(): void {
    this.holds.dropAll();
    this.pending.abort();
    this.pending = new AbortController();
  }

  get faultSeed(): number | null {
    return this.faults.seed;
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
    this.records.clear();
    this.tokens.clear();
    this.tokenThrottleUntil = 0;
    this.epoch += 1;
    this.log = [];
    this.nextSeq = 1;
    this.faults.clear();
    this.abortPending();
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

  recordsOf(type: string): Map<string, Resource> {
    let m = this.records.get(type);
    if (!m) {
      m = new Map();
      this.records.set(type, m);
    }
    return m;
  }

  get encounters(): Map<string, Encounter> {
    return this.recordsOf('Encounter') as Map<string, Encounter>;
  }

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
