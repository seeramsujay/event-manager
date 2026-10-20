// Shared fixtures. A fixed clock keeps date-based assertions deterministic.
export const NOW = new Date("2026-01-01T12:00:00Z");

export function request(overrides = {}) {
  return {
    eventType: "wedding",
    eventName: "",
    date: "2027-01-02",
    guestCount: 100,
    budget: 30000,
    currency: "USD",
    setting: "indoor",
    vibe: "",
    priorities: [],
    considerations: [],
    notes: "",
    useAI: true,
    ...overrides,
  };
}
