/**
 * Small in-memory LRU cache with per-entry expiry. Map keeps insertion order,
 * so the first key is always the least recently used.
 */
export class TtlCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries] entries kept before evicting the least recently used
   * @param {number} [options.ttlMs]      lifetime of each entry
   * @param {() => number} [options.clock]
   */
  constructor({ maxEntries = 100, ttlMs = 60 * 60 * 1000, clock = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entries = new Map();
  }

  /** Returns the value, or undefined when missing or expired. Marks it recently used. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.clock()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores a value with a fresh TTL, evicting the oldest entry when full. */
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  get size() {
    return this.entries.size;
  }
}
