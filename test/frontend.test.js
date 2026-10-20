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

/** Opens the app. jsdom has no fetch, so route the page's fetch to Node's. */
async function openPage() {
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Node's fetch can't take jsdom's AbortSignal; timeouts are covered by code review, not here.
      window.fetch = (url, { signal, ...options } = {}) => fetch(new URL(url, base), options);
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
    assert.equal(page.doc.activeElement.id, "date");
    assert.match(page.text("#status"), /fix the highlighted fields/);
    assert.ok(page.$("#status").classList.contains("error-msg"));
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
    assert.equal(page.doc.activeElement.id, "budget");
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
    for (const name of ["eventType", "priorities", "considerations"]) {
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

  test("no inline scripts or styles, so the strict CSP holds", async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /\sstyle=/);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });
});
