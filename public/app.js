"use strict";

// Plan Together frontend. Plain DOM, no framework or build step.
// All server data is rendered with textContent via el(), never innerHTML,
// so AI or user text can't inject markup.

const form = document.getElementById("plan-form");
const fields = form.elements; // named access via elements avoids clashes with form properties
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submit-btn");
const results = document.getElementById("results");
const ageField = document.getElementById("age-field");
const notes = document.getElementById("notes");
const notesCount = document.getElementById("notes-count");
const errorSummary = document.getElementById("error-summary");
const errorList = document.getElementById("error-list");
const ERROR_FIELDS = ["date", "guestCount", "budget", "honoreeAge", "location"];
// The server bounds AI calls at about a minute; give up a little after that.
const REQUEST_TIMEOUT_MS = 75_000;
let inFlight = false;
/** The plan currently on screen, kept for the text export. */
let currentPlan = null;
/**
 * Creates an element. `props.text` sets textContent, `props.style` takes an
 * object (CSSOM is allowed by the CSP; inline style attributes are not), and
 * any other prop becomes an attribute.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "className") node.className = value;
    else if (key === "style") Object.assign(node.style, value); // CSSOM is allowed by the CSP; style="" is not
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

/** Whole units for large amounts; cents for small ones so "$0" never hides a real value. */
function formatMoney(amount, currency) {
  const digits = amount !== 0 && Math.abs(amount) < 10 ? 2 : 0;
  return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/** Short, stable fingerprint of a plan request (FNV-1a), used to key saved checklist progress. */
function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function formatDate(iso) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: progress just isn't saved */ }
  },
};

// ---- Form behaviour -------------------------------------------------------

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function syncEventType() {
  const isBirthday = fields.eventType.value === "birthday";
  ageField.hidden = !isBirthday;
  if (!isBirthday) fields.honoreeAge.value = "";
}

function readForm() {
  const data = new FormData(form);
  const numberOrUndefined = (value) => (value === "" || value === null ? undefined : Number(value));
  return {
    eventType: data.get("eventType"),
    eventName: data.get("eventName").trim(),
    location: (data.get("location") || "").trim(),
    date: data.get("date"),
    guestCount: numberOrUndefined(data.get("guestCount")),
    budget: numberOrUndefined(data.get("budget")),
    currency: data.get("currency"),
    setting: data.get("setting"),
    vibe: data.get("vibe").trim(),
    honoreeAge: data.get("eventType") === "birthday" ? numberOrUndefined(data.get("honoreeAge")) : undefined,
    priorities: data.getAll("priorities"),
    considerations: data.getAll("considerations"),
    notes: data.get("notes").trim(),
    useAI: data.get("useAI") === "on",
  };
}

function clearErrors() {
  for (const field of ERROR_FIELDS) {
    fields[field].removeAttribute("aria-invalid");
    const message = document.getElementById(`${field}-error`);
    message.hidden = true;
    message.textContent = "";
  }
  errorSummary.hidden = true;
  errorList.replaceChildren();
}

/**
 * Marks each invalid field and lists every problem in one summary, which
 * takes focus so screen reader and keyboard users hear the whole picture and
 * can jump straight to a field.
 */
function showFieldErrors(details) {
  const links = [];
  for (const { field, message } of details) {
    const target = document.getElementById(`${field}-error`);
    if (!target) continue;
    target.textContent = message;
    target.hidden = false;
    fields[field].setAttribute("aria-invalid", "true");
    const link = el("a", { href: `#${field}`, text: message });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      fields[field].focus();
    });
    links.push(el("li", {}, link));
  }
  if (links.length === 0) return;
  errorList.replaceChildren(...links);
  errorSummary.hidden = false;
  errorSummary.focus();
}

function validateLocally(payload) {
  const errors = [];
  if (!payload.date) errors.push({ field: "date", message: "Choose the event date." });
  else if (payload.date < todayIso()) errors.push({ field: "date", message: "The event date cannot be in the past." });
  if (!Number.isInteger(payload.guestCount) || payload.guestCount < 1 || payload.guestCount > 5000) {
    errors.push({ field: "guestCount", message: "Enter a whole number of guests between 1 and 5000." });
  }
  if (!(payload.budget >= 50)) errors.push({ field: "budget", message: "Enter a budget of at least 50." });
  if (payload.honoreeAge !== undefined && !(Number.isInteger(payload.honoreeAge) && payload.honoreeAge >= 0 && payload.honoreeAge <= 120)) {
    errors.push({ field: "honoreeAge", message: "Enter an age between 0 and 120." });
  }
  if (payload.location && payload.location.length > 100) {
    errors.push({ field: "location", message: "Enter a location up to 100 characters." });
  }
  return errors;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error-msg", isError);
}

function setBusy(busy) {
  inFlight = busy;
  // aria-disabled (not disabled) keeps keyboard focus on the button while we wait.
  submitBtn.setAttribute("aria-disabled", String(busy));
  if (busy) results.setAttribute("aria-busy", "true");
  else results.removeAttribute("aria-busy");
}

async function onSubmit(event) {
  event.preventDefault();
  if (inFlight) return;
  clearErrors();
  const payload = readForm();
  const localErrors = validateLocally(payload);
  if (localErrors.length) {
    // The error summary is an alert of its own; an extra status line would be read twice.
    setStatus("");
    showFieldErrors(localErrors);
    return;
  }

  setBusy(true);
  setStatus("Generating your plan...");
  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      results.hidden = true;
      currentPlan = null;
      setStatus(body.details ? "" : body.error ?? "Something went wrong. Please try again.", true);
      if (body.details) showFieldErrors(body.details);
      return;
    }
    const { useAI, ...planInputs } = payload;
    renderPlan(body, fingerprint(planInputs));
    setStatus("Your plan is ready.");
    results.hidden = false;
    document.getElementById("results-heading").focus();
  } catch (error) {
    results.hidden = true;
    currentPlan = null;
    setStatus(
      error?.name === "TimeoutError"
        ? "This is taking too long. Please try again, or turn off AI ideas for a faster plan."
        : "Could not reach the server. Check your connection and try again.",
      true,
    );
  } finally {
    setBusy(false);
  }
}

// ---- Rendering ------------------------------------------------------------

