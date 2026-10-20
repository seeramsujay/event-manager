import { addDays, daysBetween, toIsoDate } from "./dates.js";

const URGENT_WITHIN_DAYS = 7;

/** Picks a phase from how far through the ideal planning window a task sits. */
function phaseFor(weeksBefore, idealLeadWeeks) {
  if (weeksBefore < 0) return "Wrap-up";
  if (weeksBefore === 0) return "Event day";
  const fraction = weeksBefore / idealLeadWeeks;
  if (fraction >= 0.5) return "Plan & book";
  if (fraction >= 0.15) return "Design & invite";
  return "Final details";
}

/**
 * Schedules tasks backwards from the event date. When the user has less time
 * than the ideal lead time, every pre-event task is compressed proportionally
 * so the order is kept and nothing lands in the past.
 * @param {object} profile  EVENT_PROFILES entry
 * @param {object} ctx      planning context (uses leadRatio and the task conditions)
 * @param {{ eventDate: Date, today: Date, leadDays: number }} dates
 * @returns {import("./index.js").Timeline}
 */
export function buildTimeline(profile, ctx, { eventDate, today, leadDays }) {
  const tasks = profile.tasks
    .filter((task) => !task.when || task.when(ctx))
    .map((task) => {
      const offsetDays = task.weeksBefore > 0
        ? Math.round(task.weeksBefore * 7 * ctx.leadRatio)
        : Math.round(task.weeksBefore * 7);
      const due = addDays(eventDate, -offsetDays);
      const daysFromToday = daysBetween(today, due);
      return {
        id: task.id,
        title: task.title,
        phase: phaseFor(task.weeksBefore, profile.idealLeadWeeks),
        dueDate: toIsoDate(due),
        urgent: task.weeksBefore > 0 && daysFromToday <= URGENT_WITHIN_DAYS,
        sortKey: due.getTime(),
        weeksBefore: task.weeksBefore,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey || b.weeksBefore - a.weeksBefore)
    .map(({ sortKey, weeksBefore, ...task }) => task);

  return {
    leadDays,
    idealLeadDays: profile.idealLeadWeeks * 7,
    compressed: ctx.leadRatio < 1,
    tasks,
  };
}
