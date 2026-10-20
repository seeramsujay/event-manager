import { z } from "zod";
import { CONSIDERATIONS, CURRENCIES, EVENT_TYPES, PRIORITIES, SETTINGS } from "./planner/catalog.js";
import { addDays, parseIsoDate, startOfUtcDay } from "./planner/dates.js";

const MAX_DAYS_AHEAD = 5 * 365;

// Free text is later placed in an LLM prompt and echoed in the UI: strip
// control characters (keeping newlines) and trim.
const freeText = (max) =>
  z
    .string()
    .max(max * 2)
    .transform((value) => value.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim())
    .pipe(z.string().max(max))
    .default("");

const uniqueList = (values, max) =>
  z
    .array(z.enum(values))
    .max(max)
    .default([])
    .transform((list) => [...new Set(list)]);

export const planRequestSchema = z.strictObject({
  eventType: z.enum(EVENT_TYPES),
  eventName: freeText(80),
  date: z.string(),
  guestCount: z.number().int().min(1).max(5000),
  budget: z.number().min(50).max(100_000_000),
  currency: z.enum(CURRENCIES).default("USD"),
  setting: z.enum(SETTINGS).default("indoor"),
  vibe: freeText(200),
  honoreeAge: z.number().int().min(0).max(120).optional(),
  priorities: uniqueList(PRIORITIES, PRIORITIES.length),
  considerations: uniqueList(CONSIDERATIONS, CONSIDERATIONS.length),
  notes: freeText(500),
  useAI: z.boolean().default(true),
});

/**
 * Validates and normalizes a plan request.
 * @returns {{ success: true, data: object } | { success: false, errors: {field: string, message: string}[] }}
 */
export function validatePlanRequest(body, { now = new Date() } = {}) {
  const result = planRequestSchema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({ field: issue.path.join(".") || "body", message: issue.message })),
    };
  }

  const data = result.data;
  const eventDate = parseIsoDate(data.date);
  const today = startOfUtcDay(now);
  if (!eventDate) {
    return { success: false, errors: [{ field: "date", message: "Use a valid date in YYYY-MM-DD format." }] };
  }
  if (eventDate < today) {
    return { success: false, errors: [{ field: "date", message: "The event date cannot be in the past." }] };
  }
  if (eventDate > addDays(today, MAX_DAYS_AHEAD)) {
    return { success: false, errors: [{ field: "date", message: "Plans are supported up to 5 years ahead." }] };
  }
  if (data.eventType !== "birthday") delete data.honoreeAge;

  return { success: true, data };
}
