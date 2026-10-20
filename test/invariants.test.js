// Property-style tests: thousands of random valid requests must all satisfy
// the plan's invariants. The seed is fixed so any failure is reproducible.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { curatedIdeas, buildIdeasPrompt } from "../src/ai/ideas.js";
import { EVENT_TYPES } from "../src/planner/catalog.js";
import { buildPlan } from "../src/planner/index.js";
import { validatePlanRequest } from "../src/validation.js";
import { NOW, TODAY, randomRequest, seededRandom } from "./helpers.js";

const CASES_PER_SEED = 250;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const PRIORITY_RANK = { essential: 0, recommended: 1, optional: 2 };
const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };
const PHASES = new Set(["Plan & book", "Design & invite", "Final details", "Event day", "Wrap-up"]);

function* cases(seed) {
  const random = seededRandom(seed);
  for (let i = 0; i < CASES_PER_SEED; i++) {
    const raw = randomRequest(random);
    const validation = validatePlanRequest(raw, { now: NOW });
    assert.equal(validation.success, true, `generated request should be valid: ${JSON.stringify(validation.errors)}`);
    yield { input: validation.data, plan: buildPlan(validation.data, { now: NOW }) };
  }
}

function isSorted(values, compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
  return values.every((value, index) => index === 0 || compare(values[index - 1], value) <= 0);
}

for (const seed of SEEDS) {
  describe(`random plans (seed ${seed}, ${CASES_PER_SEED} cases)`, () => {
    test("budget amounts are whole, non-negative and sum exactly to the total", () => {
      for (const { input, plan } of cases(seed)) {
        const { items, total } = plan.budget;
        assert.equal(total, Math.round(input.budget));
        assert.equal(items.reduce((sum, item) => sum + item.amount, 0), total);
        for (const item of items) {
          assert.ok(Number.isInteger(item.amount) && item.amount >= 0, `${item.key}: ${item.amount}`);
          assert.ok(item.label, `${item.key} has a label`);
        }
      }
    });

    test("budget percentages total ~100 and contingency is last and 5–10%", () => {
      for (const { plan } of cases(seed)) {
        const percentTotal = plan.budget.items.reduce((sum, item) => sum + item.percent, 0);
        assert.ok(Math.abs(percentTotal - 100) <= 0.6, `percent total ${percentTotal}`);
        const last = plan.budget.items.at(-1);
        assert.equal(last.key, "contingency");
        assert.ok(last.percent >= 5 && last.percent <= 10, `contingency ${last.percent}`);
        assert.equal(new Set(plan.budget.items.map((item) => item.key)).size, plan.budget.items.length);
      }
    });

    test("prioritized flags match the user's priorities", () => {
      for (const { input, plan } of cases(seed)) {
        if (input.priorities.length === 0) {
          assert.ok(plan.budget.items.every((item) => !item.prioritized));
        }
        assert.ok(!plan.budget.items.find((item) => item.key === "contingency").prioritized);
      }
    });

    test("timeline tasks are dated, ordered and never in the past", () => {
      for (const { input, plan } of cases(seed)) {
        const { tasks } = plan.timeline;
        assert.ok(isSorted(tasks.map((task) => task.dueDate)), "sorted by date");
        assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length, "unique ids");
        for (const task of tasks) {
          assert.ok(PHASES.has(task.phase), task.phase);
          if (task.phase !== "Wrap-up") {
            assert.ok(task.dueDate >= TODAY && task.dueDate <= input.date, `${task.id} ${task.dueDate}`);
          } else {
            assert.ok(task.dueDate > input.date, `${task.id} after the event`);
          }
        }
        const eventDay = tasks.filter((task) => task.phase === "Event day");
        assert.equal(eventDay.length, 1);
        assert.equal(eventDay[0].dueDate, input.date);
        assert.equal(eventDay[0].urgent, false);
      }
    });

    test("timeline compression matches lead time", () => {
      for (const { plan } of cases(seed)) {
        const { leadDays, idealLeadDays, compressed } = plan.timeline;
        assert.equal(compressed, leadDays < idealLeadDays);
        assert.equal(plan.summary.daysToGo, leadDays);
      }
    });

    test("vendors are unique, valid and sorted by priority then booking date", () => {
      for (const { input, plan } of cases(seed)) {
        const { vendors } = plan;
        assert.ok(vendors.length >= 3);
        assert.equal(new Set(vendors.map((vendor) => vendor.id)).size, vendors.length);
        for (const vendor of vendors) {
          assert.ok(vendor.priority in PRIORITY_RANK, vendor.priority);
          assert.ok(vendor.bookBy >= TODAY && vendor.bookBy <= input.date, `${vendor.id} ${vendor.bookBy}`);
          assert.equal(typeof vendor.tip, "string");
          assert.ok(vendor.tip.length > 0);
          assert.equal(typeof vendor.bookNow, "boolean");
        }
        for (let i = 1; i < vendors.length; i++) {
          const [a, b] = [vendors[i - 1], vendors[i]];
          const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
          assert.ok(rankDiff < 0 || (rankDiff === 0 && a.bookBy <= b.bookBy), `${a.id} before ${b.id}`);
        }
      }
    });

    test("insights are valid, unique and ordered by severity", () => {
      for (const { plan } of cases(seed)) {
        const ranks = plan.insights.map((insight) => LEVEL_RANK[insight.level]);
        assert.ok(ranks.every((rank) => rank !== undefined));
        assert.ok(isSorted(ranks));
        assert.equal(new Set(plan.insights.map((insight) => insight.title)).size, plan.insights.length);
        for (const insight of plan.insights) assert.ok(insight.detail.length > 10);
      }
    });

    test("plans are deterministic and JSON-safe", () => {
      for (const { input, plan } of cases(seed)) {
        assert.deepEqual(buildPlan(input, { now: NOW }), plan);
        assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
      }
    });

    test("curated ideas are always complete", () => {
      for (const { input, plan } of cases(seed)) {
        const ideas = curatedIdeas(input, plan);
        assert.equal(ideas.themes.length, 3);
        for (const key of ["decor", "food", "activities", "budgetTips"]) assert.ok(ideas[key].length >= 2, key);
        assert.ok(ideas.personalTouch);
      }
    });

    test("prompts never let user text open or close a fence", () => {
      for (const { input, plan } of cases(seed)) {
        const prompt = buildIdeasPrompt(input, plan);
        assert.equal((prompt.match(/<\/?notes>/g) ?? []).length, 2);
        assert.equal((prompt.match(/<\/?vibe>/g) ?? []).length, 2);
        assert.ok(!prompt.includes("<b>"));
      }
    });
  });
}

test("every event type appears in the generated cases", () => {
  const seen = new Set();
  for (const { input } of cases(SEEDS[0])) seen.add(input.eventType);
  assert.deepEqual([...seen].sort(), [...EVENT_TYPES].sort());
});
