"use strict";

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
const ERROR_FIELDS = ["date", "guestCount", "budget", "honoreeAge"];

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

function formatMoney(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
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
}

function showFieldErrors(details) {
  let first = null;
  for (const { field, message } of details) {
    const target = document.getElementById(`${field}-error`);
    if (!target) continue;
    target.textContent = message;
    target.hidden = false;
    fields[field].setAttribute("aria-invalid", "true");
    first ??= fields[field];
  }
  first?.focus();
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
  return errors;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error-msg", isError);
}

async function onSubmit(event) {
  event.preventDefault();
  clearErrors();
  const payload = readForm();
  const localErrors = validateLocally(payload);
  if (localErrors.length) {
    setStatus("Please fix the highlighted fields.", true);
    showFieldErrors(localErrors);
    return;
  }

  submitBtn.disabled = true;
  results.setAttribute("aria-busy", "true");
  setStatus(payload.useAI ? "Creating your plan and personalized ideas…" : "Creating your plan…");

  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus(body.error ?? "Something went wrong. Please try again.", true);
      if (body.details) showFieldErrors(body.details);
      return;
    }
    renderPlan(body);
    setStatus("Your plan is ready.");
    results.hidden = false;
    document.getElementById("results-heading").focus();
  } catch {
    setStatus("Could not reach the server. Check your connection and try again.", true);
  } finally {
    submitBtn.disabled = false;
    results.removeAttribute("aria-busy");
  }
}

// ---- Rendering ------------------------------------------------------------

function renderSummary({ summary, budget }) {
  const stats = [
    ["Event", summary.eventName],
    ["Date", formatDate(summary.date)],
    ["Days to go", String(summary.daysToGo)],
    ["Guests", String(summary.guestCount)],
    ["Budget", formatMoney(budget.total, budget.currency)],
    ["Per guest", `${formatMoney(budget.perGuest, budget.currency)} (${budget.tier})`],
  ];
  document.getElementById("summary").replaceChildren(
    ...stats.map(([label, value]) => el("dl", { className: "stat" }, [el("dt", { text: label }), el("dd", { text: value })])),
  );
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

function renderBudget(budget) {
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

  document.getElementById("vendors").replaceChildren(
    ...vendors.map((vendor) => {
      const id = `vendor-${vendor.id}`;
      const checkbox = el("input", { type: "checkbox", id, "aria-describedby": `${id}-tip` });
      checkbox.checked = Boolean(done[vendor.id]);
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

function renderPlan(plan) {
  renderSummary(plan);
  renderInsights(plan.insights);
  renderBudget(plan.budget);
  renderTimeline(plan.timeline);
  renderVendors(plan.vendors, `${plan.summary.eventType}:${plan.summary.date}:${plan.summary.eventName}`);
  renderIdeas(plan.ideas);
}

// ---- Wire up --------------------------------------------------------------

fields.date.min = todayIso();
form.addEventListener("submit", onSubmit);
for (const radio of fields.eventType) radio.addEventListener("change", syncEventType);
notes.addEventListener("input", () => { notesCount.textContent = `${notes.value.length} / 500 characters`; });
document.getElementById("print-btn").addEventListener("click", () => window.print());
syncEventType();
