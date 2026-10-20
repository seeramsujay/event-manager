// Loads the real page and app.js from the server into jsdom and drives the UI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import { createIdeasService } from "../src/ai/ideas.js";

const XSS = '<img src=x onerror="window.pwned=true">';
const ideasService = {
  enabled: true,
  async getIdeas(input, plan) {
    const { ideas } = await createIdeasService({ client: null }).getIdeas(input, plan);
    return { source: "ai", ideas: { ...ideas, themes: [{ name: XSS, description: "Injected?" }], personalTouch: XSS } };
  },
};

let server;
let base;

before(async () => {
  server = createServer(createApp({ ideasService, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for UI");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openPage() {
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(url, base), options);
    },
  });
  const { window } = dom;
  await waitFor(() => window.document.readyState === "complete");
  return window;
}

function futureDate(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test("birthday type reveals the age field", async () => {
  const window = await openPage();
  const doc = window.document;
  assert.equal(doc.getElementById("age-field").hidden, true);
  const birthday = doc.querySelector('input[value="birthday"]');
  birthday.checked = true;
  birthday.dispatchEvent(new window.Event("change"));
  assert.equal(doc.getElementById("age-field").hidden, false);
  window.close();
});

test("client-side validation flags fields accessibly and focuses the first error", async () => {
  const window = await openPage();
  const doc = window.document;
  doc.getElementById("guestCount").value = "0";
  doc.getElementById("plan-form").requestSubmit();

  assert.equal(doc.getElementById("date").getAttribute("aria-invalid"), "true");
  assert.equal(doc.getElementById("date-error").hidden, false);
  assert.equal(doc.getElementById("guestCount").getAttribute("aria-invalid"), "true");
  assert.equal(doc.activeElement.id, "date");
  assert.match(doc.getElementById("status").textContent, /fix the highlighted fields/);
  window.close();
});

test("server-side validation errors are shown on the matching field", async () => {
  const window = await openPage();
  const doc = window.document;
  doc.getElementById("date").value = futureDate(30);
  doc.getElementById("budget").value = "999999999";
  doc.getElementById("plan-form").requestSubmit();

  await waitFor(() => !doc.getElementById("budget-error").hidden);
  assert.equal(doc.getElementById("budget").getAttribute("aria-invalid"), "true");
  assert.equal(doc.getElementById("results").hidden, true);
  window.close();
});

test("submitting renders the full plan safely and checklist progress persists", async () => {
  const window = await openPage();
  const doc = window.document;
  doc.getElementById("date").value = futureDate(60);
  doc.querySelector('input[name="priorities"][value="food"]').checked = true;
  doc.getElementById("plan-form").requestSubmit();

  await waitFor(() => !doc.getElementById("results").hidden);
  assert.equal(doc.getElementById("status").textContent, "Your plan is ready.");
  assert.equal(doc.activeElement.id, "results-heading");
  assert.ok(doc.querySelectorAll("#budget-table tbody tr").length > 5);
  assert.ok(doc.querySelector("#budget-table .tag").textContent.includes("priority"));
  assert.ok(doc.querySelectorAll("#timeline .tasks li").length > 5);
  assert.ok(doc.querySelectorAll("#insights li").length > 0);

  // AI text is rendered as text, never as markup.
  assert.equal(doc.querySelector("#ideas .theme strong").textContent, XSS);
  assert.equal(doc.querySelector("#ideas img"), null);
  assert.equal(window.pwned, undefined);

  const checkbox = doc.querySelector("#vendors input[type=checkbox]");
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event("change"));
  assert.match(doc.getElementById("vendor-progress").textContent, /^1 of \d+ booked\.$/);
  assert.ok(checkbox.closest("li").classList.contains("done"));
  const saved = Object.keys(window.localStorage).find((key) => key.startsWith("vendors:"));
  assert.ok(saved, "progress saved to localStorage");
  window.close();
});
