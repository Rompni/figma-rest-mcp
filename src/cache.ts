export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/** Simple in-memory TTL cache. Default 60s. */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  async wrap<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) {
      return hit;
    }
    const value = await loader();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
