/** A request parked by a `hold` rule, as `GET /__mock/holds` lists it. */
export interface HoldInfo {
  id: string;
  ruleId: string;
  method: string;
  path: string;
  visitKey: string | null;
  businessIdentifier: string | null;
  parkedAt: string;
}

type Fate = 'release' | 'drop';

/** Parked requests plus the long-pollers waiting for one to arrive. */
export class Holds {
  private parked = new Map<string, { info: HoldInfo; settle: (f: Fate) => void }>();
  private waiters = new Set<() => void>();
  private counter = 0;

  /** Parks a request; resolves `release` when released, `drop` on reset or shutdown. */
  park(info: Omit<HoldInfo, 'id' | 'parkedAt'>): Promise<Fate> {
    this.counter += 1;
    const full: HoldInfo = { id: `h${this.counter}`, parkedAt: new Date().toISOString(), ...info };
    const fate = new Promise<Fate>((settle) => this.parked.set(full.id, { info: full, settle }));
    for (const w of this.waiters) w();
    return fate;
  }

  list(): HoldInfo[] {
    return [...this.parked.values()].map((p) => p.info);
  }

  /** Resolves with the parked requests once there is at least one, or `[]` after `waitMs`. */
  async wait(waitMs: number): Promise<HoldInfo[]> {
    if (this.parked.size > 0 || waitMs <= 0) return this.list();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
    });
    return this.list();
  }

  release(id: string): boolean {
    const p = this.parked.get(id);
    if (!p) return false;
    this.parked.delete(id);
    p.settle('release');
    return true;
  }

  dropAll(): void {
    for (const p of this.parked.values()) p.settle('drop');
    this.parked.clear();
    for (const w of this.waiters) w();
  }
}
