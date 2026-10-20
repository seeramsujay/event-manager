// Static planning knowledge used by the engine. Kept as plain data so the
// recommendations can be tuned without touching the decision logic.

export const EVENT_TYPES = ["wedding", "birthday", "community"];
export const SETTINGS = ["indoor", "outdoor", "hybrid"];
export const PRIORITIES = ["venue", "food", "decor", "photography", "entertainment"];
export const CONSIDERATIONS = ["accessibility", "sustainability", "alcohol-free", "kid-friendly"];

/** Approximate conversion to USD. Used only to choose a budget tier, never for display. */
export const USD_RATES = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, INR: 0.012 };
export const CURRENCIES = Object.keys(USD_RATES);

export const BUDGET_LABELS = {
  venue: "Venue",
  catering: "Food & drinks",
  photography: "Photo & video",
  decor: "Decor & flowers",
  music: "Music",
  attire: "Attire & beauty",
  stationery: "Invitations & stationery",
  transport: "Transport",
  cake: "Cake & desserts",
  entertainment: "Entertainment",
  favors: "Favors & gifts",
  permits: "Permits & insurance",
  av: "Sound & AV",
  marketing: "Promotion",
  rentals: "Tents & equipment rentals",
  safety: "Safety & first aid",
  contingency: "Contingency reserve",
};

/** Which budget categories each user priority boosts. */
export const PRIORITY_CATEGORIES = {
  venue: ["venue"],
  food: ["catering", "cake"],
  decor: ["decor"],
  photography: ["photography"],
  entertainment: ["music", "entertainment"],
};

export const MILESTONE_AGES = new Set([1, 13, 16, 18, 21, 30, 40, 50, 60, 70, 75, 80, 90, 100]);

const isOutdoor = (ctx) => ctx.setting === "outdoor";
const needsWeatherPlan = (ctx) => ctx.setting !== "indoor";
const has = (consideration) => (ctx) => ctx.considerations.includes(consideration);

/*
 * Each profile holds:
 *  - allocation: default budget shares (sum to 1, including contingency)
 *  - tiers: per-guest USD thresholds for lean / premium budgets
 *  - tasks: { weeksBefore, when? } — negative weeks are post-event
 *  - vendors: { base priority, bookWeeksBefore, when?, priority?(ctx) }
 */
