import { BUDGET_LABELS, PRIORITY_CATEGORIES, USD_RATES } from "./catalog.js";

const PRIORITY_BOOST = 1.25;
const OUTDOOR_RENTAL_SHARE = 0.06;
const BASE_CONTINGENCY = 0.05;

/** Classifies spend per guest (normalized to USD) as lean, moderate or premium. */
export function budgetTier({ budget, guestCount, currency }, profile) {
  const perGuestUsd = (budget * USD_RATES[currency]) / guestCount;
  if (perGuestUsd < profile.tiers.lean) return "lean";
  if (perGuestUsd >= profile.tiers.premium) return "premium";
  return "moderate";
}

/** Riskier plans (outdoor, rushed) keep a larger reserve for surprises. */
export function contingencyShare({ setting, leadRatio }) {
  let share = BASE_CONTINGENCY;
  if (setting === "outdoor") share += 0.03;
  if (leadRatio < 0.5) share += 0.02;
  return share;
}

/**
 * Splits whole currency units by share using the largest-remainder method,
 * so the parts always add up exactly to the total.
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

export function allocateBudget(input, profile, { leadRatio, tier }) {
  const weights = { ...profile.allocation };
  delete weights.contingency;

  if (input.setting === "outdoor") {
    weights.rentals = (weights.rentals ?? 0) + OUTDOOR_RENTAL_SHARE;
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
