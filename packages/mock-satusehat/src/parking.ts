import { randomUUID } from 'node:crypto';
import type { Clock } from './clock.js';

/** A request a hold fault parked (GLOSSARY.md, Hold), as `GET /__mock/holds` lists it. */
export interface Hold {
  /** What `POST /__mock/holds/{id}/release` takes. */
  id: string;
  /** The fault rule that parked it. */
  ruleId: string;
  method: string;
  /** Path and query string as received. */
  path: string;
  resourceType: string | null;
  visitKey: string | null;
  businessIdentifier: string | null;
  /** ISO-8601 UTC. */
  parkedAt: string;
}

/**
 * Requests the mock keeps waiting: for a fixed time (a latency or timeout
 * fault), or parked by a hold until a test releases it. Reset and close drop
 * every one of them, so none outlives the state it was received against.
 */
export class Parking {
  private generation = new AbortController();
  private parked = new Map<string, { hold: Hold; release: () => void }>();
  private onPark = new Set<() => void>();

  constructor(private readonly clock: Clock) {}

  /** Resolves `true` after `ms`, or `false` as soon as everything waiting is dropped. */
  wait(ms: number): Promise<boolean> {
    const { signal } = this.generation;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onDrop);
        resolve(true);
      }, ms);
      const onDrop = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener('abort', onDrop, { once: true });
    });
  }

  /** Parks a request until `release` is called with its id: resolves `true` then, or `false` if it is dropped first. */
  hold(request: Omit<Hold, 'id' | 'parkedAt'>): Promise<boolean> {
    const { signal } = this.generation;
    const hold: Hold = { id: randomUUID(), ...request, parkedAt: this.clock().toISOString() };
    return new Promise((resolve) => {
      const onDrop = () => {
        this.parked.delete(hold.id);
        resolve(false);
      };
      signal.addEventListener('abort', onDrop, { once: true });
      this.parked.set(hold.id, {
        hold,
        release: () => {
          signal.removeEventListener('abort', onDrop);
          this.parked.delete(hold.id);
          resolve(true);
        },
      });
      for (const wake of this.onPark) wake();
    });
  }

  /** Lets a parked request go on. False when no request is parked under `id`. */
  release(id: string): boolean {
    const parked = this.parked.get(id);
    parked?.release();
    return parked !== undefined;
  }

  /** The parked requests, oldest first; when there are none, waits up to `ms` for one to be parked. */
  async holds(ms: number): Promise<Hold[]> {
    if (this.parked.size === 0 && ms > 0) {
      const { signal } = this.generation;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.onPark.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        this.onPark.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return [...this.parked.values()].map((p) => p.hold);
  }

  /** Drops everything waiting, parked or not; what arrives afterwards waits afresh. */
  dropAll(): void {
    this.generation.abort();
    this.generation = new AbortController();
  }
}
