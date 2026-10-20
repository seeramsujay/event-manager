import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/lib/rateLimiter.js";
import { TtlCache } from "../src/lib/ttlCache.js";

test("TtlCache expires entries and evicts the least recently used", () => {
  let now = 0;
  const cache = new TtlCache({ maxEntries: 2, ttlMs: 100, clock: () => now });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a"); // a is now most recently used
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  now = 150;
  assert.equal(cache.get("a"), undefined);
});

test("RateLimiter blocks after the limit and resets per window", () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
  assert.equal(limiter.check("ip").allowed, true);
  assert.equal(limiter.check("ip").allowed, true);
  const blocked = limiter.check("ip");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.check("other").allowed, true, "limits are per client");
  now = 1000;
  assert.equal(limiter.check("ip").allowed, true);
});
