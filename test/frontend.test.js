// Loads the real page and app.js from the server into jsdom and drives the UI
// like a user would, including keyboard focus and screen-reader semantics.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import { createIdeasService } from "../src/ai/ideas.js";
import { RateLimiter } from "../src/lib/rateLimiter.js";

const XSS = '<img src=x onerror="window.pwned=true">';
const curated = createIdeasService({ client: null });
const ideasService = {
  enabled: true,
  async getIdeas(input, plan) {
    const { ideas } = await curated.getIdeas({ ...input, useAI: false }, plan);
    if (!input.useAI) return { source: "curated", ideas };
    return { source: "ai", ideas: { ...ideas, themes: [{ name: XSS, description: "Injected?" }], personalTouch: XSS } };
  },
};

let server;
let base;

before(async () => {
  server = createServer(createApp({ ideasService, rateLimiter: new RateLimiter({ limit: 1000 }), logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for UI");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Opens the app. jsdom has no fetch, so route the page's fetch to Node's.
 * `storage` seeds localStorage before any script runs (jsdom gives every
 * window its own storage, so this stands in for a returning visitor).
 */
async function openPage({ storage = {} } = {}) {
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Node's fetch can't take jsdom's AbortSignal; timeouts are covered by code review, not here.
      window.fetch = (url, { signal, ...options } = {}) => fetch(new URL(url, base), options);
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
    },
  });
  const { window } = dom;
  await waitFor(() => window.document.readyState === "complete");
  return window;
}

function futureDate(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Small page driver to keep tests readable. */
function driver(window) {
  const doc = window.document;
  const $ = (selector) => doc.querySelector(selector);
  return {
    doc,
    $,
    set(id, value) { doc.getElementById(id).value = value; },
    check(selector, checked = true) {
      const input = $(selector);
      input.checked = checked;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    submit() { $("#plan-form").requestSubmit(); },
    /** Submits and waits until the request settles (the button stops being busy). */
    async submitAndWait() {
      this.submit();
      await waitFor(() => $("#submit-btn").getAttribute("aria-disabled") !== "true");
    },
    text: (selector) => $(selector).textContent,
  };
}

describe("form behaviour", () => {
  test("birthday type reveals the age field and other types hide and clear it", async () => {
    const window = await openPage();
    const page = driver(window);
    assert.equal(page.$("#age-field").hidden, true);
    page.check('input[value="birthday"]');
    assert.equal(page.$("#age-field").hidden, false);
    page.set("honoreeAge", "30");
    page.check('input[value="community"]');
    assert.equal(page.$("#age-field").hidden, true);
    assert.equal(page.$("#honoreeAge").value, "");
    window.close();
  });

  test("the date picker cannot select past days", async () => {
    const window = await openPage();
    assert.match(window.document.getElementById("date").min, /^\d{4}-\d{2}-\d{2}$/);
    window.close();
  });

  test("notes counter tracks length", async () => {
    const window = await openPage();
    const notes = window.document.getElementById("notes");
    notes.value = "hello";
    notes.dispatchEvent(new window.Event("input"));
    assert.equal(window.document.getElementById("notes-count").textContent, "5 / 500 characters");
    window.close();
  });
});

describe("validation feedback", () => {
  test("client-side errors are marked, described and focused", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("guestCount", "0");
    page.set("budget", "10");
    page.submit();

    for (const id of ["date", "guestCount", "budget"]) {
      assert.equal(page.$(`#${id}`).getAttribute("aria-invalid"), "true", id);
      assert.equal(page.$(`#${id}-error`).hidden, false, id);
      assert.ok(page.$(`#${id}`).getAttribute("aria-describedby").includes(`${id}-error`), id);
    }
    const summary = page.$("#error-summary");
    assert.equal(summary.hidden, false);
    assert.equal(summary.getAttribute("role"), "alert");
    assert.equal(page.doc.activeElement.id, "error-summary", "the summary takes focus so every problem is announced");
    assert.deepEqual([...summary.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#date", "#guestCount", "#budget"]);
    assert.equal(page.text("#status"), "", "no second announcement of the same errors");
    window.close();
  });

  test("error summary links move focus to the matching field", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("guestCount", "0");
    page.submit();
    page.$('#error-summary a[href="#guestCount"]').click();
    assert.equal(page.doc.activeElement.id, "guestCount");
    window.close();
  });

  test("past dates and fractional guests are caught before sending", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", "2000-01-01");
    page.set("guestCount", "2.5");
    page.submit();
    assert.equal(page.text("#date-error"), "The event date cannot be in the past.");
    assert.match(page.text("#guestCount-error"), /whole number/);
    window.close();
  });

  test("invalid birthday ages are caught", async () => {
    const window = await openPage();
    const page = driver(window);
    page.check('input[value="birthday"]');
    page.set("date", futureDate(30));
    page.set("honoreeAge", "130");
    page.submit();
    assert.equal(page.$("#honoreeAge").getAttribute("aria-invalid"), "true");
    window.close();
  });

  test("fixing the fields clears previous errors", async () => {
    const window = await openPage();
    const page = driver(window);
    page.submit();
    assert.equal(page.$("#date-error").hidden, false);
    page.set("date", futureDate(30));
    await page.submitAndWait();
    assert.equal(page.$("#date-error").hidden, true);
    assert.equal(page.$("#date").hasAttribute("aria-invalid"), false);
    assert.equal(page.$("#error-summary").hidden, true);
    assert.equal(page.$("#error-list").children.length, 0);
    window.close();
  });

  test("server-side errors are shown on the matching field", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(30));
    page.set("budget", "999999999");
    await page.submitAndWait();
    assert.equal(page.$("#budget").getAttribute("aria-invalid"), "true");
    assert.equal(page.$("#budget-error").hidden, false);
    assert.equal(page.$("#results").hidden, true);
    assert.equal(page.$("#error-summary").hidden, false);
    assert.match(page.text("#error-summary"), /at most 100,000,000/);
    assert.equal(page.doc.activeElement.id, "error-summary");
    window.close();
  });
});

describe("plan rendering", () => {
  test("renders every section and moves focus to the results", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    page.check('input[name="priorities"][value="food"]');
    await page.submitAndWait();

    assert.equal(page.text("#status"), "Your plan is ready.");
    assert.equal(page.doc.activeElement.id, "results-heading");
    assert.equal(page.$("#results").hasAttribute("aria-busy"), false);
    assert.equal(page.doc.querySelectorAll("#summary .stat").length, 6);
    assert.ok(page.doc.querySelectorAll("#budget-table tbody tr").length > 5);
    assert.ok(page.text("#budget-table .tag").includes("priority"));
    assert.ok(page.doc.querySelectorAll("#timeline .phase").length >= 3);
    assert.ok(page.doc.querySelectorAll("#timeline time[datetime]").length > 5);
    assert.ok(page.doc.querySelectorAll("#insights li").length > 0);
    assert.match(page.text("#timeline-meta"), /Compressed schedule/);
    assert.ok(page.doc.querySelectorAll("#ideas .theme").length >= 1);
    assert.match(page.text("#ideas-meta"), /Generated by AI/);
    window.close();
  });

  test("budget bars are sized through CSSOM and hidden from screen readers", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    const bars = [...page.doc.querySelectorAll("#budget-table .bar span")];
    assert.ok(bars.length > 5);
    assert.ok(bars.every((bar) => bar.getAttribute("aria-hidden") === "true" && /rem$/.test(bar.style.width)));
    assert.equal(bars[0].style.width, "6rem", "largest category gets the full bar");
    window.close();
  });

  test("budget pie chart renders SVG slices with accessible titles and center label", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    const svg = page.$("#budget-pie");
    assert.ok(svg);
    const slices = [...svg.querySelectorAll("path.pie-slice")];
    assert.ok(slices.length > 5);
    assert.ok(slices.every((s) => s.getAttribute("d") && s.getAttribute("fill")));
    const center = svg.querySelector("text.pie-center-label");
    assert.ok(center);
    assert.equal(center.textContent, "100%");
    window.close();
  });

  test("contract defense and negotiation guide is rendered in results", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    const section = page.$(".contract-defense-section");
    assert.ok(section);
    assert.equal(section.querySelectorAll(".contract-guide-card").length, 3);
    window.close();
  });

  test("AI text is rendered as text, never as markup", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    assert.equal(page.text("#ideas .theme strong"), XSS);
    assert.equal(page.text("#ideas .personal"), XSS);
    assert.equal(page.$("#ideas img"), null);
    assert.equal(window.pwned, undefined);
    window.close();
  });

  test("user text is rendered as text too", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    page.set("eventName", "<b>bold</b>");
    await page.submitAndWait();
    assert.equal(page.$("#summary b"), null);
    assert.match(page.text("#summary"), /<b>bold<\/b>/);
    window.close();
  });

  test("curated ideas say so when AI is switched off", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    page.check('input[name="useAI"]', false);
    await page.submitAndWait();
    assert.equal(page.text("#ideas-meta"), "Curated ideas for this type of event.");
    window.close();
  });

  test("small per-guest amounts show cents instead of zero", async () => {
    const window = await openPage();
    const page = driver(window);
    page.check('input[value="community"]');
    page.set("date", futureDate(200));
    page.set("guestCount", "5000");
    page.set("budget", "50");
    await page.submitAndWait();
    const perGuest = [...page.doc.querySelectorAll("#summary .stat")].find((stat) => stat.textContent.startsWith("Per guest"));
    assert.match(perGuest.textContent, /0\.01/);
    window.close();
  });

  test("urgent vendors are flagged to book now", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(20));
    await page.submitAndWait();
    assert.ok(page.doc.querySelectorAll("#vendors .urgent").length > 0);
    assert.match(page.text("#vendors"), /Book now/);
    window.close();
  });
});

