// Context-aware advice. Each rule inspects the user's situation and the
// generated plan, and returns at most one insight. Order = display order.

const WEEKEND_PREMIUM_TYPES = new Set(["wedding", "birthday"]);
const LARGE_EVENT = { wedding: 150, birthday: 60, community: 300 };
const LEVEL_ORDER = { critical: 0, warning: 1, info: 2 };

const rules = [
  ({ ctx, timeline }) => {
    if (ctx.leadRatio >= 1) return null;
    const days = timeline.leadDays;
    const available = days < 14 ? `${days} day${days === 1 ? "" : "s"}` : `about ${Math.floor(days / 7)} weeks`;
    const ideal = Math.round(timeline.idealLeadDays / 7);
    return {
      level: ctx.leadRatio < 0.35 ? "critical" : "warning",
      title: "Compressed timeline",
      detail: `You have ${available}; ${ideal} weeks is typical. Deadlines were scaled to fit — book the essential vendors first and accept simpler options for the rest.`,
    };
  },
  ({ ctx }) =>
    ctx.tier === "lean"
      ? {
          level: "warning",
          title: "Tight budget per guest",
          detail: "Consider a shorter guest list, a daytime or weekday date, or a potluck/buffet format. The plan already favors essentials.",
        }
      : null,
  ({ ctx }) => {
    if (ctx.setting === "outdoor") {
      return {
        level: "warning",
        title: "Weather backup needed",
        detail: "Plan for rain, heat and wind: shelter is in your checklist, the budget includes rentals and the contingency reserve is higher. Check the forecast a week out.",
      };
    }
    if (ctx.setting === "hybrid") {
      return {
        level: "info",
        title: "Weather backup needed",
        detail: "Make sure the indoor space can hold everyone if the weather turns. A small rentals line is included for covers and outdoor gear.",
      };
    }
    return null;
  },
  ({ ctx }) =>
    ctx.guestCount >= LARGE_EVENT[ctx.eventType]
      ? {
          level: "info",
          title: "Large guest count",
          detail: ctx.eventType === "community"
            ? "Crowds this size usually need permits, security and coordination with local authorities. These tasks are included."
            : "Consider a coordinator and a clear run-of-show so you can enjoy the event.",
        }
      : null,
  ({ ctx }) =>
    WEEKEND_PREMIUM_TYPES.has(ctx.eventType) && ctx.dayOfWeek === 6
      ? {
          level: "info",
          title: "Saturday premium",
          detail: "Saturdays are the most requested day. A Friday or Sunday often gets lower venue and vendor rates.",
        }
      : null,
  ({ ctx }) =>
    ctx.isKids
      ? {
          level: "info",
          title: "Kid-focused party",
          detail: "Keep it to around 2 hours, plan supervised activities, and collect allergy information with RSVPs.",
        }
      : null,
  ({ ctx }) =>
    ctx.isMilestone
      ? {
          level: "info",
          title: "Milestone birthday",
          detail: "A tribute moment — a photo slideshow or messages from friends — makes milestone birthdays memorable.",
        }
      : null,
  ({ ctx, budget }) => {
    const catering = budget.items.find((item) => item.key === "catering");
    if (!catering || catering.amount / ctx.guestCount >= ctx.minFoodPerGuest) return null;
    return {
      level: "warning",
      title: "Food budget is thin",
      detail: "Food is under-funded for this guest count. Food trucks, a potluck table or a dessert-and-drinks format can stretch it.",
    };
  },
  ({ ctx }) =>
    ctx.considerations.includes("accessibility")
      ? {
          level: "info",
          title: "Accessibility first",
          detail: "Ask about access needs on the RSVP, confirm step-free routes and accessible restrooms, and share a venue access guide in advance.",
        }
      : null,
  ({ ctx }) =>
    ctx.considerations.includes("sustainability")
      ? {
          level: "info",
          title: "Lower-waste event",
          detail: "Use digital invitations, reusable rentals and local seasonal food; donate leftover food where regulations allow.",
        }
      : null,
];

/** Minimum USD-equivalent food spend per guest before we warn. */
const MIN_FOOD_PER_GUEST_USD = { wedding: 25, birthday: 8, community: 2 };

/**
 * Applies every rule to the plan context and returns the triggered insights,
 * most severe first.
 * @param {object} ctx       planning context from buildContext()
 * @param {import("./index.js").Budget} budget
 * @param {import("./index.js").Timeline} timeline
 * @param {number} usdRate   value of one unit of the user's currency in USD
 * @returns {import("./index.js").Insight[]}
 */
export function buildInsights(ctx, budget, timeline, usdRate) {
  const ruleCtx = { ...ctx, minFoodPerGuest: MIN_FOOD_PER_GUEST_USD[ctx.eventType] / usdRate };
  return rules
    .map((rule) => rule({ ctx: ruleCtx, budget, timeline }))
    .filter(Boolean)
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
