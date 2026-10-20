import { BUDGET_LABELS, PRIORITY_CATEGORIES, USD_RATES } from "./catalog.js";

const PRIORITY_BOOST = 1.25;
/** Extra budget weight for tents and weather gear, by setting. */
const RENTAL_SHARE = { indoor: 0, hybrid: 0.03, outdoor: 0.06 };
const BASE_CONTINGENCY = 0.05;

/**
 * Classifies spend per guest (normalized to USD) as lean, moderate or premium.
 * @param {{ budget: number, guestCount: number, currency: string }} input
 * @param {{ tiers: { lean: number, premium: number } }} profile
 * @returns {"lean" | "moderate" | "premium"}
 */
export function budgetTier({ budget, guestCount, currency }, profile) {
  const perGuestUsd = (budget * USD_RATES[currency]) / guestCount;
  if (perGuestUsd < profile.tiers.lean) return "lean";
  if (perGuestUsd >= profile.tiers.premium) return "premium";
  return "moderate";
}

/**
 * Riskier plans keep a larger reserve for surprises: +3% outdoors (weather),
 * +2% when there is less than half the ideal planning time.
 * @param {{ setting: string, leadRatio: number }} context
 * @returns {number} share of the total budget, 0.05–0.10
 */
export function contingencyShare({ setting, leadRatio }) {
  let share = BASE_CONTINGENCY;
  if (setting === "outdoor") share += 0.03;
  if (leadRatio < 0.5) share += 0.02;
  return share;
}

/**
 * Splits whole currency units by share using the largest-remainder method,
 * so the parts always add up exactly to the total.
 * @param {number} total   whole units to split
 * @param {number[]} shares fractions summing to 1
 * @returns {number[]} whole amounts, same order as `shares`
 */
export function splitWhole(total, shares) {
  const raw = shares.map((share) => share * total);
  const amounts = raw.map(Math.floor);
  let remainder = total - amounts.reduce((sum, amount) => sum + amount, 0);
  const byFraction = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; remainder > 0; i = (i + 1) % byFraction.length, remainder--) {
    amounts[byFraction[i].index] += 1;
  }
  return amounts;
}

/**
 * Builds the budget breakdown. Steps: start from the profile's default split,
 * add a rentals share for outdoor/hybrid settings, boost prioritized
 * categories, reserve contingency, then convert shares to whole amounts.
 * @param {import("../validation.js").PlanRequest} input
 * @param {object} profile  an EVENT_PROFILES entry
 * @param {{ leadRatio: number, tier: string }} context
 * @returns {import("./index.js").Budget}
 */
export function allocateBudget(input, profile, { leadRatio, tier }) {
  const weights = { ...profile.allocation };
  delete weights.contingency;

  if (RENTAL_SHARE[input.setting] > 0) {
    weights.rentals = (weights.rentals ?? 0) + RENTAL_SHARE[input.setting];
  }

  const boosted = new Set(input.priorities.flatMap((priority) => PRIORITY_CATEGORIES[priority]));
  for (const key of boosted) {
    if (key in weights) weights[key] *= PRIORITY_BOOST;
  }

  const contingency = contingencyShare({ setting: input.setting, leadRatio });
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const keys = [...Object.keys(weights), "contingency"];
  const shares = keys.map((key) =>
    key === "contingency" ? contingency : (weights[key] / weightTotal) * (1 - contingency),
  );

  const total = Math.round(input.budget);
  const amounts = splitWhole(total, shares);
  const items = keys
    .map((key, index) => ({
      key,
      label: BUDGET_LABELS[key],
      percent: Math.round(shares[index] * 1000) / 10,
      amount: amounts[index],
      prioritized: boosted.has(key),
    }))
    .sort((a, b) => (a.key === "contingency") - (b.key === "contingency") || b.amount - a.amount);

  return {
    total,
    currency: input.currency,
    perGuest: Math.round((total / input.guestCount) * 100) / 100,
    tier,
    items,
  };
}
