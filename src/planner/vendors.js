import { PRIORITY_CATEGORIES } from "./catalog.js";
import { addDays, toIsoDate } from "./dates.js";

const PRIORITY_ORDER = ["essential", "recommended", "optional"];

function upgrade(priority) {
  return PRIORITY_ORDER[Math.max(0, PRIORITY_ORDER.indexOf(priority) - 1)];
}

/**
 * Builds the vendor checklist. Priority starts from the vendor's base level
 * (or a context rule), is raised one step when it serves a user priority, and
 * optional vendors on lean budgets get a do-it-yourself nudge.
 * @param {object} profile  EVENT_PROFILES entry
 * @param {object} ctx      planning context
 * @param {{ eventDate: Date, leadDays: number, priorities: string[] }} options
 * @returns {import("./index.js").Vendor[]}
 */
export function buildVendorChecklist(profile, ctx, { eventDate, leadDays, priorities }) {
  const boosted = new Set(priorities.flatMap((priority) => PRIORITY_CATEGORIES[priority]));

  return profile.vendors
    .filter((vendor) => !vendor.when || vendor.when(ctx))
    .map((vendor) => {
      let priority = vendor.priority ? vendor.priority(ctx) : vendor.base;
      const matchesPriority = boosted.has(vendor.category);
      if (matchesPriority) priority = upgrade(priority);

      const idealDays = vendor.bookWeeksBefore * 7;
      const tip = typeof vendor.tip === "function" ? vendor.tip(ctx) : vendor.tip;
      return {
        id: vendor.id,
        name: vendor.name,
        priority,
        matchesPriority,
        bookBy: toIsoDate(addDays(eventDate, -Math.round(idealDays * ctx.leadRatio))),
        bookNow: idealDays > leadDays,
        tip: ctx.tier === "lean" && priority === "optional" ? `${tip} On a lean budget, consider a DIY or borrowed alternative.` : tip,
      };
    })
    .sort((a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || a.bookBy.localeCompare(b.bookBy),
    );
}
