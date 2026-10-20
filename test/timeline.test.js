import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_PROFILES } from "../src/planner/catalog.js";
import { parseIsoDate } from "../src/planner/dates.js";
import { buildPlan } from "../src/planner/index.js";
import { buildTimeline } from "../src/planner/timeline.js";
import { NOW, request } from "./helpers.js";

const today = parseIsoDate("2026-01-01");
const ctx = (overrides = {}) => ({
  setting: "indoor", guestCount: 50, considerations: [], isKids: false, kidFriendly: false, isMilestone: false, leadRatio: 1, ...overrides,
});
const taskIds = (plan) => plan.timeline.tasks.map((task) => task.id);

describe("buildTimeline", () => {
  const profile = EVENT_PROFILES.birthday; // 8-week ideal lead
  const eventDate = parseIsoDate("2026-03-01");

  test("uses ideal offsets when there is enough time", () => {
    const timeline = buildTimeline(profile, ctx(), { eventDate, today, leadDays: 59 });
    const byId = Object.fromEntries(timeline.tasks.map((task) => [task.id, task]));
    assert.equal(byId["b-plan"].dueDate, "2026-01-04"); // 56 days before
    assert.equal(byId["b-invites"].dueDate, "2026-02-01"); // 28 days before
    assert.equal(byId["b-day"].dueDate, "2026-03-01");
    assert.equal(byId["b-thanks"].dueDate, "2026-03-08");
    assert.equal(timeline.compressed, false);
    assert.equal(timeline.idealLeadDays, 56);
  });

  test("halving the lead ratio halves the offsets", () => {
    const timeline = buildTimeline(profile, ctx({ leadRatio: 0.5 }), { eventDate, today, leadDays: 28 });
    const plan = timeline.tasks.find((task) => task.id === "b-plan");
    assert.equal(plan.dueDate, "2026-02-01"); // 28 days before
    assert.equal(timeline.compressed, true);
  });

  test("post-event tasks are never compressed", () => {
    const timeline = buildTimeline(profile, ctx({ leadRatio: 0.1 }), { eventDate, today, leadDays: 5 });
    assert.equal(timeline.tasks.find((task) => task.id === "b-thanks").dueDate, "2026-03-08");
  });

  test("an event today puts every preparation task on today and marks it urgent", () => {
    const timeline = buildTimeline(profile, ctx({ leadRatio: 0 }), { eventDate: today, today, leadDays: 0 });
    for (const task of timeline.tasks.filter((t) => t.phase !== "Wrap-up")) {
      assert.equal(task.dueDate, "2026-01-01");
      assert.equal(task.urgent, task.phase !== "Event day");
    }
  });

  test("tasks due more than a week out are not urgent", () => {
    const timeline = buildTimeline(profile, ctx(), { eventDate, today, leadDays: 59 });
    assert.ok(timeline.tasks.filter((task) => task.dueDate > "2026-01-08").every((task) => !task.urgent));
    assert.equal(timeline.tasks[0].urgent, true, "first task is due within 7 days");
  });

  test("phases follow the planning window", () => {
    const timeline = buildTimeline(EVENT_PROFILES.wedding, ctx(), { eventDate: parseIsoDate("2027-01-02"), today, leadDays: 366 });
    const phase = (id) => timeline.tasks.find((task) => task.id === id).phase;
    assert.equal(phase("w-venue"), "Plan & book");
    assert.equal(phase("w-invites"), "Design & invite");
    assert.equal(phase("w-confirm"), "Final details");
    assert.equal(phase("w-day"), "Event day");
    assert.equal(phase("w-thanks"), "Wrap-up");
  });

  test("output contains no internal sort fields", () => {
    const [task] = buildTimeline(profile, ctx(), { eventDate, today, leadDays: 59 }).tasks;
    assert.deepEqual(Object.keys(task).sort(), ["dueDate", "id", "phase", "title", "urgent"]);
  });
});

describe("conditional tasks", () => {
  const cases = [
    ["wedding weather task for outdoor", { setting: "outdoor" }, "w-weather", true],
    ["wedding weather task for hybrid", { setting: "hybrid" }, "w-weather", true],
    ["no wedding weather task indoors", {}, "w-weather", false],
    ["wedding coordinator at 150 guests", { guestCount: 150 }, "w-coordinator", true],
    ["no wedding coordinator at 149 guests", { guestCount: 149 }, "w-coordinator", false],
    ["wedding accessibility task", { considerations: ["accessibility"] }, "w-access", true],
    ["wedding sustainability task", { considerations: ["sustainability"] }, "w-green", true],
    ["no wedding sustainability task by default", {}, "w-green", false],
    ["kids birthday supervision", { eventType: "birthday", honoreeAge: 6, date: "2026-03-01" }, "b-kids", true],
    ["kid-friendly adult birthday supervision", { eventType: "birthday", honoreeAge: 35, considerations: ["kid-friendly"], date: "2026-03-01" }, "b-kids", true],
    ["no supervision for adult birthday", { eventType: "birthday", honoreeAge: 35, date: "2026-03-01" }, "b-kids", false],
    ["milestone tribute at 50", { eventType: "birthday", honoreeAge: 50, date: "2026-03-01" }, "b-tribute", true],
    ["no tribute at 49", { eventType: "birthday", honoreeAge: 49, date: "2026-03-01" }, "b-tribute", false],
    ["no tribute without an age", { eventType: "birthday", date: "2026-03-01" }, "b-tribute", false],
    ["birthday weather backup outdoors", { eventType: "birthday", setting: "outdoor", date: "2026-03-01" }, "b-weather", true],
    ["community authorities at 300", { eventType: "community", guestCount: 300 }, "c-authorities", true],
    ["no community authorities at 299", { eventType: "community", guestCount: 299 }, "c-authorities", false],
    ["community outdoor logistics", { eventType: "community", setting: "outdoor" }, "c-outdoor", true],
    ["community accessibility plan", { eventType: "community", considerations: ["accessibility"] }, "c-access", true],
    ["community waste stations", { eventType: "community", considerations: ["sustainability"] }, "c-waste", true],
    ["no community waste stations by default", { eventType: "community" }, "c-waste", false],
  ];
  for (const [name, overrides, id, expected] of cases) {
    test(name, () => {
      const plan = buildPlan(request(overrides), { now: NOW });
      assert.equal(taskIds(plan).includes(id), expected);
    });
  }
});
