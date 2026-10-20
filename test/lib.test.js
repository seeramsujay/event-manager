import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientBucket } from "../src/lib/rateLimiter.js";
import { TtlCache } from "../src/lib/ttlCache.js";

describe("TtlCache", () => {
  test("returns stored values", () => {
    const cache = new TtlCache();
    cache.set("a", { x: 1 });
    assert.deepEqual(cache.get("a"), { x: 1 });
    assert.equal(cache.get("missing"), undefined);
  });

  test("evicts the least recently used entry", () => {
    const cache = new TtlCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a is now most recently used
    cache.set("c", 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.size, 2);
  });

  test("expires entries after the TTL and removes them", () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 100, clock: () => now });
    cache.set("a", 1);
    now = 99;
    assert.equal(cache.get("a"), 1);
    now = 100;
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.size, 0);
  });

  test("overwriting a key refreshes its value and TTL without growing", () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 100, clock: () => now });
    cache.set("a", 1);
    now = 80;
    cache.set("a", 2);
    now = 150;
    assert.equal(cache.get("a"), 2);
    assert.equal(cache.size, 1);
  });

  test("a single-entry cache keeps only the newest", () => {
    const cache = new TtlCache({ maxEntries: 1 });
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
  });

  test("stores falsy values faithfully", () => {
    const cache = new TtlCache();
    for (const value of [0, "", false, null]) {
      cache.set("k", value);
      assert.equal(cache.get("k"), value);
    }
  });
});

describe("RateLimiter", () => {
  test("allows up to the limit then blocks with a retry hint", () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, clock: () => 0 });
    assert.equal(limiter.check("ip").allowed, true);
    assert.equal(limiter.check("ip").allowed, true);
    const blocked = limiter.check("ip");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 1);
  });

  test("limits are per client", () => {
    const limiter = new RateLimiter({ limit: 1 });
    assert.equal(limiter.check("a").allowed, true);
    assert.equal(limiter.check("b").allowed, true);
    assert.equal(limiter.check("a").allowed, false);
  });

  test("a new window starts after the old one expires", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, clock: () => now });
    limiter.check("ip");
    assert.equal(limiter.check("ip").allowed, false);
    now = 1000;
    assert.equal(limiter.check("ip").allowed, true);
  });

  test("retry hint counts down and is never zero", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 0, windowMs: 60_000, clock: () => now });
    assert.equal(limiter.check("ip").retryAfterSeconds, 60);
    now = 59_900;
    assert.equal(limiter.check("ip").retryAfterSeconds, 1);
  });

  test("expired windows are dropped so memory stays small", () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, clock: () => now });
    for (let i = 0; i < 500; i++) limiter.check(`ip-${i}`);
    assert.equal(limiter.size, 500);
    now = 1000;
    limiter.check("fresh");
    assert.equal(limiter.size, 1);
  });

  test("a flood of distinct clients cannot exceed maxKeys", () => {
    const limiter = new RateLimiter({ maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) limiter.check(`spoofed-${i}`);
    assert.equal(limiter.size, 100);
  });

  test("blocked clients stay blocked even with other traffic", () => {
    const limiter = new RateLimiter({ limit: 1, maxKeys: 1000 });
    limiter.check("attacker");
    for (let i = 0; i < 50; i++) limiter.check(`other-${i}`);
    assert.equal(limiter.check("attacker").allowed, false);
  });
});

describe("clientBucket", () => {
  const cases = [
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "::ffff:203.0.113.7"],
    ["unknown", "unknown"],
    ["2001:db8:1:2:3:4:5:6", "2001:0db8:0001:0002::/64"],
    ["2001:db8:1:2::9", "2001:0db8:0001:0002::/64"],
    ["2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:0db8:0001:0002::/64"],
    ["2001:db8::1", "2001:0db8:0000:0000::/64"],
    ["::1", "0000:0000:0000:0000::/64"],
    ["fe80::1%eth0", "fe80:0000:0000:0000::/64"],
  ];
  for (const [address, expected] of cases) {
    test(`${address} → ${expected}`, () => assert.equal(clientBucket(address), expected));
  }

  test("addresses in the same /64 share a bucket", () => {
    assert.equal(clientBucket("2001:db8:a:b:1::1"), clientBucket("2001:db8:a:b:ffff::2"));
    assert.notEqual(clientBucket("2001:db8:a:b::1"), clientBucket("2001:db8:a:c::1"));
  });
});