describe("vendor checklist", () => {
  test("ticking a vendor updates progress and survives a re-render", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();

    page.check("#vendors input[type=checkbox]");
    assert.match(page.text("#vendor-progress"), /^1 of \d+ booked\.$/);
    assert.ok(page.$("#vendors li").classList.contains("done"));

    await page.submitAndWait(); // same inputs: progress is restored
    assert.equal(page.$("#vendors input[type=checkbox]").checked, true);
    assert.match(page.text("#vendor-progress"), /^1 of/);
    window.close();
  });

  test("a different plan starts with a fresh checklist", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    page.check("#vendors input[type=checkbox]");

    page.set("guestCount", "120");
    await page.submitAndWait();
    assert.match(page.text("#vendor-progress"), /^0 of/);
    window.close();
  });

  test("checkboxes are labelled and described by their tips", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    for (const box of page.doc.querySelectorAll("#vendors input[type=checkbox]")) {
      assert.ok(page.doc.querySelector(`label[for="${box.id}"]`), box.id);
      assert.ok(page.doc.getElementById(box.getAttribute("aria-describedby")), box.id);
    }
    window.close();
  });
});

describe("theme switch", () => {
  test("follows the system by default and lets the user override it", async () => {
    const window = await openPage();
    const page = driver(window);
    const root = window.document.documentElement;
    assert.equal(root.dataset.theme, undefined);
    assert.equal(page.$('input[name="theme"][value="system"]').checked, true);

    page.check('input[name="theme"][value="dark"]');
    assert.equal(root.dataset.theme, "dark");
    assert.equal(window.localStorage.getItem("theme"), "dark");

    page.check('input[name="theme"][value="light"]');
    assert.equal(root.dataset.theme, "light");

    page.check('input[name="theme"][value="system"]');
    assert.equal(root.dataset.theme, undefined);
    assert.equal(window.localStorage.getItem("theme"), null);
    window.close();
  });

  test("a saved theme is applied before the app script runs and reflected in the switch", async () => {
    const window = await openPage({ storage: { theme: "light" } });
    assert.equal(window.document.documentElement.dataset.theme, "light");
    assert.equal(window.document.querySelector('input[name="theme"][value="light"]').checked, true);
    window.close();
  });

  test("an unknown saved value is ignored", async () => {
    const window = await openPage({ storage: { theme: "neon" } });
    assert.equal(window.document.documentElement.dataset.theme, undefined);
    assert.equal(window.document.querySelector('input[name="theme"][value="system"]').checked, true);
    window.close();
  });

  test("the stylesheet switches both themes through color-scheme", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /:root \{[^}]*color-scheme: light dark/);
    assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
    assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(css, /--bg: light-dark\(/);
  });
});

