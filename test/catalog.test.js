// Data-integrity checks: a typo in the catalog should fail here, not in production.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_LABELS, BUDGET_TIPS, CONSIDERATIONS, CURRENCIES, EVENT_PROFILES, EVENT_TYPES,
  MILESTONE_AGES, PRIORITIES, PRIORITY_CATEGORIES, SETTINGS, USD_RATES,
} from "../src/planner/catalog.js";

const BASE_PRIORITIES = new Set(["essential", "recommended", "optional"]);
const sampleContexts = [
  { setting: "indoor", guestCount: 10, considerations: [], isKids: false, kidFriendly: false, isMilestone: false },
  { setting: "outdoor", guestCount: 500, considerations: [...CONSIDERATIONS], isKids: true, kidFriendly: true, isMilestone: true },
  { setting: "hybrid", guestCount: 150, considerations: ["alcohol-free"], isKids: false, kidFriendly: true, isMilestone: false },
];

test("every event type has a profile and vice versa", () => {
  assert.deepEqual(Object.keys(EVENT_PROFILES).sort(), [...EVENT_TYPES].sort());
});

test("priority mapping covers exactly the allowed priorities with known categories", () => {
  assert.deepEqual(Object.keys(PRIORITY_CATEGORIES).sort(), [...PRIORITIES].sort());
  for (const categories of Object.values(PRIORITY_CATEGORIES)) {
    for (const key of categories) assert.ok(key in BUDGET_LABELS, key);
  }
});

test("currency rates are positive and listed", () => {
  assert.deepEqual(CURRENCIES, Object.keys(USD_RATES));
  for (const rate of Object.values(USD_RATES)) assert.ok(rate > 0);
  assert.equal(USD_RATES.USD, 1);
});

test("budget tips exist for every tier", () => {
  for (const tier of ["lean", "moderate", "premium"]) assert.ok(BUDGET_TIPS[tier].length >= 2, tier);
});

test("settings and considerations are non-empty and unique", () => {
  for (const list of [SETTINGS, CONSIDERATIONS, PRIORITIES, EVENT_TYPES]) {
    assert.ok(list.length > 0);
    assert.equal(new Set(list).size, list.length);
  }
});

test("milestone ages are plausible ages", () => {
  for (const age of MILESTONE_AGES) assert.ok(Number.isInteger(age) && age >= 0 && age <= 120);
});

for (const [type, profile] of Object.entries(EVENT_PROFILES)) {
  describe(`${type} profile`, () => {
    test("has a label, lead time and ordered tier thresholds", () => {
      assert.ok(profile.label);
      assert.ok(Number.isInteger(profile.idealLeadWeeks) && profile.idealLeadWeeks > 0);
      assert.ok(profile.tiers.lean > 0 && profile.tiers.premium > profile.tiers.lean);
    });

    test("allocation sums to 1, includes contingency and uses known categories", () => {
      const total = Object.values(profile.allocation).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `sums to ${total}`);
      assert.ok("contingency" in profile.allocation);
      for (const [key, share] of Object.entries(profile.allocation)) {
        assert.ok(key in BUDGET_LABELS, key);
        assert.ok(share > 0, key);
      }
    });

    test("tasks have unique ids, titles and weeks within the lead time", () => {
      const ids = profile.tasks.map((task) => task.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const task of profile.tasks) {
        assert.ok(task.title.length > 5, task.id);
        assert.ok(Number.isFinite(task.weeksBefore) && task.weeksBefore <= profile.idealLeadWeeks, task.id);
        assert.ok(task.when === undefined || typeof task.when === "function", task.id);
      }
    });

    test("has exactly one unconditional event-day task and a wrap-up task", () => {
      const eventDay = profile.tasks.filter((task) => task.weeksBefore === 0);
      assert.equal(eventDay.length, 1);
      assert.equal(eventDay[0].when, undefined);
      assert.ok(profile.tasks.some((task) => task.weeksBefore < 0));
    });

    test("the first task starts at the ideal lead time", () => {
      assert.equal(Math.max(...profile.tasks.map((task) => task.weeksBefore)), profile.idealLeadWeeks);
    });

    test("vendors have unique ids, valid categories, priorities and tips", () => {
      const ids = profile.vendors.map((vendor) => vendor.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const vendor of profile.vendors) {
        assert.ok(vendor.name, vendor.id);
        assert.ok(vendor.category in BUDGET_LABELS, `${vendor.id}: ${vendor.category}`);
        assert.ok(BASE_PRIORITIES.has(vendor.base), vendor.id);
        assert.ok(vendor.bookWeeksBefore > 0 && vendor.bookWeeksBefore <= profile.idealLeadWeeks, vendor.id);
        assert.ok(["string", "function"].includes(typeof vendor.tip), vendor.id);
      }
    });

    test("vendor rules return valid priorities and tips for any context", () => {
      for (const ctx of sampleContexts) {
        for (const vendor of profile.vendors) {
          if (vendor.priority) assert.ok(BASE_PRIORITIES.has(vendor.priority(ctx)), vendor.id);
          if (typeof vendor.tip === "function") assert.ok(vendor.tip(ctx).length > 0, vendor.id);
          if (vendor.when) assert.equal(typeof vendor.when(ctx), "boolean", vendor.id);
        }
        for (const task of profile.tasks) {
          if (task.when) assert.equal(typeof task.when(ctx), "boolean", task.id);
        }
      }
    });

    test("always has at least one essential vendor", () => {
      assert.ok(profile.vendors.some((vendor) => vendor.base === "essential" && !vendor.when));
    });

    test("curated ideas have at least 3 themes with keywords and filled lists", () => {
      assert.ok(profile.ideas.themes.length >= 3);
      for (const theme of profile.ideas.themes) {
        assert.ok(theme.name && theme.description);
        assert.ok(theme.keywords.length > 0 && theme.keywords.every((word) => word === word.toLowerCase()));
      }
      for (const key of ["decor", "food", "activities"]) assert.ok(profile.ideas[key].length >= 3, key);
    });
  });
}