function renderSummary({ summary, budget }) {
  const stats = [
    ["Event", summary.eventName],
    summary.location ? ["Location", summary.location] : null,
    ["Date", formatDate(summary.date)],
    ["Days to go", String(summary.daysToGo)],
    ["Guests", String(summary.guestCount)],
    ["Budget", formatMoney(budget.total, budget.currency)],
    ["Per guest", `${formatMoney(budget.perGuest, budget.currency)} (${budget.tier})`],
  ];
  document.getElementById("summary").replaceChildren(
    ...stats.filter(Boolean).map(([label, value]) => {
      const ddProps = { className: "stat-value" };
      let children = [];
      if (label === "Location" && value) {
        ddProps.text = value;
        const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
        const link = el("a", {
          href: mapUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "map-link",
          "aria-label": `View ${value} on Google Maps (opens in new tab)`,
        }, [el("span", { "aria-hidden": "true" }, " 🗺️ "), "Maps ↗"]);
        children = [link];
      } else {
        ddProps.text = value;
      }
      return el("dl", { className: "stat" }, [
        el("dt", { className: "stat-label", text: label }),
        el("dd", ddProps, children),
      ]);
    }),
  );
  const heading = document.getElementById("results-heading");
  if (heading) heading.textContent = summary.eventName ? `Your plan: ${summary.eventName}` : "Your plan";
  const printSub = document.getElementById("print-subtitle");
  if (printSub) printSub.textContent = summary.eventName ? `${summary.eventName} • Generated Event Plan` : "AI Event Planning Assistant • Generated Event Plan";
}

function renderInsights(insights) {
  document.getElementById("insights-section").hidden = insights.length === 0;
  document.getElementById("insights").replaceChildren(
    ...insights.map((insight) =>
      el("li", { className: `insight ${insight.level}` }, [
        el("span", { className: "badge", text: insight.level === "info" ? "Tip" : insight.level === "warning" ? "Heads up" : "Act now" }),
        el("strong", { text: insight.title }),
        el("span", { text: insight.detail }),
      ]),
    ),
  );
}

const PIE_COLORS = [
  "#6b2f8f",
  "#1a5fb4",
  "#26a269",
  "#e5a50a",
  "#c64600",
  "#a4161a",
  "#865e3c",
  "#77767b",
  "#2ca02c",
  "#8a5300",
];