export const EVENT_PROFILES = {
  wedding: {
    label: "Wedding",
    idealLeadWeeks: 52,
    allocation: {
      venue: 0.28, catering: 0.27, photography: 0.11, decor: 0.09, music: 0.07,
      attire: 0.08, stationery: 0.03, transport: 0.02, contingency: 0.05,
    },
    tiers: { lean: 75, premium: 250 },
    tasks: [
      { id: "w-budget", title: "Agree on budget, guest list and must-haves", weeksBefore: 52 },
      { id: "w-venue", title: "Tour and book the venue", weeksBefore: 48 },
      { id: "w-photo", title: "Book photographer / videographer", weeksBefore: 44 },
      { id: "w-catering", title: "Book caterer and schedule a tasting", weeksBefore: 40 },
      { id: "w-std", title: "Send save-the-dates", weeksBefore: 36 },
      { id: "w-attire", title: "Choose attire and book fittings", weeksBefore: 32 },
      { id: "w-music", title: "Book DJ or band", weeksBefore: 28 },
      { id: "w-decor", title: "Book florist and finalize decor concept", weeksBefore: 24 },
      { id: "w-coordinator", title: "Hire a day-of coordinator", weeksBefore: 20, when: (ctx) => ctx.guestCount >= 150 },
      { id: "w-travel", title: "Arrange transport and guest accommodation blocks", weeksBefore: 20 },
      { id: "w-green", title: "Choose a seasonal local menu and rental (reusable) decor", weeksBefore: 16, when: has("sustainability") },
      { id: "w-weather", title: "Reserve a tent and confirm the bad-weather backup", weeksBefore: 12, when: needsWeatherPlan },
      { id: "w-invites", title: "Send invitations with RSVP deadline", weeksBefore: 12 },
      { id: "w-access", title: "Confirm step-free access, accessible restrooms and reserved seating", weeksBefore: 8, when: has("accessibility") },
      { id: "w-kids", title: "Plan a kids' table with activities and a quiet corner", weeksBefore: 8, when: (ctx) => ctx.kidFriendly },
      { id: "w-menu", title: "Finalize menu, dietary needs and cake", weeksBefore: 8 },
      { id: "w-license", title: "Obtain marriage license (check local requirements)", weeksBefore: 6 },
      { id: "w-headcount", title: "Send final headcount and seating plan to caterer", weeksBefore: 4 },
      { id: "w-confirm", title: "Confirm every vendor and share the run-of-show", weeksBefore: 2 },
      { id: "w-rehearsal", title: "Rehearsal and pack the emergency kit", weeksBefore: 1 },
      { id: "w-day", title: "Wedding day — enjoy it!", weeksBefore: 0 },
      { id: "w-thanks", title: "Settle final payments and send thank-you notes", weeksBefore: -2 },
    ],
    vendors: [
      { id: "venue", name: "Venue", category: "venue", base: "essential", bookWeeksBefore: 48, tip: "Ask what is included: tables, chairs, linens, setup and cleanup." },
      { id: "caterer", name: "Caterer", category: "catering", base: "essential", bookWeeksBefore: 40, tip: "Get per-head quotes that include service charges and gratuity." },
      { id: "officiant", name: "Officiant", category: "venue", base: "essential", bookWeeksBefore: 36, tip: "Confirm they are authorized to solemnize marriages where you are." },
      { id: "attire", name: "Attire & alterations", category: "attire", base: "essential", bookWeeksBefore: 32, tip: "Allow time for two or three fittings." },
      { id: "photographer", name: "Photographer", category: "photography", base: "recommended", bookWeeksBefore: 44, tip: "Review full galleries, not just highlight reels." },
      { id: "music", name: "DJ or band", category: "music", base: "recommended", bookWeeksBefore: 28, tip: "Share a must-play and do-not-play list." },
      { id: "florist", name: "Florist / decorator", category: "decor", base: "recommended", bookWeeksBefore: 24, tip: "Seasonal flowers cost less and look fresher." },
      { id: "rentals", name: "Tent & rental company", category: "rentals", base: "optional", bookWeeksBefore: 16, when: needsWeatherPlan, priority: (ctx) => (isOutdoor(ctx) ? "essential" : "recommended"), tip: "Reserve a tent even if the forecast looks good — release it later if allowed." },
      { id: "coordinator", name: "Day-of coordinator", category: "venue", base: "optional", bookWeeksBefore: 20, priority: (ctx) => (ctx.guestCount >= 150 ? "recommended" : "optional"), tip: "Frees you and your family from troubleshooting on the day." },
      { id: "beauty", name: "Hair & makeup", category: "attire", base: "optional", bookWeeksBefore: 16, tip: "Book a trial session." },
      { id: "cake", name: "Cake baker", category: "catering", base: "optional", bookWeeksBefore: 12, tip: "A small display cake plus a sheet cake saves money." },
      { id: "transport", name: "Transport", category: "transport", base: "optional", bookWeeksBefore: 12, tip: "A shuttle helps when the ceremony and reception are apart." },
      { id: "interpreter", name: "Sign language interpreter", category: "venue", base: "recommended", bookWeeksBefore: 8, when: has("accessibility"), tip: "Seat them where they are clearly visible to guests who need them." },
    ],
    ideas: {
      themes: [
        { name: "Garden romance", description: "Soft florals, string lights and long communal tables.", keywords: ["garden", "romantic", "outdoor", "boho", "floral"] },
        { name: "Modern minimal", description: "Clean lines, monochrome palette with a single bold accent color.", keywords: ["modern", "minimal", "chic", "elegant", "city"] },
        { name: "Rustic harvest", description: "Wood, linen, wildflowers and family-style seasonal food.", keywords: ["rustic", "barn", "country", "vintage", "autumn"] },
        { name: "Cultural fusion", description: "Blend both families' traditions in the music, food and ceremony.", keywords: ["cultural", "traditional", "fusion", "heritage"] },
      ],
      decor: ["Potted plants guests can take home as favors", "Candle clusters at varying heights", "A welcome sign with a short story of how you met"],
      food: ["Family-style platters to encourage conversation", "A late-night snack station", "A signature drink named after the couple"],
      activities: ["Guest advice cards at each table", "A photo corner with a printed backdrop", "A choreographed first-dance surprise"],
    },
  },

  birthday: {
    label: "Birthday",
    idealLeadWeeks: 8,
    allocation: {
      venue: 0.25, catering: 0.3, cake: 0.08, decor: 0.12, entertainment: 0.12,
      photography: 0.05, favors: 0.03, contingency: 0.05,
    },
    tiers: { lean: 25, premium: 100 },
    tasks: [
      { id: "b-plan", title: "Set budget, guest list and theme", weeksBefore: 8 },
      { id: "b-venue", title: "Book venue (or prepare the home or park space)", weeksBefore: 7 },
      { id: "b-entertainment", title: "Book entertainment", weeksBefore: 6 },
      { id: "b-tribute", title: "Collect photos and messages for a milestone tribute", weeksBefore: 5, when: (ctx) => ctx.isMilestone },
      { id: "b-invites", title: "Send invitations with RSVP date", weeksBefore: 4 },
      { id: "b-kids", title: "Plan supervised activities and allergy-safe snacks", weeksBefore: 3, when: (ctx) => ctx.kidFriendly },
      { id: "b-cake", title: "Order the cake", weeksBefore: 3 },
      { id: "b-decor", title: "Buy decorations and favors", weeksBefore: 2 },
      { id: "b-weather", title: "Confirm a covered backup space in case of rain", weeksBefore: 2, when: needsWeatherPlan },
      { id: "b-confirm", title: "Confirm headcount with food vendor", weeksBefore: 1 },
      { id: "b-day", title: "Party day — set up and celebrate", weeksBefore: 0 },
      { id: "b-thanks", title: "Share photos and send thank-yous", weeksBefore: -1 },
    ],
    vendors: [
      { id: "venue", name: "Venue or space", category: "venue", base: "essential", bookWeeksBefore: 7, tip: "Home, park or community-hall parties free up budget for food and fun." },
      { id: "food", name: "Food / caterer", category: "catering", base: "essential", bookWeeksBefore: 4, tip: "Finger food and grazing boards stretch further than plated meals." },
      { id: "cake", name: "Cake or bakery", category: "cake", base: "essential", bookWeeksBefore: 3, tip: "Ask about allergy-friendly options." },
      {
        id: "entertainer", name: "Entertainer", category: "entertainment", base: "recommended", bookWeeksBefore: 6,
        tip: (ctx) => (ctx.isKids ? "Magicians, face painters and bubble shows suit young kids." : "A DJ, live acoustic set or games host keeps adults mingling."),
      },
      { id: "decor", name: "Balloons & decor", category: "decor", base: "recommended", bookWeeksBefore: 2, tip: "Pick two colors and repeat them everywhere for impact." },
      { id: "supervision", name: "Activity staff / childcare", category: "entertainment", base: "recommended", bookWeeksBefore: 4, when: (ctx) => ctx.kidFriendly, tip: "Aim for at least one adult per 6–8 young children." },
      { id: "favors", name: "Party favors", category: "favors", base: "optional", bookWeeksBefore: 2, priority: (ctx) => (ctx.isKids ? "recommended" : "optional"), tip: "One useful item beats a bag of small plastic toys." },
      { id: "photographer", name: "Photographer", category: "photography", base: "optional", bookWeeksBefore: 4, tip: "Ask a friend to own photos for the first hour, or book a 2-hour package." },
      { id: "canopy", name: "Canopy / shade rental", category: "rentals", base: "optional", bookWeeksBefore: 3, when: needsWeatherPlan, priority: (ctx) => (isOutdoor(ctx) ? "recommended" : "optional"), tip: "Shade and a rain cover keep the party going in any weather." },
      { id: "bartender", name: "Bartender", category: "catering", base: "optional", bookWeeksBefore: 3, when: (ctx) => !ctx.isKids && !ctx.considerations.includes("alcohol-free") && ctx.guestCount >= 30, tip: "A limited signature-cocktail menu keeps costs predictable." },
    ],
    ideas: {
      themes: [
        { name: "Retro decade night", description: "Music, outfits and snacks from the guest of honor's favorite decade.", keywords: ["retro", "80s", "90s", "disco", "vintage", "party"] },
        { name: "Picnic in the park", description: "Blankets, lawn games and a grazing table outdoors.", keywords: ["outdoor", "picnic", "relaxed", "casual", "garden"] },
        { name: "Adventure quest", description: "A treasure hunt with clues that end at the cake.", keywords: ["kids", "adventure", "games", "fun", "pirate", "superhero"] },
        { name: "Cozy dinner party", description: "Long table, candles and a menu of the guest of honor's favorites.", keywords: ["intimate", "elegant", "dinner", "cozy", "classy"] },
      ],
      decor: ["Balloon garland in two colors", "Photo timeline of the guest of honor", "Personalized place cards"],
      food: ["Build-your-own taco or pizza bar", "Cupcake decorating station", "Mocktail bar with fun garnishes"],
      activities: ["Collaborative playlist guests add to", "Instant-camera guest book", "Short trivia game about the guest of honor"],
    },
  },

  community: {
    label: "Community event",
    idealLeadWeeks: 16,
    allocation: {
      venue: 0.2, catering: 0.22, permits: 0.08, av: 0.12, marketing: 0.1,
      entertainment: 0.1, rentals: 0.08, safety: 0.05, contingency: 0.05,
    },
    tiers: { lean: 10, premium: 50 },
    tasks: [
      { id: "c-goals", title: "Define goals and audience; form a volunteer team", weeksBefore: 16 },
      { id: "c-venue", title: "Reserve the venue or public space", weeksBefore: 14 },
      { id: "c-permits", title: "Apply for permits (assembly, food, noise)", weeksBefore: 12 },
      { id: "c-sponsors", title: "Reach out to sponsors and local businesses", weeksBefore: 12 },
      { id: "c-authorities", title: "Coordinate security and traffic with local authorities", weeksBefore: 10, when: (ctx) => ctx.guestCount >= 300 },
      { id: "c-av", title: "Book sound, stage and performers", weeksBefore: 10 },
      { id: "c-insurance", title: "Arrange event liability insurance", weeksBefore: 8 },
      { id: "c-promo", title: "Launch promotion (social media, flyers, local press)", weeksBefore: 8 },
      { id: "c-outdoor", title: "Rent tents, portable restrooms and plan for weather", weeksBefore: 8, when: needsWeatherPlan },
      { id: "c-food", title: "Confirm food vendors and their permits", weeksBefore: 6 },
      { id: "c-access", title: "Accessibility plan: ramps, captioning or sign language, quiet zone", weeksBefore: 6, when: has("accessibility") },
      { id: "c-waste", title: "Set up recycling and compost stations", weeksBefore: 6, when: has("sustainability") },
      { id: "c-volunteers", title: "Recruit volunteers and assign shifts", weeksBefore: 4 },
      { id: "c-safety", title: "Write the safety plan: first aid, exits, lost-child point", weeksBefore: 3 },
      { id: "c-walkthrough", title: "Site walkthrough and volunteer briefing", weeksBefore: 1 },
      { id: "c-day", title: "Event day — run the check-in and safety rounds", weeksBefore: 0 },
      { id: "c-survey", title: "Send feedback survey and thank sponsors", weeksBefore: -1 },
    ],
    vendors: [
      { id: "venue", name: "Venue / public space booking", category: "venue", base: "essential", bookWeeksBefore: 14, tip: "Libraries, schools and parks often offer reduced rates for non-profits." },
      { id: "permits", name: "Permits office", category: "permits", base: "essential", bookWeeksBefore: 12, tip: "Ask about food, amplified sound and road-closure permits together." },
      { id: "insurance", name: "Liability insurance", category: "permits", base: "essential", bookWeeksBefore: 8, tip: "Many venues require a certificate naming them as additionally insured." },
      { id: "av", name: "Sound & AV", category: "av", base: "essential", bookWeeksBefore: 10, tip: "Request a sound check slot before doors open." },
      { id: "food", name: "Food vendors / trucks", category: "catering", base: "recommended", bookWeeksBefore: 6, tip: "Vendors who sell directly to attendees can cost you nothing." },
      { id: "performers", name: "Performers / speakers", category: "entertainment", base: "recommended", bookWeeksBefore: 10, tip: "Local schools and clubs love a stage to perform on." },
      { id: "printing", name: "Printing & promotion", category: "marketing", base: "recommended", bookWeeksBefore: 8, tip: "Put a QR code to the RSVP form on every flyer." },
      { id: "rentals", name: "Tents, tables & restrooms", category: "rentals", base: "optional", bookWeeksBefore: 8, priority: (ctx) => (isOutdoor(ctx) ? "essential" : ctx.setting === "hybrid" ? "recommended" : "optional"), tip: "Plan one portable restroom per ~100 guests for a 4-hour event." },
      { id: "safety", name: "First aid & security", category: "safety", base: "recommended", bookWeeksBefore: 4, priority: (ctx) => (ctx.guestCount >= 200 ? "essential" : "recommended"), tip: "Local volunteer first-aid organizations often cover community events." },
      { id: "waste", name: "Waste & recycling service", category: "rentals", base: "optional", bookWeeksBefore: 4, priority: (ctx) => (ctx.considerations.includes("sustainability") ? "recommended" : "optional"), tip: "Label bins with pictures, not just words." },
      { id: "access", name: "Accessibility services", category: "venue", base: "recommended", bookWeeksBefore: 6, when: has("accessibility"), tip: "Book live captioning or sign language for the main stage." },
    ],
    ideas: {
      themes: [
        { name: "Neighborhood block party", description: "Street games, local food stalls and a community stage.", keywords: ["neighborhood", "street", "block", "local", "festival"] },
        { name: "Cultural showcase", description: "Food, music and crafts from the community's many cultures.", keywords: ["cultural", "diversity", "heritage", "international", "showcase"] },
        { name: "Green fair", description: "Repair cafe, seed swap and talks from local environmental groups.", keywords: ["green", "eco", "sustainable", "environment", "garden"] },
        { name: "Family fun day", description: "Activity zones for every age plus a shaded chill-out area.", keywords: ["family", "kids", "fun", "games", "fair"] },
      ],
      decor: ["Bunting made by local schools", "Clear signage with icons and large text", "A community photo wall"],
      food: ["Local food trucks", "A potluck table with labeled allergens", "Free water refill station"],
      activities: ["Volunteer sign-up booth for local causes", "Kids' craft corner", "Open-mic slot for local talent"],
    },
  },
};

/** Budget-saving tips by tier; shown alongside both AI and curated ideas. */
export const BUDGET_TIPS = {
  lean: [
    "Trim the guest list first — every guest multiplies food, seating and favors.",
    "Choose a daytime or off-peak date for lower venue rates.",
    "Ask talented friends to help with decor, music or photos instead of gifts.",
  ],
  moderate: [
    "Spend most on the one or two things guests will remember; keep the rest simple.",
    "Bundle services (venue + catering, DJ + lighting) for package discounts.",
  ],
  premium: [
    "Invest in a planner or coordinator to protect your time.",
    "Reserve part of the budget for guest experience upgrades, like transport or welcome gifts.",
  ],
};
