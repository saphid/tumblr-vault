// Password guesses slow down instead of locking the owner out. Each client address and
// the vault as a whole get a few free failures, then a doubling wait capped at a minute.
// Behind a reverse proxy every client may share one address; the cap keeps that bounded.
const WINDOW = 15 * 60000;
const MAX_WAIT = 60000;
const MAX_KEYS = 10000;
const GLOBAL = "\u0000vault";
interface Attempts {
  failures: number;
  last: number;
}
export class Throttle {
  readonly records = new Map<string, Attempts>();
  constructor(
    readonly free = 5,
    readonly globalFree = 20,
  ) {}
  private wait(key: string, free: number, now: number) {
    const r = this.records.get(key);
    if (!r || r.failures < free) return 0;
    return Math.max(
      0,
      r.last + Math.min(MAX_WAIT, 1000 * 2 ** (r.failures - free)) - now,
    );
  }
  // Milliseconds this client must wait before another password check.
  check(key: string, now = Date.now()) {
    this.prune(now);
    return Math.max(
      this.wait(key, this.free, now),
      this.wait(GLOBAL, this.globalFree, now),
    );
  }
  fail(key: string, now = Date.now()) {
    for (const k of [key, GLOBAL]) {
      const r = this.records.get(k) || { failures: 0, last: now };
      r.failures++;
      r.last = now;
      this.records.delete(k);
      this.records.set(k, r);
    }
    while (this.records.size > MAX_KEYS)
      this.records.delete(this.records.keys().next().value!);
  }
  succeed(key: string) {
    this.records.delete(key);
  }
  prune(now = Date.now()) {
    for (const [k, r] of this.records)
      if (now - r.last > WINDOW) this.records.delete(k);
  }
}
