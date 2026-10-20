import { z } from "zod";
import { CONSIDERATIONS, CURRENCIES, EVENT_TYPES, PRIORITIES, SETTINGS } from "./planner/catalog.js";
import { addDays, parseIsoDate, startOfUtcDay } from "./planner/dates.js";

const MAX_YEARS_AHEAD = 5;
// The server's "today" is the UTC date. Browsers west of UTC can still be on
// the previous calendar day, so one day of grace avoids rejecting their today.
const TIME_ZONE_GRACE_DAYS = 1;

// Free text is later placed in an LLM prompt and echoed in the UI: strip
// control characters (keeping newlines) and trim.
const freeText = (max) =>
  z
    .string()
    .max(max * 2)
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .transform((value) => value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim())
    .pipe(z.string().max(max))
    .default("");

const uniqueList = (values, max) =>
  z
    .array(z.enum(values))
    .max(max)
    .default([])
    .transform((list) => [...new Set(list)]);

/**
 * A validated, normalized plan request.
 * @typedef {object} PlanRequest
 * @property {"wedding" | "birthday" | "community"} eventType
 * @property {string} eventName      shown on the plan only; never sent to the AI
 * @property {string} date           YYYY-MM-DD
 * @property {number} guestCount     1–5000
 * @property {number} budget         50–100,000,000 in `currency`
 * @property {string} currency       one of CURRENCIES
 * @property {"indoor" | "outdoor" | "hybrid"} setting
 * @property {string} vibe           free text, ≤ 200 chars
 * @property {number} [honoreeAge]   birthdays only
 * @property {string[]} priorities   subset of PRIORITIES, deduplicated
 * @property {string[]} considerations subset of CONSIDERATIONS, deduplicated
 * @property {string} notes          free text, ≤ 500 chars
 * @property {boolean} useAI
 */

/** Request schema: strict (unknown keys rejected), typed, bounded. */
export const planRequestSchema = z.strictObject({
  eventType: z.enum(EVENT_TYPES, "Choose wedding, birthday or community event."),
  eventName: freeText(80),
  date: z.string("Choose the event date."),
  guestCount: z
    .number("Enter the number of guests.")
    .int("Use a whole number of guests.")
    .min(1, "Plan for at least 1 guest.")
    .max(5000, "Plans support up to 5000 guests."),
  budget: z
    .number("Enter your total budget.")
    .min(50, "Enter a budget of at least 50.")
    .max(100_000_000, "Enter a budget of at most 100,000,000."),
  currency: z.enum(CURRENCIES, `Choose one of: ${CURRENCIES.join(", ")}.`).default("USD"),
  setting: z.enum(SETTINGS, "Choose indoor, outdoor or hybrid.").default("indoor"),
  vibe: freeText(200),
  honoreeAge: z.number("Enter the age as a number.").int("Use a whole number.").min(0, "Age can't be negative.").max(120, "Enter an age up to 120.").optional(),
  priorities: uniqueList(PRIORITIES, PRIORITIES.length),
  considerations: uniqueList(CONSIDERATIONS, CONSIDERATIONS.length),
  notes: freeText(500),
  useAI: z.boolean().default(true),
});

/**
 * Validates and normalizes a plan request, including calendar rules the
 * schema can't express (real dates, not in the past, at most 5 years ahead).
 * @param {unknown} body  parsed JSON from the client
 * @param {{ now?: Date }} [options]
 * @returns {{ success: true, data: PlanRequest } | { success: false, errors: { field: string, message: string }[] }}
 */
export function validatePlanRequest(body, { now = new Date() } = {}) {
  const result = planRequestSchema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      // Report the top-level field so the UI can attach the message to its input.
      errors: result.error.issues.map((issue) => ({ field: String(issue.path[0] ?? "body"), message: issue.message })),
    };
  }

  const data = result.data;
  const eventDate = parseIsoDate(data.date);
  const today = startOfUtcDay(now);
  if (!eventDate) {
    return { success: false, errors: [{ field: "date", message: "Use a valid date in YYYY-MM-DD format." }] };
  }
  if (eventDate < addDays(today, -TIME_ZONE_GRACE_DAYS)) {
    return { success: false, errors: [{ field: "date", message: "The event date cannot be in the past." }] };
  }
  const latest = new Date(Date.UTC(today.getUTCFullYear() + MAX_YEARS_AHEAD, today.getUTCMonth(), today.getUTCDate()));
  if (eventDate > latest) {
    return { success: false, errors: [{ field: "date", message: "Plans are supported up to 5 years ahead." }] };
  }
  if (data.eventType !== "birthday") delete data.honoreeAge;

  return { success: true, data };
}
