// The serverless entry (api/index.js) and the shared bootstrap it uses.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import handler from "../api/index.js";
import { createAppFromEnv } from "../src/bootstrap.js";
import { request } from "./helpers.js";

describe("createAppFromEnv", () => {
  test("builds a curated-mode app from an empty environment", () => {
    const app = createAppFromEnv({});
    assert.equal(typeof app.handler, "function");
    assert.equal(app.ideasService.enabled, false);
    assert.equal(app.config.trustProxy, false);
  });

  test("enables AI when credentials are present, without calling the API", () => {
    const app = createAppFromEnv({ ANTHROPIC_API_KEY: "sk-test-not-real", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    assert.equal(app.ideasService.enabled, true);
    assert.equal(app.config.model, "claude-sonnet-5-5");
  });

  test("rejects invalid configuration instead of starting half-broken", () => {
    assert.throws(() => createAppFromEnv({ RATE_LIMIT_PER_MINUTE: "lots" }), /RATE_LIMIT_PER_MINUTE/);
  });
});

describe("Vercel entry", () => {
  /** Minimal stand-in for Vercel's request helpers: JSON bodies arrive pre-parsed. */
  function invoke({ method = "GET", url = "/", headers = {}, body } = {}) {
    return new Promise((resolve) => {
      let status;
      let resHeaders = {};
      let payload = "";
      const res = {
        headersSent: false,
        writeHead(code, h = {}) { status = code; resHeaders = h; },
        end(data = "") { payload = String(data); resolve({ status, headers: resHeaders, body: payload }); },
      };
      handler({ method, url, headers, body, socket: { remoteAddress: "127.0.0.1" } }, res);
    });
  }

  test("is a Node-style (req, res) handler", () => {
    assert.equal(typeof handler, "function");
    assert.equal(handler.length, 2);
  });

  test("serves health and the frontend", async () => {
    const health = await invoke({ url: "/api/health" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok", ai: false });
    const page = await invoke({ url: "/" });
    assert.equal(page.status, 200);
    assert.match(page.headers["Content-Type"], /text\/html/);
  });

  test("builds a plan from a pre-parsed JSON body", async () => {
    const res = await invoke({ method: "POST", url: "/api/plan", headers: { "content-type": "application/json" }, body: request() });
    assert.equal(res.status, 200);
    const plan = JSON.parse(res.body);
    for (const key of ["summary", "budget", "timeline", "vendors", "insights", "ideas"]) assert.ok(plan[key], key);
  });

  test("keeps every HTTP safeguard", async () => {
    assert.equal((await invoke({ method: "GET", url: "/api/plan" })).status, 405);
    assert.equal((await invoke({ method: "POST", url: "/api/plan", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await invoke({ method: "POST", url: "/api/plan", headers: { "content-type": "application/json" }, body: "{oops" })).status, 400);
    assert.equal((await invoke({ method: "POST", url: "/api/plan", headers: { "content-type": "application/json" }, body: { guestCount: -1 } })).status, 422);
    assert.equal((await invoke({ url: "/api/unknown" })).status, 404);
  });

  test("trusts the platform proxy, so each forwarded client gets its own rate limit", async () => {
    const post = (client) =>
      invoke({ method: "POST", url: "/api/plan", headers: { "content-type": "application/json", "x-forwarded-for": client }, body: request() });
    let blocked = false;
    for (let i = 0; i < 25 && !blocked; i++) {
      const res = await post("203.0.113.9");
      if (res.status === 429) {
        blocked = true;
        assert.ok(Number(res.headers["Retry-After"]) > 0);
      }
    }
    assert.ok(blocked, "the default limit applies per client");
    assert.equal((await post("203.0.113.10")).status, 200, "another client is unaffected");
  });

  describe("as a real HTTP listener", () => {
    let server;
    let base;
    before(async () => {
      server = createServer(handler);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    test("the same export also serves plain Node requests", async () => {
      const res = await fetch(`${base}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request({ eventType: "community" })),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).summary.eventType, "community");
    });
  });
});