function renderBudgetPie(items, currency) {
  const svg = document.getElementById("budget-pie");
  if (!svg) return;
  svg.replaceChildren();

  const totalPercent = items.reduce((sum, item) => sum + item.percent, 0);
  if (totalPercent <= 0) return;

  const cx = 60;
  const cy = 60;
  const r = 48;
  const innerR = 24;
  let currentAngle = -Math.PI / 2;
  const ns = "http://www.w3.org/2000/svg";

  items.forEach((item, index) => {
    if (item.percent <= 0) return;

    const sliceAngle = (item.percent / totalPercent) * 2 * Math.PI;
    const endAngle = currentAngle + sliceAngle;
    const path = document.createElementNS(ns, "path");
    const color = PIE_COLORS[index % PIE_COLORS.length];

    if (item.percent >= 99.9) {
      path.setAttribute("d", `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`);
    } else {
      const x1 = cx + r * Math.cos(currentAngle);
      const y1 = cy + r * Math.sin(currentAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);

      const ix1 = cx + innerR * Math.cos(endAngle);
      const iy1 = cy + innerR * Math.sin(endAngle);
      const ix2 = cx + innerR * Math.cos(currentAngle);
      const iy2 = cy + innerR * Math.sin(currentAngle);

      const largeArc = sliceAngle > Math.PI ? 1 : 0;
      const d = [
        `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
        `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
        `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
        "Z",
      ].join(" ");
      path.setAttribute("d", d);
    }

    path.setAttribute("fill", color);
    path.setAttribute("stroke", "var(--surface)");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("class", "pie-slice");

    const title = document.createElementNS(ns, "title");
    title.textContent = `${item.label}: ${item.percent}% (${formatMoney(item.amount, currency)})`;
    path.append(title);

    svg.append(path);
    currentAngle = endAngle;
  });

  const centerText = document.createElementNS(ns, "text");
  centerText.setAttribute("x", String(cx));
  centerText.setAttribute("y", String(cy + 4));
  centerText.setAttribute("text-anchor", "middle");
  centerText.setAttribute("class", "pie-center-label");
  centerText.textContent = "100%";
  svg.append(centerText);
}

function renderBudget(budget) {
  renderBudgetPie(budget.items, budget.currency);
  const max = Math.max(...budget.items.map((item) => item.percent));
  document.getElementById("budget-meta").textContent =
    `Budget tier: ${budget.tier}. Categories you prioritized are marked; a contingency reserve covers surprises.`;
  document.querySelector("#budget-table tbody").replaceChildren(
    ...budget.items.map((item) =>
      el("tr", {}, [
        el("th", { scope: "row" }, [item.label, item.prioritized ? el("span", { className: "tag", text: "priority" }) : null]),
        el("td", {}, el("div", { className: "bar" }, [
          el("span", { style: { width: `${(item.percent / max) * 6}rem` }, "aria-hidden": "true" }),
          `${item.percent}%`,
        ])),
        el("td", { className: "num", text: formatMoney(item.amount, budget.currency) }),
      ]),
    ),
  );
}

function renderTimeline(timeline) {
  document.getElementById("timeline-meta").textContent = timeline.compressed
    ? `Compressed schedule: ${timeline.leadDays} days available versus about ${timeline.idealLeadDays} ideally.`
    : `${timeline.leadDays} days of planning time — you're on a comfortable schedule.`;

  const phases = new Map();
  for (const task of timeline.tasks) {
    if (!phases.has(task.phase)) phases.set(task.phase, []);
    phases.get(task.phase).push(task);
  }
  document.getElementById("timeline").replaceChildren(
    ...[...phases].map(([phase, tasks]) =>
      el("div", { className: "phase" }, [
        el("h4", { text: phase }),
        el("ul", { className: "tasks" }, tasks.map((task) =>
          el("li", {}, [
            el("time", { datetime: task.dueDate, text: formatDate(task.dueDate) }),
            el("span", {}, [task.title, task.urgent ? el("span", { className: "urgent", text: " — do this week" }) : null]),
          ]),
        )),
      ]),
    ),
  );
}

function renderVendors(vendors, planKey) {
  const storageKey = `vendors:${planKey}`;
  const done = store.get(storageKey);
  const progress = document.getElementById("vendor-progress");

  const updateProgress = () => {
    const count = vendors.filter((vendor) => done[vendor.id]).length;
    progress.textContent = `${count} of ${vendors.length} booked.`;
  };

  const loc = currentPlan?.summary?.location;
  const isMicro = (currentPlan?.summary?.guestCount ?? 100) <= 50;

  document.getElementById("vendors").replaceChildren(
    ...vendors.map((vendor) => {
      const id = `vendor-${vendor.id}`;
      const checkbox = el("input", { type: "checkbox", id, "aria-describedby": `${id}-tip` });
      checkbox.checked = Boolean(done[vendor.id]);

      let mapSearchLink = null;
      if (loc && (vendor.category === "venue" || vendor.id === "venue" || vendor.category === "catering" || vendor.id === "caterer")) {
        const isVenue = vendor.category === "venue" || vendor.id === "venue";
        const queryTerm = isVenue
          ? (isMicro ? `private dining restaurants in ${loc}` : `event venues in ${loc}`)
          : `catering services in ${loc}`;
        const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(queryTerm)}`;
        const linkLabel = isVenue
          ? (isMicro ? `Find private dining in ${loc} on Google Maps` : `Find venues in ${loc} on Google Maps`)
          : `Find caterers in ${loc} on Google Maps`;

        mapSearchLink = el(
          "p",
          { className: "vendor-map-wrap" },
          el(
            "a",
            {
              href: mapUrl,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "vendor-map-link",
              "aria-label": `${linkLabel} (opens in new tab)`,
            },
            [
              el("span", { "aria-hidden": "true" }, "📍 "),
              linkLabel,
              el("span", { "aria-hidden": "true" }, " ↗"),
            ],
          ),
        );
      }

      const item = el("li", { className: `vendor${checkbox.checked ? " done" : ""}` }, [
        el("label", { for: id }, [
          checkbox,
          vendor.name,
          el("span", { className: `tag priority-${vendor.priority}`, text: vendor.priority }),
        ]),
        el("p", { className: "hint", id: `${id}-tip` }, [
          vendor.bookNow ? el("strong", { className: "urgent", text: "Book now. " }) : `Book by ${formatDate(vendor.bookBy)}. `,
          vendor.tip,
        ]),
        mapSearchLink,
      ]);
      checkbox.addEventListener("change", () => {
        done[vendor.id] = checkbox.checked;
        item.classList.toggle("done", checkbox.checked);
        store.set(storageKey, done);
        updateProgress();
      });
      return item;
    }),
  );
  updateProgress();
}

function renderIdeas({ source, notice, ideas }) {
  document.getElementById("ideas-meta").textContent =
    notice ?? (source === "ai" ? "Generated by AI from your event details — adapt freely." : "Curated ideas for this type of event.");

  const list = (title, items) =>
    el("div", {}, [el("h4", { text: title }), el("ul", {}, items.map((text) => el("li", { text })))]);

  document.getElementById("ideas").replaceChildren(
    el("div", { className: "themes" }, ideas.themes.map((theme) =>
      el("div", { className: "theme" }, [el("strong", { text: theme.name }), el("span", { text: theme.description })]),
    )),
    el("div", { className: "idea-grid" }, [
      list("Decor", ideas.decor),
      list("Food & drink", ideas.food),
      list("Activities", ideas.activities),
      list("Budget tips", ideas.budgetTips),
    ]),
    el("p", { className: "personal", text: ideas.personalTouch }),
  );
}

function renderPlan(plan, planKey) {
  currentPlan = plan;
  renderSummary(plan);
  renderInsights(plan.insights);
  renderBudget(plan.budget);
  renderTimeline(plan.timeline);
  renderVendors(plan.vendors, planKey);
  renderIdeas(plan.ideas);
  renderQuestions(plan.questions);
  if (plan.agentBrief) {
    renderAgentBrief(plan.agentBrief);
  } else {
    const briefCard = document.getElementById("agent-brief-display");
    if (briefCard) briefCard.hidden = true;
  }
  const explanationPanel = document.getElementById("plan-explanation");
  if (explanationPanel && !explanationPanel.hidden) {
    renderExplanation(plan);
  }
}

// ---- Export ---------------------------------------------------------------

/** The plan as readable plain text, so it can be shared with co-hosts or kept offline. */
function planToText(plan) {
  const { summary, budget, timeline, vendors, insights, ideas } = plan;
  const money = (amount) => formatMoney(amount, budget.currency);
  const lines = [
    `${summary.eventName}`,
    "=".repeat(summary.eventName.length),
    `${summary.eventLabel} on ${formatDate(summary.date)} (${summary.daysToGo} days to go)`,
    `${summary.guestCount} guests, ${summary.setting}${summary.location ? `, in ${summary.location}` : ""}, budget ${money(budget.total)} (${money(budget.perGuest)} per guest, ${budget.tier})`,
    "",
  ];
  if (insights.length) {
    lines.push("THINGS TO KNOW");
    for (const insight of insights) lines.push(`- [${insight.level}] ${insight.title}: ${insight.detail}`);
    lines.push("");
  }
  lines.push("BUDGET BREAKDOWN");
  for (const item of budget.items) lines.push(`- ${item.label}${item.prioritized ? " (priority)" : ""}: ${money(item.amount)} (${item.percent}%)`);
  lines.push("", "TIMELINE");
  let phase = null;
  for (const task of timeline.tasks) {
    if (task.phase !== phase) {
      phase = task.phase;
      lines.push(`${phase}:`);
    }
    lines.push(`- ${formatDate(task.dueDate)}: ${task.title}${task.urgent ? " (this week)" : ""}`);
  }
  lines.push("", "VENDOR CHECKLIST");
  for (const vendor of vendors) {
    lines.push(`[ ] ${vendor.name} (${vendor.priority}) - ${vendor.bookNow ? "book now" : `book by ${formatDate(vendor.bookBy)}`}. ${vendor.tip}`);
  }
  lines.push("", `IDEAS (${ideas.source === "ai" ? "AI-personalized" : "curated"})`);
  for (const theme of ideas.ideas.themes) lines.push(`- Theme: ${theme.name} - ${theme.description}`);
  for (const [title, items] of [["Decor", ideas.ideas.decor], ["Food & drink", ideas.ideas.food], ["Activities", ideas.ideas.activities], ["Budget tips", ideas.ideas.budgetTips]]) {
    lines.push(`${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  }
  lines.push(
    "",
    "CONTRACT DEFENSE & NEGOTIATION CHECKLIST",
    "- Venue: Confirm if 20-25% service fee includes staff tips, and verify teardown overtime rates ($250-$1,000/hr).",
    "- Venue: Check 'broom-clean' clauses and off-site trash disposal obligations before signing.",
    "- Catering & Bar: Clarify tip-jar policies, bartender-to-guest ratios (1:50 recommended), and surplus bottle returns.",
    "- Photography: Ensure lead photographer is explicitly named with un-watermarked high-res rights.",
  );
  if (plan.questions && plan.questions.length) {
    lines.push("", "STRATEGIC DISCOVERY QUESTIONS");
    for (const q of plan.questions) {
      lines.push(`- [${q.category}] ${q.question}`);
      lines.push(`  Tip: ${q.tip}`);
    }
  }

  if (plan.agentBrief) {
    lines.push("", "AI AGENT STRATEGY BRIEF");
    if (plan.agentBrief.foodAndBeverage) lines.push(`- Food & Beverage: ${plan.agentBrief.foodAndBeverage}`);
    if (plan.agentBrief.vibeAndDecor) lines.push(`- Vibe & Decor: ${plan.agentBrief.vibeAndDecor}`);
    if (plan.agentBrief.timelineAndFlow) lines.push(`- Timeline & Flow: ${plan.agentBrief.timelineAndFlow}`);
    if (plan.agentBrief.negotiationStrategy) lines.push(`- Contract Defense: ${plan.agentBrief.negotiationStrategy}`);
    if (plan.agentBrief.actionItems && plan.agentBrief.actionItems.length) {
      lines.push("Action Items:");
      for (const item of plan.agentBrief.actionItems) lines.push(`  * ${item}`);
    }
  }

  lines.push("", ideas.ideas.personalTouch, "", "Estimates are guidance only. Confirm prices, permits and requirements locally.");
  return lines.join("\n");
}

function downloadPlan() {
  if (!currentPlan) return;
  const name = currentPlan.summary.eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event-plan";
  const blob = new Blob([planToText(currentPlan)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${name}.txt` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Your plan was downloaded as a text file.");
}

function planToMarkdown(plan) {
  const { summary, budget, timeline, vendors, insights, ideas } = plan;
  const money = (amount) => formatMoney(amount, budget.currency);
  const lines = [
    `# ${summary.eventName}`,
    "",
    `> **Event Planning Plan** generated by Plan Together AI on ${formatDate(todayIso())}`,
    "",
    "## 📋 Event Overview",
    "",
    "| Metric | Details |",
    "| :--- | :--- |",
    `| **Event Type** | ${summary.eventLabel} |`,
    `| **Event Date** | ${formatDate(summary.date)} (${summary.daysToGo} days to go) |`,
    `| **Guest Count** | ${summary.guestCount} guests |`,
    `| **Setting** | ${summary.setting.charAt(0).toUpperCase() + summary.setting.slice(1)} |`,
    summary.location ? `| **Location** | ${summary.location} |` : null,
    `| **Total Budget** | ${money(budget.total)} (${money(budget.perGuest)} per guest) |`,
    `| **Budget Tier** | ${budget.tier.toUpperCase()} |`,
    "",
  ].filter(Boolean);

  if (insights && insights.length) {
    lines.push("## 💡 Things to Know", "");
    for (const insight of insights) {
      lines.push(`- **[${insight.level.toUpperCase()}] ${insight.title}:** ${insight.detail}`);
    }
    lines.push("");
  }

  lines.push("## 💰 Budget Breakdown", "");
  lines.push("| Category | Allocation | Amount | Prioritized |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const item of budget.items) {
    lines.push(`| ${item.label} | ${item.percent}% | ${money(item.amount)} | ${item.prioritized ? "Yes" : "No"} |`);
  }
  lines.push("");

  lines.push("## 🗓️ Timeline & Milestones", "");
  lines.push("| Due Date | Phase | Task | Status |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const task of timeline.tasks) {
    lines.push(`| ${formatDate(task.dueDate)} | ${task.phase} | ${task.title} | ${task.urgent ? "⚠️ Urgent" : "Upcoming"} |`);
  }
  lines.push("");

  lines.push("## ✅ Vendor Checklist", "");
  const loc = summary.location;
  const isMicro = summary.guestCount <= 50;
  for (const vendor of vendors) {
    let mapUrlInfo = "";
    if (loc && (vendor.category === "venue" || vendor.id === "venue")) {
      const q = isMicro ? `private dining restaurants in ${loc}` : `event venues in ${loc}`;
      mapUrlInfo = ` ([Search on Google Maps](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}))`;
    } else if (loc && (vendor.category === "catering" || vendor.id === "caterer")) {
      const q = `catering services in ${loc}`;
      mapUrlInfo = ` ([Search on Google Maps](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}))`;
    }
    lines.push(`- [ ] **${vendor.name}** (${vendor.priority}) — ${vendor.bookNow ? "Book immediately" : `Book by ${formatDate(vendor.bookBy)}`}${mapUrlInfo}`);
    lines.push(`  - *Tip:* ${vendor.tip}`);
  }
  lines.push("");

  if (ideas && ideas.ideas) {
    lines.push("## 🎨 Creative Ideas & Concepts", "");
    if (ideas.ideas.themes && ideas.ideas.themes.length) {
      lines.push("### Themes", "");
      for (const theme of ideas.ideas.themes) {
        lines.push(`- **${theme.name}:** ${theme.description}`);
      }
      lines.push("");
    }

    const sections = [
      ["Decor & Atmosphere", ideas.ideas.decor],
      ["Food & Beverage", ideas.ideas.food],
      ["Activities & Experience", ideas.ideas.activities],
      ["Budget Tips", ideas.ideas.budgetTips],
    ];
    for (const [title, items] of sections) {
      if (items && items.length) {
        lines.push(`### ${title}`, "");
        for (const item of items) {
          lines.push(`- ${item}`);
        }
        lines.push("");
      }
    }
    if (ideas.ideas.personalTouch) {
      lines.push(`> *${ideas.ideas.personalTouch}*`, "");
    }
  }

  if (plan.questions && plan.questions.length) {
    lines.push("## 📋 Strategic Discovery Questions", "");
    for (const q of plan.questions) {
      lines.push(`- **[${q.category}]** ${q.question}`);
      lines.push(`  - *Strategy Tip:* ${q.tip}`);
    }
    lines.push("");
  }

  if (plan.agentBrief) {
    lines.push("## ⭐ AI Agent Strategy Brief", "");
    if (plan.agentBrief.foodAndBeverage) lines.push(`### Food & Beverage Architecture\n${plan.agentBrief.foodAndBeverage}\n`);
    if (plan.agentBrief.vibeAndDecor) lines.push(`### Vibe & Aesthetic Styling\n${plan.agentBrief.vibeAndDecor}\n`);
    if (plan.agentBrief.timelineAndFlow) lines.push(`### Run-of-Show & Flow\n${plan.agentBrief.timelineAndFlow}\n`);
    if (plan.agentBrief.negotiationStrategy) lines.push(`### Contract Defense & Negotiation\n${plan.agentBrief.negotiationStrategy}\n`);
    if (plan.agentBrief.actionItems && plan.agentBrief.actionItems.length) {
      lines.push("### Tactical Action Items");
      for (const item of plan.agentBrief.actionItems) lines.push(`- [ ] ${item}`);
      lines.push("");
    }
  }

  lines.push(
    "## 🛡️ Contract Defense & Negotiation Checklist",
    "",
    "- [ ] **Service Fee vs. Gratuity:** Confirm in writing whether the 20–25% mandatory service fee is distributed directly to hourly staff as tips or kept by the house.",
    "- [ ] **Teardown & Overtime Rates:** Verify strict minute-by-minute breakdown windows. Overtime rates typically run $250–$1,000/hr for 15-minute overages.",
    '- [ ] **Cleanup & Trash Removal:** Clarify if "broom-clean" clauses require hauling trash off-site, and identify who handles clearing.',
    "- [ ] **Bar Ratios & Alcohol Return:** Contract at least 1 bartender per 50 guests; verify unopened host-provided alcohol is returned.",
    "- [ ] **Photography Rights:** Ensure lead photographer is explicitly named in the contract with un-watermarked high-resolution reproduction rights.",
    "",
    "---",
    "*Estimates and benchmarks are for guidance only. Confirm prices, permits, and contract clauses with local authorities and vendors.*",
  );

  return lines.join("\n");
}

function downloadMarkdown() {
  if (!currentPlan) return;
  const name = currentPlan.summary.eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event-plan";
  const blob = new Blob([planToMarkdown(currentPlan)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${name}.md` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Your plan was downloaded as a Markdown file.");
}

function downloadJson() {
  if (!currentPlan) return;
  const name = currentPlan.summary.eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event-plan";
  const exportPayload = {
    app: "Plan Together AI",
    version: "1.0.0",
    exportedAt: new Date().toISOString(),
    plan: currentPlan,
  };
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `${name}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Your plan was downloaded as a JSON file.");
}

function changeConstraints() {
  const formCard = document.getElementById("form-card");
  const formHeading = document.getElementById("form-heading");
  if (!formCard || !formHeading) return;

  const prefersReducedMotion =
    (window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false) ||
    document.documentElement.dataset.motion === "reduce";

  if (typeof formCard.scrollIntoView === "function") {
    formCard.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  }

  formHeading.focus({ preventScroll: true });
  setStatus("You can now adjust your constraints in the form above and create an updated plan.");
}

function generatePlanExplanation(plan) {
  const { summary, budget, timeline } = plan;
  const isMicro = summary.guestCount <= 50;
  const prioritizedItems = budget.items.filter((i) => i.prioritized).map((i) => i.label);
  const contingency = budget.items.find((i) => i.key === "contingency");

  const cards = [];

  cards.push({
    title: "💰 Budget Architecture & Tier Rationale",
    badge: `${budget.tier.toUpperCase()} TIER`,
    badgeClass: `badge-${budget.tier}`,
    points: [
      `At ${formatMoney(budget.perGuest, budget.currency)} per guest (${formatMoney(budget.total, budget.currency)} total for ${summary.guestCount} guests), your plan is structured in the ${budget.tier} tier for ${summary.eventLabel.toLowerCase()}s.`,
      prioritizedItems.length
        ? `Budget was intentionally weighted toward your top priorities: ${prioritizedItems.join(", ")}.`
        : `Allocations follow standard benchmark splits with the highest investment allocated to ${budget.items[0]?.label || "Venue"} (${budget.items[0]?.percent || 0}%).`,
      contingency
        ? `A ${contingency.percent}% contingency reserve (${formatMoney(contingency.amount, budget.currency)}) is locked to protect against vendor administrative surcharges and unexpected guest additions.`
        : "Maintain a 5–10% reserve for unforeseen vendor fees.",
    ],
  });

  cards.push({
    title: "🗓️ Timeline & Scheduling Critical Path",
    badge: timeline.compressed ? "COMPRESSED" : "COMFORTABLE",
    badgeClass: timeline.compressed ? "badge-warning" : "badge-info",
    points: [
      timeline.compressed
        ? `With ${timeline.leadDays} days until your event (typical ideal lead time is ${timeline.idealLeadDays} days), deadlines have been mathematically compressed to ensure vendor availability.`
        : `With ${timeline.leadDays} days of planning runway, you are on a comfortable schedule allowing thorough vendor vetting and tastings.`,
      "The critical path priority is locking your venue and core catering immediately, as premium dates book 6–12 months in advance.",
      "Final RSVP cutoffs should strictly be set 3–4 weeks prior to provide accurate headcount guarantees to your caterer.",
    ],
  });

  cards.push({
    title: "📍 Venue & Operational Strategy",
    badge: isMicro ? "MICRO-EVENT STRATEGY" : "STANDARD VENUE STRATEGY",
    badgeClass: "badge-accent",
    points: [
      isMicro
        ? "For intimate gatherings under 50 guests, booking a private dining room at a vetted restaurant eliminates venue rental fees, separate table/chair rentals, and outside staffing minimums."
        : `With ${summary.guestCount} guests, a dedicated event space or banquet hall is essential to ensure adequate square footage, proper audio staging, and guest circulation.`,
      summary.setting === "outdoor"
        ? "Outdoor setting alert: Ensure tenting contracts include mandatory side-wall provisions and verify noise ordinances and municipal park permits."
        : summary.setting === "hybrid"
          ? "Hybrid setting: Have a predefined 24-hour weather call time with your coordinator and caterer to seamlessly transition indoors if needed."
          : "Indoor setting: Eliminates weather vulnerabilities and reduces heating/cooling rental line items.",
    ],
  });

  cards.push({
    title: "🛡️ Contract Defense & Risk Controls",
    badge: "COST CONTROL",
    badgeClass: "badge-critical",
    points: [
      "Always verify whether the standard 20–25% venue/catering service charge is distributed to hourly servers as gratuity or retained as house overhead.",
      "Mandate a 90-minute breakdown window in your venue contract to prevent punitive overtime charges ($250–$1,000/hr billed in 15-minute increments).",
      "Contract for 1 bartender per 50 guests plus dedicated bar-backs to prevent drink bottlenecks during cocktail hours.",
    ],
  });

  return cards;
}

function renderExplanation(plan) {
  const container = document.getElementById("explanation-content");
  if (!container) return;
  const cards = generatePlanExplanation(plan);
  container.replaceChildren(
    ...cards.map((c) =>
      el("div", { className: "explanation-card-item" }, [
        el("div", { className: "explanation-card-head" }, [
          el("h4", { text: c.title }),
          el("span", { className: `tag ${c.badgeClass}`, text: c.badge }),
        ]),
        el("ul", { className: "explanation-points" }, c.points.map((pt) => el("li", { text: pt }))),
      ]),
    ),
  );
}

function togglePlanExplanation() {
  const panel = document.getElementById("plan-explanation");
  const btn = document.getElementById("explain-plan-btn");
  if (!panel || !btn || !currentPlan) return;

  const willShow = panel.hidden;
  panel.hidden = !willShow;
  btn.setAttribute("aria-expanded", String(willShow));
  btn.textContent = willShow ? "💡 Hide explanation" : "💡 Explain this plan";

  if (willShow) {
    renderExplanation(currentPlan);
    const heading = document.getElementById("explanation-heading");
    if (heading) heading.focus();
  }
}

function closePlanExplanation() {
  const panel = document.getElementById("plan-explanation");
  const btn = document.getElementById("explain-plan-btn");
  if (!panel) return;
  panel.hidden = true;
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "💡 Explain this plan";
    btn.focus();
  }
}


// ---- Geolocation ----------------------------------------------------------


function renderQuestions(questions) {
  const container = document.getElementById("questions-list");
  if (!container) return;
  const list = questions && questions.length ? questions : [
    { category: "Food & Beverage", question: "What are the audience food tastes, dietary needs (vegan, halal, allergies), and bar preferences?", tip: "Confirm whether you need plated dinners, buffet stations, or cocktail-style passed hors d'oeuvres." },
    { category: "Vibe & Atmosphere", question: "What specific musical style, lighting mood, and dress code fit your vision?", tip: "Warm dimmable bistro lights and pin-spots for tables elevate perceived value affordably." },
    { category: "Audience & Access", question: "Are there children, elderly family members, or guests with mobility or sensory needs?", tip: "Confirm step-free routes and designate a quiet recharge lounge away from loud speakers." },
    { category: "Budget Levers", question: "What is your single non-negotiable highlight element to prioritize?", tip: "Invest in signature guest experiences and save on standard tablecloths and paper goods." },
  ];

  container.replaceChildren(
    ...list.map((q) =>
      el("div", { className: "question-card" }, [
        el("div", { className: "question-card-head" }, [
          el("span", { className: "question-card-title", text: q.category }),
        ]),
        el("p", { className: "question-text", text: q.question }),
        el("p", { className: "question-tip", text: `💡 ${q.tip}` }),
      ]),
    ),
  );
}

function generateAgentPrompt(plan) {
  const { summary, budget } = plan;
  const isMicro = summary.guestCount <= 50;

  return `You are an elite event planning strategist and hospitality consultant.
I need your expert answers to refine an event plan generated by Plan Together AI.

--- EVENT SPECIFICATIONS ---
- Event Name: ${summary.eventName} (${summary.eventLabel})
- Date: ${summary.date} (${summary.daysToGo} days to go)
- Location: ${summary.location || "Local city/region"}
- Guests: ${summary.guestCount} attendees (${isMicro ? "Intimate micro-event" : "Standard venue event"})
- Setting: ${summary.setting}
- Total Budget: ${formatMoney(budget.total, budget.currency)} (${budget.tier.toUpperCase()} tier, ${formatMoney(budget.perGuest, budget.currency)}/guest)
- Top Priorities: ${budget.items.filter((i) => i.prioritized).map((i) => i.label).join(", ") || "Standard balanced"}

--- DISCOVERY QUESTIONS TO ANSWER ---
1. AUDIENCE FOOD & BEVERAGE TASTE:
   - What specific seasonal regional menu format, signature drinks, and dietary architectures (vegan, halal, GF) should be served?
2. VIBE & DECOR SPECIFICS:
   - What lighting schemes, acoustic design, color palette, and micro-touches will elevate the ambiance?
3. TIMELINE & RUN OF SHOW:
   - What minute-by-minute flow prevents guest fatigue and queue bottlenecks?
4. VENDOR NEGOTIATION & CONTRACT DEFENSE:
   - What clauses should be added to protect deposits, verify service charges vs tips, and eliminate hidden overtime?

--- REQUIRED OUTPUT FORMAT ---
Please reply with valid JSON (or clean markdown matching these keys) so it can be parsed back into the event planning software:
{
  "foodAndBeverage": "Detailed culinary & drink strategy tailored to ${summary.guestCount} guests in ${summary.location || "this location"}",
  "vibeAndDecor": "Atmosphere, decor palette, and sensory styling",
  "timelineAndFlow": "Run-of-show choreography and queue prevention",
  "negotiationStrategy": "Specific contract defense tactics and fee protection",
  "actionItems": [
    "Immediate action step 1",
    "Immediate action step 2",
    "Immediate action step 3"
  ]
}`;
}

async function copyAgentPrompt() {
  if (!currentPlan) return;
  const promptText = generateAgentPrompt(currentPlan);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(promptText);
    } else {
      const textarea = el("textarea", { value: promptText, style: { position: "fixed", opacity: "0" } });
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setStatus("Agent prompt copied to clipboard! Paste it into your AI assistant.");
  } catch {
    setStatus("Could not copy automatically. Please copy the prompt manually.", true);
  }
}

function toggleAgentParser() {
  const panel = document.getElementById("agent-parser-panel");
  const btn = document.getElementById("toggle-agent-parser-btn");
  if (!panel || !btn) return;
  const willShow = panel.hidden;
  panel.hidden = !willShow;
  btn.setAttribute("aria-expanded", String(willShow));
  btn.textContent = willShow ? "✕ Close Import" : "📥 Import Agent Answers";
  if (willShow) {
    const textarea = document.getElementById("agent-response-input");
    if (textarea) textarea.focus();
  }
}

function parseAgentResponse(rawText) {
  if (!rawText || !rawText.trim()) throw new Error("Please paste your agent response text.");

  const trimmed = rawText.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, trimmed];
  const candidateJson = jsonMatch[1] || trimmed;

  try {
    const data = JSON.parse(candidateJson);
    if (typeof data === "object" && data !== null) {
      return {
        foodAndBeverage: data.foodAndBeverage || data.food || data.catering || "",
        vibeAndDecor: data.vibeAndDecor || data.vibe || data.decor || "",
        timelineAndFlow: data.timelineAndFlow || data.timeline || data.flow || "",
        negotiationStrategy: data.negotiationStrategy || data.negotiation || data.contracts || "",
        actionItems: Array.isArray(data.actionItems) ? data.actionItems : (data.actionItems ? [data.actionItems] : []),
      };
    }
  } catch {
    // Fall back to heading parser
  }

  const extractSection = (keywords) => {
    const regex = new RegExp(`(?:#+|\\*\\*|\\b)(?:${keywords})(?:\\*\\*|:)?\\s*([\\s\\S]*?)(?=(?:#+|\\*\\*|\\b)(?:food|vibe|decor|timeline|negotiat|action|contract)|$)`, "i");
    const match = trimmed.match(regex);
    return match ? match[1].trim() : "";
  };

  const foodAndBeverage = extractSection("food(?:\\s*&\\s*beverage)?|culinary|catering");
  const vibeAndDecor = extractSection("vibe(?:\\s*&\\s*decor)?|decor|atmosphere|aesthetic");
  const timelineAndFlow = extractSection("timeline(?:\\s*&\\s*flow)?|schedule|run of show");
  const negotiationStrategy = extractSection("negotiat(?:ion)?|contract(?:s)?|defense");

  const actionItems = [];
  const lines = trimmed.split("\n");
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bulletMatch && actionItems.length < 5) {
      actionItems.push(bulletMatch[1].trim());
    }
  }

  if (!foodAndBeverage && !vibeAndDecor && !timelineAndFlow && !negotiationStrategy && actionItems.length === 0) {
    return {
      foodAndBeverage: trimmed.slice(0, 400),
      vibeAndDecor: "",
      timelineAndFlow: "",
      negotiationStrategy: "",
      actionItems: [],
    };
  }

  return { foodAndBeverage, vibeAndDecor, timelineAndFlow, negotiationStrategy, actionItems };
}

function renderAgentBrief(brief) {
  const card = document.getElementById("agent-brief-display");
  const body = document.getElementById("agent-brief-body");
  if (!card || !body) return;

  const sections = [
    ["🍽️ Audience Food & Beverage Strategy", brief.foodAndBeverage],
    ["✨ Vibe, Decor & Atmosphere", brief.vibeAndDecor],
    ["⏱️ Timeline & Flow", brief.timelineAndFlow],
    ["🛡️ Contract Defense & Negotiation", brief.negotiationStrategy],
  ];

  const items = [];
  for (const [title, content] of sections) {
    if (content) {
      items.push(el("div", { className: "agent-brief-item" }, [
        el("h5", { text: title }),
        el("p", { text: content }),
      ]));
    }
  }

  if (brief.actionItems && brief.actionItems.length) {
    items.push(el("div", { className: "agent-brief-item" }, [
      el("h5", { text: "📌 Tactical Action Items" }),
      el("ul", {}, brief.actionItems.map((item) => el("li", { text: item }))),
    ]));
  }

  body.replaceChildren(...items);
  card.hidden = items.length === 0;
}

function applyAgentAnswers() {
  const input = document.getElementById("agent-response-input");
  const errEl = document.getElementById("parser-error");
  if (!input) return;

  try {
    if (errEl) errEl.hidden = true;
    const parsed = parseAgentResponse(input.value);
    if (!currentPlan) return;
    currentPlan.agentBrief = parsed;
    renderAgentBrief(parsed);
    toggleAgentParser();
    input.value = "";
    setStatus("Agent answers parsed and applied to your plan!");
  } catch (err) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = err.message || "Could not parse response.";
    }
  }
}

function initGeolocation() {
  const geoBtn = document.getElementById("geo-btn");
  const geoStatus = document.getElementById("geo-status");
  if (!geoBtn) return;

  function setGeoStatus(msg, isError = false) {
    if (!geoStatus) return;
    geoStatus.hidden = !msg;
    geoStatus.textContent = msg;
    geoStatus.classList.toggle("error", isError);
  }

  function requestLocation(isInteractive = true) {
    if (!navigator.geolocation) {
      if (isInteractive) setGeoStatus("Geolocation is not supported by your browser.", true);
      return;
    }
    setGeoStatus(isInteractive ? "Detecting your location..." : "Locating your city...");
    geoBtn.setAttribute("aria-disabled", "true");

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(`/api/geocode?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`);
          if (!res.ok) throw new Error("Could not look up your location.");
          const data = await res.json();
          if (data.location) {
            fields.location.value = data.location;
            setGeoStatus(`Location set to ${data.location}.`);
            if (isInteractive) fields.location.focus();
          } else {
            throw new Error("No location found.");
          }
        } catch (err) {
          if (isInteractive) setGeoStatus(err.message || "Failed to detect location.", true);
        } finally {
          geoBtn.removeAttribute("aria-disabled");
        }
      },
      (err) => {
        geoBtn.removeAttribute("aria-disabled");
        if (isInteractive) {
          let msg = "Could not determine your location.";
          if (err.code === 1) {
            msg = "Location permission denied (blocked in browser). Click the lock or tune icon in your address bar to allow it, or type your city directly below.";
          } else if (err.code === 2) {
            msg = "Location unavailable. Please type your city directly below.";
          } else if (err.code === 3) {
            msg = "Location request timed out. Please try again or type your city directly below.";
          }
          setGeoStatus(msg, true);
          fields.location.focus();
        } else {
          setGeoStatus("");
        }
      },
      { timeout: 10_000, maximumAge: 300_000 },
    );
  }

  geoBtn.addEventListener("click", () => requestLocation(true));

  // Automatically request location permission on load if not already set
  if (!fields.location.value && navigator.geolocation) {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then((status) => {
        if (status.state === "granted" || status.state === "prompt") {
          requestLocation(false);
        }
      }).catch(() => {
        requestLocation(false);
      });
    } else {
      requestLocation(false);
    }
  }
}

