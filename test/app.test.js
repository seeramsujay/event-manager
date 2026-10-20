import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { createIdeasService } from "../src/ai/ideas.js";
import { RateLimiter } from "../src/lib/rateLimiter.js";
import { NOW, request } from "./helpers.js";

let server;
let base;

before(async () => {
  const app = createApp({
    ideasService: createIdeasService({ client: null }),
    rateLimiter: new RateLimiter({ limit: 5 }),
    now: () => NOW,
    logger: { error() {} },
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (body, headers = { "Content-Type": "application/json" }) =>
  fetch(`${base}/api/plan`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("serves the app with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /<html lang="en">/);
});

test("health reports AI mode", async () => {
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(body, { status: "ok", ai: false });
});

test("returns a full plan with ideas", async () => {
  const res = await post(request({ eventType: "birthday", honoreeAge: 8, guestCount: 20, budget: 800, date: "2026-02-20" }));
  assert.equal(res.status, 200);
  const plan = await res.json();
  for (const key of ["summary", "budget", "timeline", "vendors", "insights", "ideas"]) assert.ok(plan[key], key);
  assert.equal(plan.ideas.source, "curated");
});

test("returns field errors for invalid input", async () => {
  const res = await post(request({ guestCount: -1 }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.details[0].field, "guestCount");
});

test("rejects malformed, oversized and non-JSON bodies", async () => {
  assert.equal((await post("{oops")).status, 400);
  assert.equal((await post(JSON.stringify({ notes: "x".repeat(20_000) }))).status, 413);
  assert.equal((await post("a=b", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
});

test("unknown paths and traversal attempts are 404, wrong methods 405", async () => {
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/src/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/plan`)).status, 405);
});

test("rate limits the plan endpoint", async () => {
  // Earlier tests used some of the 5 allowed requests; keep going until blocked.
  let res;
  for (let i = 0; i < 6; i++) res = await post(request());
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
});
