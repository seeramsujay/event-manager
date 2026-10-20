import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/planner/index.js";
import { NOW, request } from "./helpers.js";

const vendor = (overrides, id) => buildPlan(request(overrides), { now: NOW }).vendors.find((v) => v.id === id);
const vendorIds = (overrides) => buildPlan(request(overrides), { now: NOW }).vendors.map((v) => v.id);

describe("vendor priorities", () => {
  const cases = [
    ["venue is essential", {}, "venue", "essential"],
    ["essential stays essential when prioritized", { priorities: ["venue"] }, "venue", "essential"],
    ["photographer is recommended", {}, "photographer", "recommended"],
    ["photography priority upgrades photographer", { priorities: ["photography"] }, "photographer", "essential"],
    ["food priority upgrades cake baker", { priorities: ["food"] }, "cake", "recommended"],
    ["entertainment priority upgrades DJ", { priorities: ["entertainment"] }, "music", "essential"],
    ["decor priority upgrades florist", { priorities: ["decor"] }, "florist", "essential"],
    ["outdoor tent is essential", { setting: "outdoor" }, "rentals", "essential"],
    ["hybrid tent is recommended", { setting: "hybrid" }, "rentals", "recommended"],
    ["coordinator optional under 150 guests", { guestCount: 100 }, "coordinator", "optional"],
    ["coordinator recommended at 150 guests", { guestCount: 150 }, "coordinator", "recommended"],
    ["kids favors recommended", { eventType: "birthday", honoreeAge: 5 }, "favors", "recommended"],
    ["adult favors optional", { eventType: "birthday", honoreeAge: 30 }, "favors", "optional"],
    ["community rentals essential outdoors", { eventType: "community", setting: "outdoor" }, "rentals", "essential"],
    ["community rentals optional indoors", { eventType: "community" }, "rentals", "optional"],
    ["community safety essential at 200", { eventType: "community", guestCount: 200 }, "safety", "essential"],
    ["community safety recommended under 200", { eventType: "community", guestCount: 199 }, "safety", "recommended"],
    ["waste service recommended when low-waste", { eventType: "community", considerations: ["sustainability"] }, "waste", "recommended"],
  ];
  for (const [name, overrides, id, expected] of cases) {
    test(name, () => assert.equal(vendor(overrides, id).priority, expected));
  }

  test("matchesPriority flags only vendors in prioritized categories", () => {
    const vendors = buildPlan(request({ priorities: ["photography"] }), { now: NOW }).vendors;
    assert.deepEqual(vendors.filter((v) => v.matchesPriority).map((v) => v.id), ["photographer"]);
  });
});

describe("conditional vendors", () => {
  const cases = [
    ["no wedding tent indoors", {}, "rentals", false],
    ["wedding interpreter for accessibility", { considerations: ["accessibility"] }, "interpreter", true],
    ["no wedding interpreter by default", {}, "interpreter", false],
    ["birthday supervision for kids", { eventType: "birthday", honoreeAge: 9 }, "supervision", true],
    ["no supervision for adults", { eventType: "birthday", honoreeAge: 29 }, "supervision", false],
    ["bartender for 30+ adults", { eventType: "birthday", honoreeAge: 29, guestCount: 30 }, "bartender", true],
    ["no bartender under 30 guests", { eventType: "birthday", honoreeAge: 29, guestCount: 29 }, "bartender", false],
    ["no bartender when alcohol-free", { eventType: "birthday", honoreeAge: 29, guestCount: 60, considerations: ["alcohol-free"] }, "bartender", false],
    ["no bartender for kids", { eventType: "birthday", honoreeAge: 10, guestCount: 60 }, "bartender", false],
    ["community accessibility services", { eventType: "community", considerations: ["accessibility"] }, "access", true],
  ];
  for (const [name, overrides, id, expected] of cases) {
    test(name, () => assert.equal(vendorIds(overrides).includes(id), expected));
  }
});

describe("booking dates and tips", () => {
  test("book-by date is the ideal window when time allows", () => {
    assert.equal(vendor({}, "venue").bookBy, "2026-01-31"); // 48 weeks before 2027-01-02
    assert.equal(vendor({}, "venue").bookNow, false);
  });

  test("vendors past their usual window are flagged book-now", () => {
    const v = vendor({ date: "2026-04-01" }, "venue");
    assert.equal(v.bookNow, true);
    assert.ok(v.bookBy >= "2026-01-01");
  });

  test("entertainer tip adapts to kids versus adults", () => {
    assert.match(vendor({ eventType: "birthday", honoreeAge: 6 }, "entertainer").tip, /Magicians/);
    assert.match(vendor({ eventType: "birthday", honoreeAge: 40 }, "entertainer").tip, /DJ/);
  });

  test("lean budgets add a DIY nudge to optional vendors only", () => {
    const vendors = buildPlan(request({ budget: 2000 }), { now: NOW }).vendors;
    for (const v of vendors) assert.equal(v.tip.includes("DIY"), v.priority === "optional", v.id);
  });

  test("moderate budgets get no DIY nudge", () => {
    const vendors = buildPlan(request({ budget: 15000 }), { now: NOW }).vendors;
    assert.ok(vendors.every((v) => !v.tip.includes("DIY")));
  });
});