describe("plan export", () => {
  test("downloads the plan as readable text covering every section", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    page.set("eventName", "Sam & Alex: Garden Wedding!");
    page.check('input[name="priorities"][value="food"]');
    await page.submitAndWait();

    let blob;
    let link;
    window.URL.createObjectURL = (value) => { blob = value; return "blob:plan"; };
    window.URL.revokeObjectURL = () => {};
    const click = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function () { link = this; };
    try {
      page.$("#download-btn").click();
    } finally {
      window.HTMLAnchorElement.prototype.click = click;
    }
    assert.equal(link.getAttribute("download"), "sam-alex-garden-wedding.txt", "file name is derived safely from the event name");
    assert.equal(page.$("a[download]"), null, "the helper link is removed again");
    assert.match(page.text("#status"), /downloaded/);

    const text = await new Promise((resolve) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });
    assert.match(text, /^Sam & Alex: Garden Wedding!\n=+\n/);
    for (const heading of ["THINGS TO KNOW", "BUDGET BREAKDOWN", "TIMELINE", "VENDOR CHECKLIST", "IDEAS (AI-personalized)", "CONTRACT DEFENSE & NEGOTIATION CHECKLIST"]) {
      assert.ok(text.includes(heading), heading);
    }
    assert.match(text, /Food & drinks \(priority\)/);
    assert.match(text, /\[ \] Venue \(essential\)/);
    assert.ok(text.includes(XSS), "AI text is exported verbatim as text");
    window.close();
  });

  test("does nothing before a plan exists", async () => {
    const window = await openPage();
    window.URL.createObjectURL = () => { throw new Error("must not be called"); };
    window.document.getElementById("download-btn").click();
    assert.equal(window.document.getElementById("status").textContent, "");
    window.close();
  });
});

