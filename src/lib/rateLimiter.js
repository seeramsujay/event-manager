/**
 * Expands an IPv6 address and keeps its /64 prefix: one subscriber usually
 * controls a whole /64, so rotating addresses inside it must not reset limits.
 * IPv4 and IPv4-mapped addresses are returned unchanged.
 * @param {string} address
 * @returns {string}
 */
export function clientBucket(address) {
  if (!address.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) return address;
  const [head, tail = ""] = address.toLowerCase().split("%")[0].split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = address.includes("::") && tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
}

/**
 * Fixed-window rate limiter keyed by client. Protects the paid AI endpoint
 * from abuse.
 *
 * Memory is bounded: windows live in a Map in creation order, and every
 * window has the same length, so expired windows are always at the front and
 * are dropped in amortized O(1). If `maxKeys` is still exceeded (a flood of
 * distinct clients), the oldest window is evicted.
 */
export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.limit]     Requests allowed per window.
   * @param {number} [options.windowMs]  Window length in milliseconds.
   * @param {number} [options.maxKeys]   Upper bound on tracked clients.
   * @param {() => number} [options.clock]
   */
  constructor({ limit = 20, windowMs = 60_000, maxKeys = 10_000, clock = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.clock = clock;
    this.windows = new Map();
  }

  /**
   * Records one request for `key`.
   * @param {string} key
   * @returns {{ allowed: boolean, retryAfterSeconds: number }}
   */
  check(key) {
    const now = this.clock();
    this.dropExpired(now);

    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value);
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Number of clients currently tracked. */
  get size() {
    return this.windows.size;
  }

  dropExpired(now) {
    for (const [key, window] of this.windows) {
      if (window.resetAt > now) break;
      this.windows.delete(key);
    }
  }
}
