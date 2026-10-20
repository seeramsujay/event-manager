// Date helpers. All planning dates are calendar days handled in UTC so that
// results do not shift with the server's time zone.

export const DAY_MS = 86_400_000;

/** Parses YYYY-MM-DD into a UTC Date, or returns null for impossible dates like 2026-02-30. */
export function parseIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && toIsoDate(date) === value ? date : null;
}

export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}
