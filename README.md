# Plan Together: GenAI Event Planning Assistant

[![CI](https://github.com/seeramsujay/event-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/seeramsujay/event-manager/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-537%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/coverage-100%25%20lines-brightgreen)
![Node](https://img.shields.io/badge/node-%E2%89%A522.9-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

An assistant that helps people organize **weddings, birthdays and community events**. You describe your event (date, guests, budget, setting, style, priorities and needs) and it builds a plan with:

| Part of the plan | What you get |
|---|---|
| 💰 **Budget breakdown** | Category amounts that add up exactly to your budget, shifted toward what you care about most |
| 🗓️ **Timeline** | Tasks scheduled backwards from your date. If you have less time than usual, the whole schedule is compressed to fit |
| ✅ **Vendor checklist** | What to book, how important it is, the date to book it by and a practical tip. Ticks are saved in your browser |
| ⚠️ **Context-aware insights** | Warnings and tips for rushed timelines, tight budgets, weather, crowds, kids, milestone birthdays and accessibility |
| ✨ **Personalized ideas** | Themes, decor, food, activities and budget tips from Claude, grounded in your plan. Curated ideas are used as a fallback |

---

## Contents

1. [Chosen vertical](#chosen-vertical)
2. [Approach and logic](#approach-and-logic)
3. [How it works](#how-it-works)
4. [Getting started](#getting-started)
5. [Configuration](#configuration)
6. [Quality: security, testing, accessibility, efficiency](#quality)
7. [Assumptions](#assumptions)
8. [Further documentation](#further-documentation)

---

## Chosen vertical

**Event planning assistant.** The persona is a host or organizer: a couple, a parent, a friend or a community volunteer. They are not a professional planner. They need a realistic plan they can act on, and it has to fit their budget and the time they have left. Three event types are supported, each with its own budgeting, timeline, vendor and idea knowledge.

## Approach and logic

The design is a hybrid: **deterministic rules for decisions, GenAI for creativity.**

| Concern | Who decides | Why |
|---|---|---|
| Budget amounts, deadlines, vendor importance, risks | **Rules engine** (`src/planner/`) | Must be exact, explainable and testable: money has to add up, and permits and weather plans must never be forgotten |
| Themes, decor, food, activities, personal touches | **Claude** (`src/ai/ideas.js`) | Open-ended and creative, and benefits from the user's own words |

The LLM receives the engine's results (budget tier, top categories, key risks) as grounding context, so its ideas match the plan. As a result:

- The plan is **always available**, fast and free, even with no API key or when the AI is down.
- Every number and date can be **traced to a rule** and is covered by tests.
- The AI's ideas stay **consistent** with the computed budget and risks.

### Decision logic

| Context signal | Effect on the plan |
|---|---|
| **Event type** | Selects a profile: default budget split, ideal lead time (wedding 52 weeks, community 16, birthday 8), tasks, vendors and ideas |
| **Budget ÷ guests** (normalized to USD) | Sets the tier: **lean / moderate / premium**. Lean plans get warnings, DIY nudges on optional vendors and frugal tips |
| **Priorities** (venue, food, decor, photography, entertainment) | Matching budget categories get ×1.25 weight; matching vendors move up one importance level |
| **Outdoor setting** | Adds a tents & rentals line (6% weight), weather-backup tasks, rental vendors (essential for weddings and community events, a canopy for birthdays) and +3% contingency |
| **Hybrid setting** | Adds a smaller rentals line (3% weight), weather-backup tasks and recommended rental vendors |
| **Short lead time** | All deadlines scale proportionally, so order is kept and nothing falls in the past. Tasks due within 7 days are flagged. Vendors past their usual booking window are marked **Book now**. Contingency +2% under half the ideal time. The timeline insight is *critical* below 35% of the ideal time |
| **Guest count** | Day-of coordinator (weddings ≥150); security and authority coordination (community ≥300); first aid essential (community ≥200) |
| **Birthday age** | ≤12 is a kids' party: supervision, allergy-safe snacks, no bartender. Milestone ages (18, 21, 30, 40, …) add a tribute task |
| **Kids attending** | Kids' table task (weddings), supervision staff and activities (birthdays), family-themed ideas |
| **Accessibility** | Access tasks, sign-language interpreter or accessibility services, an RSVP access-needs reminder |
| **Low waste** | Local seasonal menu and reusable decor, recycling and compost stations, waste service upgraded |
| **Alcohol-free** | No bartender; mocktail ideas replace drinks |
| **Saturday wedding or birthday** | Suggests Friday or Sunday for better rates |
| **Food money per guest below a floor** | Suggests food trucks, potluck or a dessert format (the floor is currency-aware) |

Budget amounts are split with the **largest-remainder method**, so they always add up exactly to the total. This is checked on thousands of generated plans.

### GenAI layer

- **Model:** Claude (`claude-opus-5-5` by default), called through the official Anthropic SDK.
- **Structured outputs:** a JSON schema constrains the reply, so it is always machine-readable.
- **Grounding:** the prompt holds the event context plus the engine's tier, top budget categories and key risks.
- **Privacy:** the event name is never sent, because it often contains people's names.
- **Prompt-injection defense:** user text is placed in `<vibe>` and `<notes>` fences with angle brackets removed, so it can't escape them, and the system prompt treats it as data, not instructions.
- **Output validation:** a second check with Zod rejects empty answers and caps list sizes and string lengths.
- **Resilience:** the server-side refusal fallback (`fallbacks: "default"`) re-runs a declined request on a suitable model. Any other failure (network, rate limit, refusal, invalid output) falls back to curated ideas with a short notice, so the user always gets a plan.
- **Cost and speed:** identical requests are cached for one hour, and effort is set to `low` because the rules engine has already done the reasoning.

## How it works

```mermaid
flowchart LR
  B[Browser<br/>public/] -- POST /api/plan --> A[app.js<br/>rate limit · size/type checks]
  A --> V[validation.js<br/>Zod schema + date rules]
  V --> P[planner/index.js<br/>buildPlan — pure]
  P --> BU[budget.js] & T[timeline.js] & VE[vendors.js] & I[insights.js]
  P --> AI[ai/ideas.js]
  AI -- structured JSON --> C[(Claude API)]
  AI -. on failure .-> CU[curated ideas]
  AI --> A
  A -- JSON plan --> B
```

### Project structure

```
src/
  server.js          entry point: config, Anthropic client, HTTP server, graceful shutdown
  config.js          environment variables, validated at startup
  app.js             request handler: routing, security headers, body limits, rate limiting
  validation.js      Zod request schema + calendar rules
  planner/
    catalog.js       planning knowledge as data: budgets, tasks, vendors, ideas
    index.js         buildPlan(): runs the steps below
    budget.js        tier + allocation (largest-remainder split)
    timeline.js      backward scheduling + proportional compression
    vendors.js       checklist, priority upgrades, booking windows
    insights.js      context rules → warnings and tips
    dates.js         UTC calendar-day helpers
  ai/ideas.js        Claude integration: prompt, schema, validation, cache, fallback
  lib/               TTL/LRU cache, bounded rate limiter
public/              accessible static frontend (HTML, CSS, vanilla JS, no build step)
test/                537 tests: unit, property-based, HTTP integration, jsdom UI, process
docs/                architecture and API reference
```

## Getting started

Requires **Node.js 22.9+**.

```bash
git clone https://github.com/seeramsujay/event-manager.git
cd event-manager
npm install
cp .env.example .env        # optional: add ANTHROPIC_API_KEY for AI ideas
npm start                   # → http://127.0.0.1:3000
```

Without `ANTHROPIC_API_KEY` the app runs in **curated mode**: everything works, and ideas come from a hand-written catalog.

| Command | What it does |
|---|---|
| `npm start` | Run the server (reads `.env` if present) |
| `npm run dev` | Run with auto-restart on file changes |
| `npm test` | Run all 537 tests |
| `npm run test:coverage` | Tests with coverage; fails below 98% lines, 95% branches or 98% functions |
| `npm run lint` | ESLint |
| `npm run check` | Lint plus tests with coverage: the same gate CI runs |

## Configuration

All settings are environment variables, validated at startup. A bad value stops the server with a clear message instead of starting half-broken.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Turns on AI-personalized ideas. Stays on the server |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model override |
| `PORT` | `3000` | Listen port (`0` = any free port) |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` in containers |
| `RATE_LIMIT_PER_MINUTE` | `20` | Plan requests per client per minute (1–10,000) |
| `TRUST_PROXY` | `false` | Set to `true` **only** behind a reverse proxy that appends `X-Forwarded-For`. The proxy-appended (right-most) entry is then used as the client address |

<a id="quality"></a>
## Quality: security, testing, accessibility, efficiency

### 🔒 Security

| Threat | Mitigation |
|---|---|
| API key exposure | Used only on the server and never logged; the browser talks only to this app |
| Malicious or malformed input | Strict Zod schema: unknown fields rejected, typed numbers, enums, real calendar dates, length limits, control characters stripped |
| Oversized or abusive requests | 16 KB body limit enforced while streaming; JSON-only media type; request timeout |
| Cost abuse of the paid AI endpoint | Per-client rate limit with bounded memory, IPv6 grouped by /64, spoof-resistant proxy handling, response cache |
| XSS | The UI renders only through `textContent`; strict CSP (`'self'` only, no inline scripts or styles); tests inject HTML through both AI and user fields |
| Clickjacking and data leaks | `frame-ancestors 'none'`, `X-Frame-Options`, `no-referrer`, `nosniff`, a Permissions-Policy, and `Cache-Control: no-store` on API responses |
| Path traversal | Static files come from a fixed allowlist preloaded into memory; the filesystem is never touched with user input |
| Prompt injection | User text is fenced and stripped of angle brackets; the system prompt treats it as data; output is schema-constrained and re-validated |
| Crashes from bad requests | All handler errors are caught and return generic messages; malformed request targets are tested at the raw-socket level |
| Vulnerable dependencies | Two runtime dependencies; CI runs `npm audit` |

### 🧪 Testing: 537 tests, 100% line coverage

| Suite | Tests | What it covers |
|---|---|---|
| `invariants` | 81 | **Property-based:** 2,000 seeded random plans must satisfy every invariant (money adds up, dates are ordered and never in the past, sorting, determinism, fence safety) |
| `validation` | 92 | Boundaries, wrong types, malformed bodies, normalization, unicode, time-zone grace, human-readable messages |
| `app` | 48 | Full HTTP stack: headers, content negotiation, 400/404/405/413/415/422/429/500, chunked bodies, path traversal, raw malformed targets, proxy spoofing |
| `ideas` | 43 | Claude request shape, fallback-block parsing, caching, 13 failure modes, output trimming, prompt privacy and fencing |
| `dates`, `catalog`, `config` | 89 | Calendar edge cases (leap years), catalog data integrity, configuration parsing |
| `timeline`, `vendors`, `insights`, `budget`, `planner` | 123 | Every rule triggered and not triggered, table-driven |
| `frontend` | 32 | Real page in jsdom: validation UX, focus management, rendering, XSS, checklist persistence, failure handling, an **automated accessibility audit** |
| `lib`, `server` | 28 | Cache and rate-limiter edge cases; the real entry point as a child process (startup, config errors, SIGTERM/SIGINT) |

CI runs lint, tests with coverage thresholds and `npm audit` on Node 22 and 24 for every push.

### ♿ Accessibility (built to WCAG 2.2 AA)

- Semantic landmarks, a skip link, a single `h1` and headings without skipped levels (all checked by tests).
- Every control has a label. Radio and checkbox groups use `fieldset` and `legend`, and the budget table has a caption and scoped headers.
- Errors are linked with `aria-describedby` and `aria-invalid`, and focus moves to the first invalid field. Status updates use a polite live region, and focus moves to the results when they are ready.
- The submit button uses `aria-disabled` while busy, so keyboard focus is never lost.
- Fully keyboard-operable, with visible focus rings. Text contrast is ≥ 4.5:1 in both light and dark themes.
- Respects `prefers-color-scheme` and `prefers-reduced-motion`. Responsive down to phone width, with a print stylesheet.

### ⚡ Efficiency

- Two runtime dependencies (the Anthropic SDK and Zod); the server uses Node's built-in `http`.
- The rules engine is pure and runs in about a millisecond; 2,000 generated plans take well under a second in tests.
- One LLM call per plan, at low effort, cached for an hour, and skipped entirely when AI is off.
- Static assets are held in memory, and the frontend has no framework or build step.
- Bounded memory everywhere: the LRU cache holds at most 100 entries and the rate limiter at most 10,000 clients.

## Assumptions

- Budget shares, lead times, tier thresholds and vendor booking windows are typical industry rules of thumb. They are guidance, not quotes.
- Currency conversion uses fixed approximate rates and is used **only** to pick a budget tier and food threshold. Amounts are shown in the user's currency.
- Dates are calendar days in UTC. One day of grace means "today" in time zones behind UTC is still accepted. Plans can be made up to 5 years ahead.
- Legal steps (marriage license, permits, insurance) vary by location, so the plan reminds users to check local requirements.
- Checklist progress is stored in the browser's `localStorage`, keyed to the exact plan inputs. There are no accounts and no server-side storage of personal data.
- The rate limiter and cache are in-memory, which suits a single instance. A multi-instance deployment would move them to a shared store such as Redis.

## Further documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): design decisions, the planning pipeline, AI integration and the security model in depth
- [`docs/API.md`](docs/API.md): HTTP API reference with request and response examples

## License

[MIT](LICENSE)