// ---- Landing Page CTA & Accessible Smooth Scroll -------------------------

function initHeroCta() {
  const ctaBtn = document.getElementById("start-planning-cta");
  const formCard = document.getElementById("form-card");
  const formHeading = document.getElementById("form-heading");

  if (!ctaBtn || !formCard || !formHeading) return;

  ctaBtn.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();

    const prefersReducedMotion =
      (window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false) ||
      document.documentElement.dataset.motion === "reduce";

    const shiftFocusToForm = () => {
      formHeading.focus({ preventScroll: true });
      if (window.history && window.history.pushState) {
        window.history.pushState(null, "", "#form-card");
      }
    };

    if (prefersReducedMotion) {
      if (typeof formCard.scrollIntoView === "function") {
        formCard.scrollIntoView({ behavior: "auto", block: "start" });
      }
      shiftFocusToForm();
    } else {
      if (typeof formCard.scrollIntoView === "function") {
        formCard.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      let called = false;
      const onEnd = () => {
        if (called) return;
        called = true;
        window.removeEventListener("scrollend", onEnd);
        shiftFocusToForm();
      };
      if ("onscrollend" in window) {
        window.addEventListener("scrollend", onEnd, { once: true });
      }
      setTimeout(onEnd, 150);
    }
  });
}

