import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/planner/index.js";
import { NOW, request } from "./helpers.js";

const ids = (list) => list.map((item) => item.id);

test("builds a complete plan for every event type", () => {
  for (const eventType of ["wedding", "birthday", "community"]) {
    const plan = buildPlan(request({ eventType, honoreeAge: eventType === "birthday" ? 30 : undefined }), { now: NOW });
    assert.equal(plan.summary.eventType, eventType);
    assert.ok(plan.budget.items.length > 5);
    assert.ok(plan.timeline.tasks.length > 5);
    assert.ok(plan.vendors.length > 3);
  }
});

test("timeline with ample lead time uses ideal offsets in date order", () => {
  const plan = buildPlan(request(), { now: NOW });
  assert.equal(plan.timeline.compressed, false);
  const venue = plan.timeline.tasks.find((task) => task.id === "w-venue");
  assert.equal(venue.dueDate, "2026-01-31"); // 48 weeks (336 days) before 2027-01-02
  const dates = plan.timeline.tasks.map((task) => task.dueDate);
  assert.deepEqual(dates, [...dates].sort());
  assert.equal(plan.timeline.tasks.at(-1).phase, "Wrap-up");
});

test("short lead time compresses deadlines without putting any in the past", () => {
  const plan = buildPlan(request({ date: "2026-03-01" }), { now: NOW });
  assert.equal(plan.timeline.compressed, true);
  for (const task of plan.timeline.tasks) assert.ok(task.dueDate >= "2026-01-01", `${task.id} ${task.dueDate}`);
  assert.equal(plan.timeline.tasks[0].id, "w-budget", "order is preserved");
  assert.equal(plan.timeline.tasks[0].urgent, true);
  assert.equal(plan.insights[0].level, "critical");
  assert.ok(plan.vendors.some((vendor) => vendor.bookNow));
});

test("conditional tasks and vendors follow the context", () => {
  const indoor = buildPlan(request(), { now: NOW });
  assert.ok(!ids(indoor.timeline.tasks).includes("w-weather"));
  assert.ok(!ids(indoor.vendors).includes("rentals"));

  const outdoor = buildPlan(request({ setting: "outdoor", guestCount: 200, considerations: ["accessibility"] }), { now: NOW });
  assert.ok(ids(outdoor.timeline.tasks).includes("w-weather"));
  assert.ok(ids(outdoor.timeline.tasks).includes("w-coordinator"));
  assert.ok(ids(outdoor.timeline.tasks).includes("w-access"));
  assert.equal(outdoor.vendors.find((v) => v.id === "rentals").priority, "essential");
  assert.ok(ids(outdoor.vendors).includes("interpreter"));
});

test("kids birthdays get supervision and no bartender", () => {
  const plan = buildPlan(request({ eventType: "birthday", honoreeAge: 7, guestCount: 40, budget: 1500, date: "2026-03-15" }), { now: NOW });
  assert.ok(ids(plan.vendors).includes("supervision"));
  assert.ok(!ids(plan.vendors).includes("bartender"));
  assert.ok(ids(plan.timeline.tasks).includes("b-kids"));
  assert.ok(plan.insights.some((insight) => insight.title === "Kid-focused party"));
});

test("adult birthdays may get a bartender unless alcohol-free", () => {
  const adult = request({ eventType: "birthday", honoreeAge: 40, guestCount: 50, budget: 4000 });
  assert.ok(ids(buildPlan(adult, { now: NOW }).vendors).includes("bartender"));
  const dry = { ...adult, considerations: ["alcohol-free"] };
  assert.ok(!ids(buildPlan(dry, { now: NOW }).vendors).includes("bartender"));
  assert.ok(buildPlan(adult, { now: NOW }).insights.some((insight) => insight.title === "Milestone birthday"));
});

test("large community events require security and authority coordination", () => {
  const plan = buildPlan(request({ eventType: "community", guestCount: 500, budget: 20000 }), { now: NOW });
  assert.ok(ids(plan.timeline.tasks).includes("c-authorities"));
  assert.equal(plan.vendors.find((v) => v.id === "safety").priority, "essential");
  assert.ok(plan.insights.some((insight) => insight.title === "Large guest count"));
});

test("user priorities upgrade matching vendors", () => {
  const base = buildPlan(request(), { now: NOW }).vendors.find((v) => v.id === "photographer");
  const boosted = buildPlan(request({ priorities: ["photography"] }), { now: NOW }).vendors.find((v) => v.id === "photographer");
  assert.equal(base.priority, "recommended");
  assert.equal(boosted.priority, "essential");
  assert.equal(boosted.matchesPriority, true);
});

test("lean budgets trigger warnings and DIY nudges", () => {
  const plan = buildPlan(request({ budget: 3000 }), { now: NOW });
  assert.equal(plan.budget.tier, "lean");
  assert.ok(plan.insights.some((insight) => insight.title === "Tight budget per guest"));
  assert.ok(plan.insights.some((insight) => insight.title === "Food budget is thin"));
  assert.ok(plan.vendors.filter((v) => v.priority === "optional").every((v) => v.tip.includes("DIY")));
});

test("events days away get a day-count timeline warning", () => {
  const plan = buildPlan(request({ eventType: "birthday", date: "2026-01-04", budget: 2000, guestCount: 20 }), { now: NOW });
  const insight = plan.insights.find((item) => item.title === "Compressed timeline");
  assert.match(insight.detail, /^You have 3 days; 8 weeks is typical/);
});

test("Saturday weddings get an off-peak tip", () => {
  const plan = buildPlan(request({ date: "2027-01-02" }), { now: NOW }); // a Saturday
  assert.ok(plan.insights.some((insight) => insight.title === "Saturday premium"));
});

test("insights are ordered by severity", () => {
  const order = { critical: 0, warning: 1, info: 2 };
  const plan = buildPlan(request({ date: "2026-02-01", budget: 2000, setting: "outdoor" }), { now: NOW });
  const levels = plan.insights.map((insight) => order[insight.level]);
  assert.deepEqual(levels, [...levels].sort());
});

test("an event that is today in the user's time zone but yesterday in UTC plans as today", () => {
  const plan = buildPlan(request({ date: "2025-12-31" }), { now: NOW });
  assert.equal(plan.summary.daysToGo, 0);
  const preparation = plan.timeline.tasks.filter((task) => task.phase !== "Wrap-up");
  assert.ok(preparation.every((task) => task.dueDate === "2025-12-31"));
  assert.ok(plan.vendors.every((vendor) => vendor.bookBy === "2025-12-31"));
});

test("defaults to the current clock", () => {
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-01`;
  assert.ok(buildPlan(request({ date: nextYear })).summary.daysToGo > 0);
});