describe("failure handling", () => {
  test("network failures show a message, hide stale results and keep focus on the button", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    assert.equal(page.$("#results").hidden, false);

    window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    page.$("#submit-btn").focus();
    await page.submitAndWait();
    assert.match(page.text("#status"), /Could not reach the server/);
    assert.equal(page.$("#results").hidden, true);
    assert.equal(page.doc.activeElement.id, "submit-btn");
    assert.equal(page.$("#submit-btn").getAttribute("aria-disabled"), "false");
    window.close();
  });

  test("timeouts suggest turning off AI", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    window.fetch = () => Promise.reject(new window.DOMException("timed out", "TimeoutError"));
    await page.submitAndWait();
    assert.match(page.text("#status"), /taking too long/);
    window.close();
  });

  test("server errors show the server's message", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    window.fetch = async () => new Response(JSON.stringify({ error: "Too many requests. Please wait a moment." }), { status: 429 });
    await page.submitAndWait();
    assert.equal(page.text("#status"), "Too many requests. Please wait a moment.");
    window.close();
  });

  test("non-JSON error responses fall back to a generic message", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    window.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
    await page.submitAndWait();
    assert.equal(page.text("#status"), "Something went wrong. Please try again.");
    window.close();
  });

  test("double submits while a request is in flight send only one request", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    let calls = 0;
    let release;
    window.fetch = () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(new Response("{}", { status: 500 })); });
    };
    page.submit();
    assert.equal(page.$("#submit-btn").getAttribute("aria-disabled"), "true");
    assert.equal(page.$("#results").getAttribute("aria-busy"), "true");
    page.submit();
    page.submit();
    release();
    await waitFor(() => page.$("#submit-btn").getAttribute("aria-disabled") === "false");
    assert.equal(calls, 1);
    window.close();
  });
});

