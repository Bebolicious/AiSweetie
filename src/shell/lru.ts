/**
 * A fixed-capacity cache that evicts whatever was used longest ago.
 *
 * `Map` iterates in insertion order, so moving an entry to the end whenever it
 * is read is all the bookkeeping recency needs — no linked list, no
 * timestamps, no sweep.
 *
 * Capacity is a count rather than a byte budget, which is only honest because
 * callers bound the size of what they store. The explorer's preview cache, for
 * instance, never holds a file over `HIGHLIGHT_LIMIT`, so its worst case is a
 * known multiple of that rather than "however large the values happen to be".
 */
export interface Lru<T> {
  get(key: string): T | undefined;
  /** Insert, evicting as needed. Returns the value, for use in an expression. */
  set(key: string, value: T): T;
  readonly size: number;
  clear(): void;
}

export function createLru<T>(capacity: number): Lru<T> {
  // A capacity below 1 would make `set` evict what it just stored, which is a
  // caller bug that should not become a silently empty cache.
  const limit = Math.max(1, Math.floor(capacity));
  const entries = new Map<string, T>();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as T;
      // Re-insert to make this the most recently used.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set(key, value) {
      // Delete first so an overwrite also counts as a use, rather than
      // leaving the entry in its old position in the eviction order.
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
      return value;
    },

    get size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
