// The rules engine: turns a validated request into a complete, deterministic plan.
import { EVENT_PROFILES, MILESTONE_AGES, USD_RATES } from "./catalog.js";
import { allocateBudget, budgetTier } from "./budget.js";
import { daysBetween, parseIsoDate, startOfUtcDay } from "./dates.js";
import { buildInsights } from "./insights.js";
import { buildTimeline } from "./timeline.js";
import { buildVendorChecklist } from "./vendors.js";

/**
 * @typedef {object} BudgetItem
 * @property {string} key          category id, e.g. "catering"
 * @property {string} label        display name
 * @property {number} percent      share of the total, one decimal
 * @property {number} amount       whole currency units
 * @property {boolean} prioritized boosted by a user priority
 *
 * @typedef {object} Budget
 * @property {number} total        whole currency units; equals the sum of item amounts
 * @property {string} currency
 * @property {number} perGuest     rounded to cents
 * @property {"lean" | "moderate" | "premium"} tier
 * @property {BudgetItem[]} items  largest first, contingency last
 *
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {"Plan & book" | "Design & invite" | "Final details" | "Event day" | "Wrap-up"} phase
 * @property {string} dueDate      YYYY-MM-DD
 * @property {boolean} urgent      due within 7 days
 *
 * @typedef {object} Timeline
 * @property {number} leadDays      days from today to the event
 * @property {number} idealLeadDays typical planning time for this event type
 * @property {boolean} compressed   deadlines were scaled to fit
 * @property {Task[]} tasks         sorted by due date
 *
 * @typedef {object} Vendor
 * @property {string} id
 * @property {string} name
 * @property {"essential" | "recommended" | "optional"} priority
 * @property {boolean} matchesPriority serves one of the user's priorities
 * @property {string} bookBy        YYYY-MM-DD
 * @property {boolean} bookNow      the usual booking window has already passed
 * @property {string} tip
 *
 * @typedef {object} Insight
 * @property {"critical" | "warning" | "info"} level
 * @property {string} title
 * @property {string} detail
 *
 * @typedef {object} Plan
 * @property {{ eventType: string, eventLabel: string, eventName: string, date: string, guestCount: number,
 *   setting: string, daysToGo: number, tier: string }} summary
 * @property {Budget} budget
 * @property {Timeline} timeline
 * @property {Vendor[]} vendors     essential first, then by booking date
 * @property {Insight[]} insights   most severe first
 */

/**
 * Derives the facts every planning rule depends on.
 * @param {import("../validation.js").PlanRequest} input
 * @param {object} profile  the EVENT_PROFILES entry for the event type
 * @param {Date} today      start of the planning day (UTC)
 */
export function buildContext(input, profile, today) {
  const eventDate = parseIsoDate(input.date);
  const leadDays = daysBetween(today, eventDate);
  const isBirthday = input.eventType === "birthday";
  const isKids = isBirthday && input.honoreeAge !== undefined && input.honoreeAge <= 12;

  return {
    eventDate,
    leadDays,
    ctx: {
      eventType: input.eventType,
      setting: input.setting,
      guestCount: input.guestCount,
      considerations: input.considerations,
      isKids,
      kidFriendly: isKids || input.considerations.includes("kid-friendly"),
      isMilestone: isBirthday && MILESTONE_AGES.has(input.honoreeAge),
      dayOfWeek: eventDate.getUTCDay(),
      leadRatio: Math.min(1, Math.max(0, leadDays) / (profile.idealLeadWeeks * 7)),
      tier: budgetTier(input, profile),
    },
  };
}

/**
 * Deterministic plan for a validated request. Pure: the same input and `now`
 * always produce the same plan, which makes it cacheable and testable.
 * @param {import("../validation.js").PlanRequest} input
 * @param {{ now?: Date }} [options]
 * @returns {Plan}
 */
export function buildPlan(input, { now = new Date() } = {}) {
  const profile = EVENT_PROFILES[input.eventType];
  // Validation allows an event "today" in the user's time zone that is
  // yesterday in UTC; treat that as today rather than planning into the past.
  const eventDay = parseIsoDate(input.date);
  const utcToday = startOfUtcDay(now);
  const today = eventDay < utcToday ? eventDay : utcToday;
  const { ctx, eventDate, leadDays } = buildContext(input, profile, today);

  const budget = allocateBudget(input, profile, ctx);
  const timeline = buildTimeline(profile, ctx, { eventDate, today, leadDays });
  const vendors = buildVendorChecklist(profile, ctx, { eventDate, leadDays, priorities: input.priorities });
  const insights = buildInsights(ctx, budget, timeline, USD_RATES[input.currency]);

  return {
    summary: {
      eventType: input.eventType,
      eventLabel: profile.label,
      eventName: input.eventName || `${profile.label} plan`,
      date: input.date,
      guestCount: input.guestCount,
      setting: input.setting,
      daysToGo: leadDays,
      tier: ctx.tier,
    },
    budget,
    timeline,
    vendors,
    insights,
  };
}
