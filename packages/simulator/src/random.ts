/**
 * A seeded pseudo-random source (mulberry32): the same seed draws the same
 * sequence on every machine, so a batch can be planned again exactly.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** An integer in [min, max], both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('cannot pick from an empty list');
    return item;
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      // Both indexes are within the copy.
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }

  /** A 128-bit value written as a UUID (version 4 layout), drawn from the sequence. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16));
    hex[12] = '4';
    hex[16] = (8 + this.int(0, 3)).toString(16);
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}
