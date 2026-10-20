/**
 * Fixed-window rate limiter keyed by client address. Protects the paid AI
 * endpoint from abuse. Stale windows are pruned lazily to bound memory.
 */
export class RateLimiter {
  constructor({ limit = 20, windowMs = 60_000, clock = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.windows = new Map();
  }

  /** @returns {{ allowed: boolean, retryAfterSeconds: number }} */
  check(key) {
    const now = this.clock();
    if (this.windows.size > 10_000) this.prune(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= this.limit,
      retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000),
    };
  }

  prune(now) {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
