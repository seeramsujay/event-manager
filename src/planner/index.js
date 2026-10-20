import { EVENT_PROFILES, MILESTONE_AGES, USD_RATES } from "./catalog.js";
import { allocateBudget, budgetTier } from "./budget.js";
import { daysBetween, parseIsoDate, startOfUtcDay } from "./dates.js";
import { buildInsights } from "./insights.js";
import { buildTimeline } from "./timeline.js";
import { buildVendorChecklist } from "./vendors.js";

/** Derives the facts every planning rule depends on. */
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
 */
export function buildPlan(input, { now = new Date() } = {}) {
  const profile = EVENT_PROFILES[input.eventType];
  const today = startOfUtcDay(now);
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
