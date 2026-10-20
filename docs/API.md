# HTTP API reference

All API responses are JSON (`application/json; charset=utf-8`) and carry `Cache-Control: no-store` plus the security headers listed in [ARCHITECTURE.md](ARCHITECTURE.md#security-model).

| Method & path | Purpose | Rate limited |
|---|---|---|
| `POST /api/plan` | Create a plan with ideas | Yes |
| `GET /api/health` | Liveness and AI status | No |
| `GET /`, `/index.html`, `/styles.css`, `/app.js`, `/favicon.svg` | Frontend | No |

---

## `POST /api/plan`

Creates a complete plan from the event details. The request must use `Content-Type: application/json` (parameters and letter case are ignored) and the body must be at most 16 KB.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `eventType` | string | ✔ | `wedding` · `birthday` · `community` |
| `date` | string | ✔ | `YYYY-MM-DD`, a real calendar date, from yesterday (UTC; time-zone grace) up to 5 years ahead |
| `guestCount` | integer | ✔ | 1–5000 |
| `budget` | number | ✔ | 50–100,000,000; rounded to whole units |
| `currency` | string | | `USD` (default) · `EUR` · `GBP` · `CAD` · `AUD` · `INR` |
| `setting` | string | | `indoor` (default) · `outdoor` · `hybrid` |
| `eventName` | string | | ≤ 80 chars. Shown on the plan; **never sent to the AI** |
| `vibe` | string | | ≤ 200 chars; style keywords |
| `notes` | string | | ≤ 500 chars; dietary needs, traditions and so on |
| `honoreeAge` | integer | | 0–120; used for birthdays only, ignored otherwise |
| `priorities` | string[] | | Any of `venue`, `food`, `decor`, `photography`, `entertainment`; duplicates removed |
| `considerations` | string[] | | Any of `accessibility`, `sustainability`, `alcohol-free`, `kid-friendly`; duplicates removed |
| `useAI` | boolean | | Default `true`. `false` skips the AI and returns curated ideas |

Unknown fields are rejected. Numbers must be JSON numbers, not strings. Control characters are removed from text and surrounding whitespace is trimmed.

### Example

```bash
curl -s http://127.0.0.1:3000/api/plan \
  -H 'Content-Type: application/json' \
  -d '{
    "eventType": "birthday",
    "date": "2026-11-14",
    "guestCount": 25,
    "budget": 1200,
    "setting": "outdoor",
    "honoreeAge": 7,
    "priorities": ["entertainment"],
    "considerations": ["kid-friendly"],
    "vibe": "pirates",
    "notes": "one nut allergy"
  }'
```

### `200 OK`

The response is abbreviated here (`"…"`); real responses contain every item.

```json
{
  "summary": {
    "eventType": "birthday",
    "eventLabel": "Birthday",
    "eventName": "Birthday plan",
    "date": "2026-11-14",
    "guestCount": 25,
    "setting": "outdoor",
    "daysToGo": 25,
    "tier": "moderate"
  },
  "budget": {
    "total": 1200,
    "currency": "USD",
    "perGuest": 48,
    "tier": "moderate",
    "items": [
      { "key": "catering", "label": "Food & drinks", "percent": 26, "amount": 311, "prioritized": false },
      { "key": "venue", "label": "Venue", "percent": 21.6, "amount": 260, "prioritized": false },
      "…"
    ]
  },
  "timeline": {
    "leadDays": 25,
    "idealLeadDays": 56,
    "compressed": true,
    "tasks": [
      { "id": "b-plan", "title": "Set budget, guest list and theme", "phase": "Plan & book", "dueDate": "2026-10-20", "urgent": true },
      "…"
    ]
  },
  "vendors": [
    {
      "id": "venue", "name": "Venue or space", "priority": "essential", "matchesPriority": false,
      "bookBy": "2026-10-23", "bookNow": true,
      "tip": "Home, park or community-hall parties free up budget for food and fun."
    },
    "…"
  ],
  "insights": [
    {
      "level": "warning",
      "title": "Compressed timeline",
      "detail": "You have about 3 weeks; 8 weeks is typical. Deadlines were scaled to fit — book the essential vendors first and accept simpler options for the rest."
    },
    "…"
  ],
  "ideas": {
    "source": "ai",
    "ideas": {
      "themes": [{ "name": "…", "description": "…" }],
      "decor": ["…"],
      "food": ["…"],
      "activities": ["…"],
      "budgetTips": ["…"],
      "personalTouch": "…"
    }
  }
}
```

#### Field guarantees

- `budget.items[].amount` values are whole numbers that sum **exactly** to `budget.total`. Items are ordered largest first, with `contingency` always last.
- `timeline.tasks` are sorted by `dueDate`. Preparation tasks are never before today or after the event date; there is exactly one `Event day` task; `Wrap-up` tasks come after the event.
- `vendors` are sorted by `priority` (`essential` → `recommended` → `optional`), then by `bookBy`.
- `insights` are sorted by `level` (`critical` → `warning` → `info`).
- `ideas.source` is `"ai"` or `"curated"`. When AI was requested but not used, `ideas.notice` explains why in user-friendly terms. `ideas.cached: true` means the AI answer came from the one-hour cache.
- The same input on the same day always produces the same plan; only `ideas` can differ.

### Errors

Every error has the shape `{ "error": string, "details"?: { "field": string, "message": string }[] }`.

| Status | When | Example `error` |
|---|---|---|
| `400` | The body is not valid JSON | `Body must be valid JSON` |
| `405` | A method other than POST (with an `Allow: POST` header) | `Method not allowed` |
| `413` | The body is over 16 KB | `Request body too large` |
| `415` | The content type is not `application/json` | `Content-Type must be application/json` |
| `422` | Validation failed; `details` lists each field | `Please check the highlighted fields.` |
| `429` | Over the rate limit; see the `Retry-After` header | `Too many requests. Please wait a moment.` |
| `500` | Unexpected server error (details are logged, never returned) | `Something went wrong. Please try again.` |

A `422` example:

```json
{
  "error": "Please check the highlighted fields.",
  "details": [
    { "field": "guestCount", "message": "Plan for at least 1 guest." },
    { "field": "date", "message": "The event date cannot be in the past." }
  ]
}
```

`field` is always a top-level request field (or `body` when the body itself is not an object), so a client can attach each message to its input.

---

## `GET /api/health`

```json
{ "status": "ok", "ai": true }
```

`ai` is `true` when the server has Anthropic credentials configured.
