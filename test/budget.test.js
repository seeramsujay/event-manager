import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateBudget, budgetTier, contingencyShare, splitWhole } from "../src/planner/budget.js";
import { EVENT_PROFILES } from "../src/planner/catalog.js";
import { request } from "./helpers.js";

const wedding = EVENT_PROFILES.wedding;
const sum = (items) => items.reduce((total, item) => total + item.amount, 0);
const share = (budget, key) => budget.items.find((item) => item.key === key)?.percent;

test("every profile's default allocation sums to 100%", () => {
  for (const [type, profile] of Object.entries(EVENT_PROFILES)) {
    const total = Object.values(profile.allocation).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${type} sums to ${total}`);
  }
});

test("splitWhole always returns exactly the total", () => {
  assert.deepEqual(splitWhole(10, [1 / 3, 1 / 3, 1 / 3]), [4, 3, 3]);
  assert.equal(splitWhole(99_999, [0.123, 0.456, 0.421]).reduce((a, b) => a + b), 99_999);
});

test("allocated amounts add up to the budget", () => {
  for (const input of [request(), request({ budget: 1234.56, setting: "outdoor", priorities: ["food", "decor"] })]) {
    const budget = allocateBudget(input, wedding, { leadRatio: 1, tier: "moderate" });
    assert.equal(sum(budget.items), Math.round(input.budget));
  }
});

test("prioritized categories get a larger share and are flagged", () => {
  const base = allocateBudget(request(), wedding, { leadRatio: 1, tier: "moderate" });
  const boosted = allocateBudget(request({ priorities: ["photography"] }), wedding, { leadRatio: 1, tier: "moderate" });
  assert.ok(share(boosted, "photography") > share(base, "photography"));
  assert.equal(boosted.items.find((item) => item.key === "photography").prioritized, true);
});

test("outdoor events add a rentals line and a larger contingency", () => {
  const budget = allocateBudget(request({ setting: "outdoor" }), wedding, { leadRatio: 1, tier: "moderate" });
  assert.ok(share(budget, "rentals") > 0);
  assert.equal(share(budget, "contingency"), 8);
  assert.equal(budget.items.at(-1).key, "contingency", "contingency is listed last");
});

test("contingency grows when the timeline is rushed", () => {
  assert.equal(contingencyShare({ setting: "indoor", leadRatio: 1 }), 0.05);
  assert.ok(Math.abs(contingencyShare({ setting: "outdoor", leadRatio: 0.2 }) - 0.1) < 1e-9);
});

test("budget tier uses per-guest spend normalized to USD", () => {
  assert.equal(budgetTier({ budget: 5000, guestCount: 100, currency: "USD" }, wedding), "lean");
  assert.equal(budgetTier({ budget: 15000, guestCount: 100, currency: "USD" }, wedding), "moderate");
  assert.equal(budgetTier({ budget: 30000, guestCount: 100, currency: "USD" }, wedding), "premium");
  // 1,000,000 INR for 100 guests is ~120 USD per guest: moderate, not premium.
  assert.equal(budgetTier({ budget: 1_000_000, guestCount: 100, currency: "INR" }, wedding), "moderate");
});

test("hybrid events get a smaller rentals line and no extra contingency", () => {
  const hybrid = allocateBudget(request({ setting: "hybrid" }), wedding, { leadRatio: 1, tier: "moderate" });
  const outdoor = allocateBudget(request({ setting: "outdoor" }), wedding, { leadRatio: 1, tier: "moderate" });
  assert.ok(share(hybrid, "rentals") > 0);
  assert.ok(share(hybrid, "rentals") < share(outdoor, "rentals"));
  assert.equal(share(hybrid, "contingency"), 5);
});

test("indoor events have no rentals line unless the profile has one", () => {
  const indoor = allocateBudget(request(), wedding, { leadRatio: 1, tier: "moderate" });
  assert.equal(share(indoor, "rentals"), undefined);
  const community = allocateBudget(request({ eventType: "community" }), EVENT_PROFILES.community, { leadRatio: 1, tier: "moderate" });
  assert.ok(share(community, "rentals") > 0);
});

test("priorities with no matching category leave the split unchanged", () => {
  const community = EVENT_PROFILES.community;
  const base = allocateBudget(request({ eventType: "community" }), community, { leadRatio: 1, tier: "moderate" });
  const photo = allocateBudget(request({ eventType: "community", priorities: ["photography"] }), community, { leadRatio: 1, tier: "moderate" });
  assert.deepEqual(photo.items, base.items);
});

test("per-guest spend is rounded to cents", () => {
  const budget = allocateBudget(request({ budget: 1000, guestCount: 3 }), wedding, { leadRatio: 1, tier: "lean" });
  assert.equal(budget.perGuest, 333.33);
});

test("fractional budgets are rounded to whole units", () => {
  const budget = allocateBudget(request({ budget: 999.5 }), wedding, { leadRatio: 1, tier: "lean" });
  assert.equal(budget.total, 1000);
});

for (const total of [50, 51, 97, 1001, 123_457, 100_000_000]) {
  test(`splitWhole is exact for ${total} across awkward shares`, () => {
    const shares = [0.17, 0.29, 0.13, 0.11, 0.3];
    const parts = splitWhole(total, shares);
    assert.equal(parts.reduce((a, b) => a + b), total);
    parts.forEach((part, i) => assert.ok(Math.abs(part - shares[i] * total) < 1, `part ${i}`));
  });
}