describe("accessibility audit", () => {
  test("page has a language, title, main landmark and skip link target", async () => {
    const window = await openPage();
    const { document: doc } = window;
    assert.equal(doc.documentElement.lang, "en");
    assert.ok(doc.title.length > 0);
    assert.equal(doc.querySelectorAll("main").length, 1);
    const skip = doc.querySelector(".skip-link");
    assert.ok(doc.querySelector(skip.getAttribute("href")));
    assert.ok(doc.querySelector('meta[name="viewport"]'));
    window.close();
  });

  test("every form control has an accessible name", async () => {
    const window = await openPage();
    const { document: doc } = window;
    for (const control of doc.querySelectorAll("input, select, textarea")) {
      const labelled = (control.id && doc.querySelector(`label[for="${control.id}"]`)) || control.closest("label") || control.getAttribute("aria-label");
      assert.ok(labelled, `${control.outerHTML} has no label`);
    }
    window.close();
  });

  test("every button has text", async () => {
    const window = await openPage();
    for (const button of window.document.querySelectorAll("button")) assert.ok(button.textContent.trim(), button.outerHTML);
    window.close();
  });

  test("ids are unique and every ARIA reference resolves", async () => {
    const window = await openPage();
    const { document: doc } = window;
    const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const node of doc.querySelectorAll("[aria-describedby], [aria-labelledby]")) {
      const refs = `${node.getAttribute("aria-describedby") ?? ""} ${node.getAttribute("aria-labelledby") ?? ""}`.trim().split(/\s+/);
      for (const ref of refs) assert.ok(doc.getElementById(ref), `${ref} referenced by ${node.id || node.tagName}`);
    }
    window.close();
  });

  test("headings do not skip levels", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    const levels = [...page.doc.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1]));
    assert.equal(levels[0], 1);
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} → h${levels[i]}`);
    window.close();
  });

  test("radio and checkbox groups are wrapped in fieldsets with legends", async () => {
    const window = await openPage();
    for (const name of ["theme", "eventType", "priorities", "considerations"]) {
      const input = window.document.querySelector(`input[name="${name}"]`);
      const fieldset = input.closest("fieldset");
      assert.ok(fieldset?.querySelector("legend")?.textContent.trim(), name);
    }
    window.close();
  });

  test("status messages use a polite live region", async () => {
    const window = await openPage();
    const status = window.document.getElementById("status");
    assert.equal(status.getAttribute("role"), "status");
    assert.equal(status.getAttribute("aria-live"), "polite");
    window.close();
  });

  test("the budget table has a caption and scoped headers", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    await page.submitAndWait();
    assert.ok(page.$("#budget-table caption").textContent);
    assert.ok([...page.doc.querySelectorAll("#budget-table thead th")].every((th) => th.getAttribute("scope") === "col"));
    assert.ok([...page.doc.querySelectorAll("#budget-table tbody th")].every((th) => th.getAttribute("scope") === "row"));
    window.close();
  });

  test("stylesheet covers chip focus, forced colors and reduced motion", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /\.choice:has\(input:focus-visible\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  });

  test("the error summary is wired as a labelled alert region", async () => {
    const window = await openPage();
    const summary = window.document.getElementById("error-summary");
    assert.equal(summary.getAttribute("tabindex"), "-1");
    assert.ok(window.document.getElementById(summary.getAttribute("aria-labelledby")));
    assert.equal(summary.hidden, true);
    window.close();
  });

  test("no inline scripts or styles, so the strict CSP holds", async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /\sstyle=/);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });
});

describe("geolocation feature", () => {
  test("shows message when geolocation is unsupported", async () => {
    const window = await openPage();
    delete window.navigator.geolocation;
    const geoBtn = window.document.getElementById("geo-btn");
    geoBtn.click();
    const status = window.document.getElementById("geo-status");
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /not supported/);
    window.close();
  });

  test("handles permission denied", async () => {
    const window = await openPage();
    window.navigator.geolocation = {
      getCurrentPosition: (_success, error) => error({ code: 1, message: "User denied" }),
    };
    const geoBtn = window.document.getElementById("geo-btn");
    geoBtn.click();
    const status = window.document.getElementById("geo-status");
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /denied/i);
    window.close();
  });

  test("sets location and updates input on success", async () => {
    const window = await openPage();
    window.navigator.geolocation = {
      getCurrentPosition: (success) => success({ coords: { latitude: 47.606, longitude: -122.332 } }),
    };
    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes("/api/geocode")) {
        return {
          ok: true,
          json: async () => ({ location: "Seattle, Washington, United States" }),
        };
      }
      return originalFetch(url, opts);
    };
    const geoBtn = window.document.getElementById("geo-btn");
    geoBtn.click();
    await waitFor(() => window.document.getElementById("location").value === "Seattle, Washington, United States");
    const status = window.document.getElementById("geo-status");
    assert.match(status.textContent, /Location set to Seattle/);
    window.close();
  });

  test("shows location in summary and text export", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("location", "Barcelona, Spain");
    page.set("date", futureDate(60));
    await page.submitAndWait();
    assert.match(page.text("#summary"), /Barcelona, Spain/);
    const summaryMapLink = window.document.querySelector("#summary .map-link");
    assert.ok(summaryMapLink);
    assert.match(summaryMapLink.href, /maps\/search/);
    assert.match(summaryMapLink.href, /Barcelona/);
    const vendorMapLinks = window.document.querySelectorAll("#vendors .vendor-map-link");
    assert.ok(vendorMapLinks.length >= 1);
    window.close();
  });

  test("handles location unavailable and timeout error codes", async () => {
    const window = await openPage();
    window.navigator.geolocation = {
      getCurrentPosition: (_success, error) => error({ code: 2, message: "Position unavailable" }),
    };
    const geoBtn = window.document.getElementById("geo-btn");
    geoBtn.click();
    const status = window.document.getElementById("geo-status");
    assert.match(status.textContent, /Location unavailable/i);

    window.navigator.geolocation = {
      getCurrentPosition: (_success, error) => error({ code: 3, message: "Timeout" }),
    };
    geoBtn.click();
    assert.match(status.textContent, /timed out/i);
    window.close();
  });
});

describe("landing page hero and scroll", () => {
  test("renders hero section with title, value props, and feature cards", async () => {
    const window = await openPage();
    const hero = window.document.querySelector(".hero-section");
    assert.ok(hero);
    assert.ok(window.document.getElementById("hero-title"));
    assert.ok(window.document.getElementById("start-planning-cta"));
    const features = window.document.querySelectorAll(".feature-card");
    assert.equal(features.length, 4);
    assert.ok(window.document.querySelector(".hero-badge"));
    window.close();
  });

  test("clicking start planning CTA scrolls to form and transfers focus to heading", async () => {
    const window = await openPage();
    const cta = window.document.getElementById("start-planning-cta");
    const heading = window.document.getElementById("form-heading");
    let scrolled = false;
    window.document.getElementById("form-card").scrollIntoView = () => { scrolled = true; };

    cta.click();
    await waitFor(() => window.document.activeElement === heading, 1500);
    assert.equal(scrolled, true);
    assert.equal(window.document.activeElement, heading);
    window.close();
  });

  test("handles reduced motion preference with instant scroll", async () => {
    const window = await openPage();
    window.matchMedia = (query) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
    });
    const cta = window.document.getElementById("start-planning-cta");
    const heading = window.document.getElementById("form-heading");
    let scrollOptions = null;
    window.document.getElementById("form-card").scrollIntoView = (opts) => { scrollOptions = opts; };

    cta.click();
    assert.ok(scrollOptions);
    assert.equal(scrollOptions.behavior, "auto");
    assert.equal(scrollOptions.block, "start");
    assert.equal(window.document.activeElement, heading);
    window.close();
  });

  test("ignores modified clicks on the hero CTA", async () => {
    const window = await openPage();
    const cta = window.document.getElementById("start-planning-cta");
    const heading = window.document.getElementById("form-heading");
    let scrolled = false;
    window.document.getElementById("form-card").scrollIntoView = () => { scrolled = true; };

    const evt = new window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    cta.dispatchEvent(evt);

    assert.equal(scrolled, false);
    assert.notEqual(window.document.activeElement, heading);
    window.close();
  });
});

describe("accessibility preferences toolbar", () => {
  test("font size switch defaults to normal and updates dataset and storage when toggled", async () => {
    const window = await openPage();
    const page = driver(window);
    const root = window.document.documentElement;
    assert.equal(root.dataset.textSize, undefined);
    assert.equal(page.$('input[name="textSize"][value="normal"]').checked, true);

    page.check('input[name="textSize"][value="large"]');
    assert.equal(root.dataset.textSize, "large");
    assert.equal(root.getAttribute("data-text-size"), "large");
    assert.equal(window.localStorage.getItem("textSize"), "large");

    page.check('input[name="textSize"][value="normal"]');
    assert.equal(root.dataset.textSize, undefined);
    assert.equal(root.hasAttribute("data-text-size"), false);
    assert.equal(window.localStorage.getItem("textSize"), null);
    window.close();
  });

  test("contrast switch defaults to normal and updates dataset and storage when toggled", async () => {
    const window = await openPage();
    const page = driver(window);
    const root = window.document.documentElement;
    assert.equal(root.dataset.contrast, undefined);
    assert.equal(page.$('input[name="contrast"][value="normal"]').checked, true);

    page.check('input[name="contrast"][value="high"]');
    assert.equal(root.dataset.contrast, "high");
    assert.equal(root.getAttribute("data-contrast"), "high");
    assert.equal(window.localStorage.getItem("contrast"), "high");

    page.check('input[name="contrast"][value="normal"]');
    assert.equal(root.dataset.contrast, undefined);
    assert.equal(root.hasAttribute("data-contrast"), false);
    assert.equal(window.localStorage.getItem("contrast"), null);
    window.close();
  });

  test("motion switch defaults to system and updates dataset and storage when toggled", async () => {
    const window = await openPage();
    const page = driver(window);
    const root = window.document.documentElement;
    assert.equal(root.dataset.motion, undefined);
    assert.equal(page.$('input[name="motion"][value="system"]').checked, true);

    page.check('input[name="motion"][value="reduce"]');
    assert.equal(root.dataset.motion, "reduce");
    assert.equal(root.getAttribute("data-motion"), "reduce");
    assert.equal(window.localStorage.getItem("motion"), "reduce");

    page.check('input[name="motion"][value="system"]');
    assert.equal(root.dataset.motion, undefined);
    assert.equal(root.hasAttribute("data-motion"), false);
    assert.equal(window.localStorage.getItem("motion"), null);
    window.close();
  });

  test("saved accessibility preferences are applied before app script runs and reflected in controls", async () => {
    const window = await openPage({
      storage: { textSize: "large", contrast: "high", motion: "reduce" },
    });
    const root = window.document.documentElement;
    assert.equal(root.dataset.textSize, "large");
    assert.equal(root.dataset.contrast, "high");
    assert.equal(root.dataset.motion, "reduce");

    assert.equal(window.document.querySelector('input[name="textSize"][value="large"]').checked, true);
    assert.equal(window.document.querySelector('input[name="contrast"][value="high"]').checked, true);
    assert.equal(window.document.querySelector('input[name="motion"][value="reduce"]').checked, true);
    window.close();
  });

  test("unknown saved accessibility values are ignored", async () => {
    const window = await openPage({
      storage: { textSize: "gigantic", contrast: "ultra", motion: "spinning" },
    });
    const root = window.document.documentElement;
    assert.equal(root.dataset.textSize, undefined);
    assert.equal(root.dataset.contrast, undefined);
    assert.equal(root.dataset.motion, undefined);

    assert.equal(window.document.querySelector('input[name="textSize"][value="normal"]').checked, true);
    assert.equal(window.document.querySelector('input[name="contrast"][value="normal"]').checked, true);
    assert.equal(window.document.querySelector('input[name="motion"][value="system"]').checked, true);
    window.close();
  });

  test("accessibility panel is expandable with keyboard escape and click-outside dismissal", async () => {
    const window = await openPage();
    const panel = window.document.getElementById("a11y-panel");
    const toggle = window.document.getElementById("a11y-toggle");
    assert.equal(panel.open, false);

    panel.open = true;
    const evt = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    window.document.dispatchEvent(evt);
    assert.equal(panel.open, false);
    assert.equal(window.document.activeElement, toggle);

    panel.open = true;
    const clickEvt = new window.MouseEvent("click", { bubbles: true });
    window.document.body.dispatchEvent(clickEvt);
    assert.equal(panel.open, false);
    window.close();
  });

  test("reduced motion preference in dataset overrides hero scroll behavior", async () => {
    const window = await openPage({ storage: { motion: "reduce" } });
    const cta = window.document.getElementById("start-planning-cta");
    const heading = window.document.getElementById("form-heading");
    let scrollOptions = null;
    window.document.getElementById("form-card").scrollIntoView = (opts) => { scrollOptions = opts; };

    cta.click();
    assert.ok(scrollOptions);
    assert.equal(scrollOptions.behavior, "auto");
    assert.equal(scrollOptions.block, "start");
    assert.equal(window.document.activeElement, heading);
    window.close();
  });

  test("theme switch choices have transparent background when unchecked so text is visible", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /\.theme-switch \.choice\s*\{[^}]*background:\s*transparent/);
  });

  test("stylesheet contains rules for text-size, contrast, and motion dataset attributes", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /:root\[data-text-size="large"\]/);
    assert.match(css, /:root\[data-contrast="high"\]/);
    assert.match(css, /:root\[data-motion="reduce"\]/);
  });

  test("storage event synchronizes accessibility preferences across tabs", async () => {
    const window = await openPage();
    const event = new window.StorageEvent("storage", {
      key: "textSize",
      newValue: "large",
    });
    window.dispatchEvent(event);
    assert.equal(window.document.documentElement.dataset.textSize, "large");
    assert.equal(window.document.querySelector('input[name="textSize"][value="large"]').checked, true);

    const contrastEvent = new window.StorageEvent("storage", {
      key: "contrast",
      newValue: "high",
    });
    window.dispatchEvent(contrastEvent);
    assert.equal(window.document.documentElement.dataset.contrast, "high");
    assert.equal(window.document.querySelector('input[name="contrast"][value="high"]').checked, true);

    const motionEvent = new window.StorageEvent("storage", {
      key: "motion",
      newValue: "reduce",
    });
    window.dispatchEvent(motionEvent);
    assert.equal(window.document.documentElement.dataset.motion, "reduce");
    assert.equal(window.document.querySelector('input[name="motion"][value="reduce"]').checked, true);

    const themeEvent = new window.StorageEvent("storage", {
      key: "theme",
      newValue: "dark",
    });
    window.dispatchEvent(themeEvent);
    assert.equal(window.document.documentElement.dataset.theme, "dark");
    assert.equal(window.document.querySelector('input[name="theme"][value="dark"]').checked, true);
    window.close();
  });

  test("budget input and currency select flexbox rules prevent squishing", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /\.inline select\s*\{[^}]*min-width/);
    assert.match(css, /\.inline input\s*\{[^}]*flex:\s*1\s+1\s+auto/);
  });

  test("print stylesheet includes clean document header, footer, and hide bar rules", async () => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /@media print/);
    assert.match(css, /\.print-header\s*\{[^}]*display:\s*flex/);
    assert.match(css, /\.bar span\s*\{[^}]*display:\s*none/);
  });

  test("rendering plan updates results heading and print subtitle with event name", async () => {
    const window = await openPage();
    const page = driver(window);
    page.set("date", futureDate(60));
    page.set("eventName", "Silver Anniversary");
    await page.submitAndWait();
    assert.equal(page.text("#results-heading"), "Your plan: Silver Anniversary");
    assert.match(page.text("#print-subtitle"), /Silver Anniversary/);
    window.close();
  });
});
