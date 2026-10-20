import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/planner/index.js";
import { NOW, request } from "./helpers.js";

const insight = (overrides, title) => buildPlan(request(overrides), { now: NOW }).insights.find((i) => i.title === title);

describe("insight rules", () => {
  const cases = [
    ["Compressed timeline", { date: "2026-06-01" }, "warning"],
    ["Compressed timeline", { date: "2026-02-01" }, "critical"],
    ["Compressed timeline", {}, null],
    ["Tight budget per guest", { budget: 5000 }, "warning"],
    ["Tight budget per guest", { budget: 15000 }, null],
    ["Weather backup needed", { setting: "outdoor" }, "warning"],
    ["Weather backup needed", { setting: "hybrid" }, "info"],
    ["Weather backup needed", {}, null],
    ["Large guest count", { guestCount: 150 }, "info"],
    ["Large guest count", { guestCount: 149 }, null],
    ["Large guest count", { eventType: "birthday", guestCount: 60 }, "info"],
    ["Large guest count", { eventType: "community", guestCount: 299 }, null],
    ["Saturday premium", { date: "2027-01-02" }, "info"],
    ["Saturday premium", { date: "2027-01-03" }, null],
    ["Saturday premium", { eventType: "community", date: "2027-01-02" }, null],
    ["Kid-focused party", { eventType: "birthday", honoreeAge: 12 }, "info"],
    ["Kid-focused party", { eventType: "birthday", honoreeAge: 13 }, null],
    ["Milestone birthday", { eventType: "birthday", honoreeAge: 18 }, "info"],
    ["Milestone birthday", { eventType: "birthday", honoreeAge: 19 }, null],
    ["Food budget is thin", { budget: 2000 }, "warning"],
    ["Food budget is thin", { budget: 30000 }, null],
    ["Accessibility first", { considerations: ["accessibility"] }, "info"],
    ["Lower-waste event", { considerations: ["sustainability"] }, "info"],
    ["Lower-waste event", {}, null],
  ];
  for (const [title, overrides, level] of cases) {
    test(`${title} → ${level ?? "absent"} for ${JSON.stringify(overrides)}`, () => {
      assert.equal(insight(overrides, title)?.level ?? null, level);
    });
  }
});

describe("insight wording", () => {
  test("compressed timeline counts days when under two weeks", () => {
    assert.match(insight({ date: "2026-01-02" }, "Compressed timeline").detail, /^You have 1 day; 52 weeks is typical/);
    assert.match(insight({ date: "2026-01-11" }, "Compressed timeline").detail, /^You have 10 days;/);
  });

  test("compressed timeline counts weeks beyond two weeks", () => {
    assert.match(insight({ date: "2026-03-01" }, "Compressed timeline").detail, /^You have about 8 weeks;/);
  });

  test("an event today says 0 days", () => {
    assert.match(insight({ date: "2026-01-01" }, "Compressed timeline").detail, /^You have 0 days;/);
  });

  test("community large-crowd advice mentions permits", () => {
    assert.match(insight({ eventType: "community", guestCount: 1000 }, "Large guest count").detail, /permits/);
  });

  test("food threshold is currency-aware", () => {
    // 2,000,000 INR for 100 guests is ~240 USD per guest: plenty for food.
    assert.equal(insight({ budget: 2_000_000, currency: "INR" }, "Food budget is thin"), undefined);
    // 200,000 INR for 100 guests is ~24 USD per guest: thin.
    assert.ok(insight({ budget: 200_000, currency: "INR" }, "Food budget is thin"));
  });
});