// ---- Theme ----------------------------------------------------------------

const THEMES = ["system", "light", "dark"];

/** Applies a theme choice; "system" removes the override so the OS setting applies. */
function setTheme(theme) {
  if (!THEMES.includes(theme)) theme = "system";
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch { /* storage unavailable: the choice lasts for this page only */ }
}

function initThemeSwitch() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch { /* ignore */ }
  const current = (THEMES.includes(saved) ? saved : null) || document.documentElement.dataset.theme || "system";
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.checked = radio.value === current;
    radio.addEventListener("change", () => setTheme(radio.value));
  }
}

// ---- Accessibility Preferences ---------------------------------------------

const TEXT_SIZES = ["normal", "large"];
const CONTRAST_MODES = ["normal", "high"];
const MOTION_MODES = ["system", "reduce"];

/** Applies font size preference; "normal" removes the override. */
function setTextSize(size) {
  if (!TEXT_SIZES.includes(size)) size = "normal";
  if (size === "large") document.documentElement.dataset.textSize = "large";
  else delete document.documentElement.dataset.textSize;
  try {
    if (size === "large") localStorage.setItem("textSize", "large");
    else localStorage.removeItem("textSize");
  } catch { /* storage unavailable */ }
}

/** Applies contrast preference; "normal" removes the override. */
function setContrast(mode) {
  if (!CONTRAST_MODES.includes(mode)) mode = "normal";
  if (mode === "high") document.documentElement.dataset.contrast = "high";
  else delete document.documentElement.dataset.contrast;
  try {
    if (mode === "high") localStorage.setItem("contrast", "high");
    else localStorage.removeItem("contrast");
  } catch { /* storage unavailable */ }
}

