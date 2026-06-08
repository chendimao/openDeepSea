interface TtlCacheOptions {
  now?: () => number;
}

export interface TtlCacheEntry<T> {
  value: T;
  stale: boolean;
  expiresAt: number;
  updatedAt: number;
}

export class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number; updatedAt: number }>();
  private readonly now: () => number;

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get(key: K): TtlCacheEntry<V> | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    const current = this.now();
    return {
      value: entry.value,
      stale: current > entry.expiresAt,
      expiresAt: entry.expiresAt,
      updatedAt: entry.updatedAt,
    };
  }

  set(key: K, value: V, ttlMs: number): void {
    const current = this.now();
    this.values.set(key, {
      value,
      updatedAt: current,
      expiresAt: current + Math.max(0, ttlMs),
    });
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}
