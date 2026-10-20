import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, parseIsoDate, startOfUtcDay, toIsoDate } from "../src/planner/dates.js";

describe("parseIsoDate", () => {
  const valid = ["2026-01-01", "2026-12-31", "2028-02-29", "2000-02-29", "1999-06-15"];
  for (const value of valid) {
    test(`accepts ${value}`, () => {
      const date = parseIsoDate(value);
      assert.ok(date instanceof Date);
      assert.equal(toIsoDate(date), value);
    });
  }

  const invalid = [
    "2027-02-29", "2100-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00",
    "2026-1-01", "26-01-01", "2026/01/01", "01/02/2027", "2026-01-01T00:00:00Z", " 2026-01-01", "2026-01-01 ",
    "", "tomorrow", "2026-01-0a",
  ];
  for (const value of invalid) {
    test(`rejects ${JSON.stringify(value)}`, () => assert.equal(parseIsoDate(value), null));
  }

  for (const value of [null, undefined, 20260101, {}, [], true]) {
    test(`rejects non-string ${JSON.stringify(value)}`, () => assert.equal(parseIsoDate(value), null));
  }

  test("parses as midnight UTC regardless of host time zone", () => {
    assert.equal(parseIsoDate("2026-03-29").toISOString(), "2026-03-29T00:00:00.000Z");
  });
});

describe("date arithmetic", () => {
  test("addDays crosses month, year and leap-day boundaries", () => {
    assert.equal(toIsoDate(addDays(parseIsoDate("2026-01-31"), 1)), "2026-02-01");
    assert.equal(toIsoDate(addDays(parseIsoDate("2026-12-31"), 1)), "2027-01-01");
    assert.equal(toIsoDate(addDays(parseIsoDate("2028-02-28"), 1)), "2028-02-29");
    assert.equal(toIsoDate(addDays(parseIsoDate("2026-03-01"), -1)), "2026-02-28");
  });

  test("addDays with zero returns the same day", () => {
    assert.equal(toIsoDate(addDays(parseIsoDate("2026-05-05"), 0)), "2026-05-05");
  });

  test("daysBetween is signed and counts calendar days", () => {
    assert.equal(daysBetween(parseIsoDate("2026-01-01"), parseIsoDate("2027-01-01")), 365);
    assert.equal(daysBetween(parseIsoDate("2028-01-01"), parseIsoDate("2029-01-01")), 366);
    assert.equal(daysBetween(parseIsoDate("2026-01-10"), parseIsoDate("2026-01-01")), -9);
    assert.equal(daysBetween(parseIsoDate("2026-01-01"), parseIsoDate("2026-01-01")), 0);
  });

  test("startOfUtcDay drops the time of day", () => {
    assert.equal(startOfUtcDay(new Date("2026-07-04T23:59:59.999Z")).toISOString(), "2026-07-04T00:00:00.000Z");
    assert.equal(startOfUtcDay(new Date("2026-07-04T00:00:00.000Z")).toISOString(), "2026-07-04T00:00:00.000Z");
  });

  test("toIsoDate formats as YYYY-MM-DD", () => {
    assert.equal(toIsoDate(new Date("2026-02-03T15:00:00Z")), "2026-02-03");
  });
});