/** Applies motion preference; "system" removes the override. */
function setMotion(mode) {
  if (mode === "reduced") mode = "reduce";
  if (!MOTION_MODES.includes(mode)) mode = "system";
  if (mode === "reduce") document.documentElement.dataset.motion = "reduce";
  else delete document.documentElement.dataset.motion;
  try {
    if (mode === "reduce") localStorage.setItem("motion", "reduce");
    else localStorage.removeItem("motion");
  } catch { /* storage unavailable */ }
}

function initA11yPreferences() {
  let savedTextSize = null;
  let savedContrast = null;
  let savedMotion = null;
  try {
    savedTextSize = localStorage.getItem("textSize");
    savedContrast = localStorage.getItem("contrast");
    savedMotion = localStorage.getItem("motion");
  } catch { /* ignore */ }

  const currentTextSize = (TEXT_SIZES.includes(savedTextSize) ? savedTextSize : null) || document.documentElement.dataset.textSize || "normal";
  for (const radio of document.querySelectorAll('input[name="textSize"]')) {
    radio.checked = radio.value === currentTextSize;
    radio.addEventListener("change", () => setTextSize(radio.value));
  }

  const currentContrast = (CONTRAST_MODES.includes(savedContrast) ? savedContrast : null) || document.documentElement.dataset.contrast || "normal";
  for (const radio of document.querySelectorAll('input[name="contrast"]')) {
    radio.checked = radio.value === currentContrast;
    radio.addEventListener("change", () => setContrast(radio.value));
  }

  const currentMotion = (MOTION_MODES.includes(savedMotion) ? savedMotion : null) || document.documentElement.dataset.motion || "system";
  for (const radio of document.querySelectorAll('input[name="motion"]')) {
    radio.checked = radio.value === currentMotion;
    radio.addEventListener("change", () => setMotion(radio.value));
  }

  window.addEventListener("storage", (event) => {
    if (event.key === "theme") {
      const val = THEMES.includes(event.newValue) ? event.newValue : "system";
      setTheme(val);
      for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === val;
    } else if (event.key === "textSize") {
      const val = TEXT_SIZES.includes(event.newValue) ? event.newValue : "normal";
      setTextSize(val);
      for (const r of document.querySelectorAll('input[name="textSize"]')) r.checked = r.value === val;
    } else if (event.key === "contrast") {
      const val = CONTRAST_MODES.includes(event.newValue) ? event.newValue : "normal";
      setContrast(val);
      for (const r of document.querySelectorAll('input[name="contrast"]')) r.checked = r.value === val;
    } else if (event.key === "motion") {
      const val = MOTION_MODES.includes(event.newValue) ? event.newValue : "system";
      setMotion(val);
      for (const r of document.querySelectorAll('input[name="motion"]')) r.checked = r.value === val;
    }
  });

  const panel = document.getElementById("a11y-panel");
  const toggle = document.getElementById("a11y-toggle");
  if (panel && toggle) {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.open) {
        panel.open = false;
        toggle.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (panel.open && !panel.contains(event.target)) {
        panel.open = false;
      }
    });
  }
}

