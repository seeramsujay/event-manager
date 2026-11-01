/**
 * @typedef {object} RefinementQuestion
 * @property {string} id
 * @property {string} category
 * @property {string} question
 * @property {string} tip
 */

/**
 * Generates discovery questions for the plan to refine food taste, vibe, demographics, and budget levers.
 * @param {import("../validation.js").PlanRequest} input
 * @param {object} ctx
 * @param {import("./budget.js").Budget} budget
 * @returns {RefinementQuestion[]}
 */
export function buildQuestions(input, ctx, budget) {
  const isMicro = input.guestCount <= 50;
  return [
    {
      id: "food-taste",
      category: "Food & Beverage",
      question: `What are the audience food tastes, dietary needs (vegan, allergies, halal), and bar preferences for your ${input.guestCount} guests?`,
      tip: isMicro
        ? `With ${input.guestCount} guests, an intimate restaurant private dining room with a customized seasonal tasting menu avoids rental and service staffing surcharges.`
        : `For ${input.guestCount} guests, structured dual-sided buffet lines or pre-selected plated choices are required to avoid long dinner service delays.`,
    },
    {
      id: "vibe-atmosphere",
      category: "Vibe & Atmosphere",
      question: `What aesthetic, musical style (live band vs curated DJ), and lighting mood best fit your ${input.setting} setting${input.location ? ` in ${input.location}` : ""}?`,
      tip: "Lighting and acoustics define the atmosphere: prioritize warm dimmable bistro stringing, table pin-spots, and sound acoustic baffles.",
    },
    {
      id: "audience-accessibility",
      category: "Audience & Demographics",
      question: "Are there children, elderly family members, or guests with mobility or sensory needs?",
      tip: "Verify step-free entry routes, accessible restroom proximity, and a quiet retreat lounge away from primary audio speakers.",
    },
    {
      id: "budget-priorities",
      category: "Budget Levers",
      question: `Within your ${budget.total} ${budget.currency} (${budget.tier} tier) budget, what is the single non-negotiable highlight element?`,
      tip: "Invest in 1–2 memorable guest experiences (e.g. signature cocktail bar, live entertainment, or photo lounge) and cut back on standard tablecloths and printware.",
    },
  ];
}