// ---- Wire up --------------------------------------------------------------

fields.date.min = todayIso();
form.addEventListener("submit", onSubmit);
for (const radio of fields.eventType) radio.addEventListener("change", syncEventType);
notes.addEventListener("input", () => { notesCount.textContent = `${notes.value.length} / 500 characters`; });
document.getElementById("print-btn").addEventListener("click", () => window.print());
document.getElementById("download-btn").addEventListener("click", downloadPlan);

const changeConstraintsBtn = document.getElementById("change-constraints-btn");
if (changeConstraintsBtn) changeConstraintsBtn.addEventListener("click", changeConstraints);

const explainPlanBtn = document.getElementById("explain-plan-btn");
if (explainPlanBtn) explainPlanBtn.addEventListener("click", togglePlanExplanation);

const closeExplanationBtn = document.getElementById("close-explanation-btn");
if (closeExplanationBtn) closeExplanationBtn.addEventListener("click", closePlanExplanation);

const downloadMdBtn = document.getElementById("download-md-btn");
if (downloadMdBtn) downloadMdBtn.addEventListener("click", downloadMarkdown);

const downloadJsonBtn = document.getElementById("download-json-btn");
if (downloadJsonBtn) downloadJsonBtn.addEventListener("click", downloadJson);

const copyPromptBtn = document.getElementById("copy-agent-prompt-btn");
if (copyPromptBtn) copyPromptBtn.addEventListener("click", copyAgentPrompt);

const toggleParserBtn = document.getElementById("toggle-agent-parser-btn");
if (toggleParserBtn) toggleParserBtn.addEventListener("click", toggleAgentParser);

const cancelParserBtn = document.getElementById("cancel-parser-btn");
if (cancelParserBtn) cancelParserBtn.addEventListener("click", toggleAgentParser);

const applyAnswersBtn = document.getElementById("apply-agent-answers-btn");
if (applyAnswersBtn) applyAnswersBtn.addEventListener("click", applyAgentAnswers);
syncEventType();
initGeolocation();
initHeroCta();
initThemeSwitch();
initA11yPreferences();
