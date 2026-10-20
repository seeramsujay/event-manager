import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createApp } from "../src/app.js";
import { createIdeasService } from "../src/ai/ideas.js";
import { RateLimiter } from "../src/lib/rateLimiter.js";
import { NOW, request } from "./helpers.js";

/** Starts an app on a random port; returns its base URL and a close function. */
async function startApp(options = {}) {
  const app = createApp({
    ideasService: createIdeasService({ client: null }),
    rateLimiter: new RateLimiter({ limit: 1000 }),
    now: () => NOW,
    logger: { error() {} },
    ...options,
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Sends a raw HTTP request, for targets fetch() refuses to send. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(text));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

const jsonHeaders = { "Content-Type": "application/json" };
const postTo = (base, body, headers = jsonHeaders) =>
  fetch(`${base}/api/plan`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("HTTP API", () => {
  let app;
  before(async () => { app = await startApp(); });
  after(() => app.close());
  const post = (body, headers) => postTo(app.base, body, headers);

  describe("static files", () => {
    const files = [
      ["/", /text\/html/, /<html lang="en">/],
      ["/index.html", /text\/html/, /<main id="main"/],
      ["/styles.css", /text\/css/, /:root/],
      ["/app.js", /text\/javascript/, /use strict/],
      ["/favicon.svg", /image\/svg\+xml/, /<svg/],
    ];
    for (const [path, type, body] of files) {
      test(`serves ${path}`, async () => {
        const res = await fetch(`${app.base}${path}`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), type);
        assert.equal(res.headers.get("cache-control"), "no-cache");
        assert.match(await res.text(), body);
      });
    }

    test("ignores query strings", async () => {
      assert.equal((await fetch(`${app.base}/styles.css?v=2`)).status, 200);
    });

    test("supports HEAD without a body", async () => {
      const res = await fetch(`${app.base}/`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "");
    });

    test("does not serve static files to POST", async () => {
      assert.equal((await fetch(`${app.base}/`, { method: "POST" })).status, 404);
    });
  });

  describe("security headers", () => {
    for (const path of ["/", "/api/health", "/missing"]) {
      test(`are set on ${path}`, async () => {
        const res = await fetch(`${app.base}${path}`);
        const csp = res.headers.get("content-security-policy");
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src 'self'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(res.headers.get("x-frame-options"), "DENY");
        assert.equal(res.headers.get("referrer-policy"), "no-referrer");
        assert.match(res.headers.get("permissions-policy"), /camera=\(\)/);
        assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
      });
    }

    test("API responses are never cached", async () => {
      for (const res of [await fetch(`${app.base}/api/health`), await post(request()), await post({})]) {
        assert.equal(res.headers.get("cache-control"), "no-store");
      }
    });
  });

  test("health reports AI mode", async () => {
    const res = await fetch(`${app.base}/api/health`);
    assert.deepEqual(await res.json(), { status: "ok", ai: false });
  });

  describe("POST /api/plan", () => {
    for (const eventType of ["wedding", "birthday", "community"]) {
      test(`returns a full ${eventType} plan`, async () => {
        const res = await post(request({ eventType, honoreeAge: eventType === "birthday" ? 8 : undefined }));
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /application\/json/);
        const plan = await res.json();
        for (const key of ["summary", "budget", "timeline", "vendors", "insights", "ideas"]) assert.ok(plan[key], key);
        assert.equal(plan.summary.eventType, eventType);
        assert.equal(plan.ideas.source, "curated");
      });
    }

    test("accepts content types with parameters and any letter case", async () => {
      for (const type of ["application/json; charset=utf-8", "Application/JSON", "APPLICATION/JSON;charset=UTF-8"]) {
        assert.equal((await post(request(), { "Content-Type": type })).status, 200, type);
      }
    });

    test("rejects look-alike and missing content types", async () => {
      for (const type of ["application/jsonp", "application/json-seq", "text/plain", "application/x-www-form-urlencoded"]) {
        assert.equal((await post(request(), { "Content-Type": type })).status, 415, type);
      }
      assert.equal((await fetch(`${app.base}/api/plan`, { method: "POST", body: new Blob([JSON.stringify(request())]) })).status, 415);
    });

    test("returns field errors for invalid input", async () => {
      const res = await post(request({ guestCount: -1, priorities: ["fireworks"] }));
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.error, "Please check the highlighted fields.");
      assert.deepEqual(body.details.map((d) => d.field).sort(), ["guestCount", "priorities"]);
    });

    for (const [name, body] of [["null", "null"], ["an array", "[]"], ["a string", '"hi"'], ["a number", "42"]]) {
      test(`rejects ${name} body with 422`, async () => {
        const res = await post(body);
        assert.equal(res.status, 422);
        assert.equal((await res.json()).details[0].field, "body");
      });
    }

    for (const [name, body] of [["truncated JSON", "{oops"], ["empty body", ""], ["trailing garbage", "{} x"]]) {
      test(`rejects ${name} with 400`, async () => {
        const res = await post(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Body must be valid JSON" });
      });
    }

    test("rejects oversized bodies by content-length", async () => {
      assert.equal((await post(JSON.stringify({ notes: "x".repeat(20_000) }))).status, 413);
    });

    test("rejects oversized chunked bodies while streaming", async () => {
      const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const res = await fetch(`${app.base}/api/plan`, { method: "POST", headers: jsonHeaders, body: stream, duplex: "half" });
      assert.equal(res.status, 413);
    });

    test("accepts a body just under the limit", async () => {
      const body = JSON.stringify(request({ notes: "x".repeat(500) }));
      assert.ok(body.length < 16 * 1024);
      assert.equal((await post(body)).status, 200);
    });

    test("wrong methods get 405 with an Allow header", async () => {
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        const res = await fetch(`${app.base}/api/plan`, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
      }
    });

    test("handles concurrent requests independently", async () => {
      const responses = await Promise.all(
        [10, 20, 30, 40, 50].map((guestCount) => post(request({ guestCount })).then((res) => res.json())),
      );
      assert.deepEqual(responses.map((plan) => plan.summary.guestCount), [10, 20, 30, 40, 50]);
    });
  });

  describe("routing", () => {
    for (const path of ["/missing", "/api", "/api/plans", "/../package.json", "/%2e%2e/src/server.js", "/src/server.js", "/.env", "/node_modules/zod/package.json"]) {
      test(`${path} is 404`, async () => {
        const res = await fetch(`${app.base}${path}`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Not found" });
      });
    }

    test("malformed request targets get a response instead of crashing the server", async () => {
      for (const target of ["//[", "http://[::1", "*", "//evil.example/x"]) {
        const response = await rawRequest(app.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        assert.match(response, /^HTTP\/1\.1 (400|404)/, target);
      }
      assert.equal((await fetch(`${app.base}/api/health`)).status, 200, "server is still up");
    });
  });
});

describe("error handling", () => {
  test("unexpected errors return a generic 500 without leaking details", async () => {
    const logged = [];
    const app = await startApp({
      ideasService: { enabled: true, getIdeas: async () => { throw new Error("secret stack detail"); } },
      logger: { error: (...args) => logged.push(args) },
    });
    try {
      const res = await postTo(app.base, request());
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.doesNotMatch(text, /secret|stack/);
      assert.deepEqual(JSON.parse(text), { error: "Something went wrong. Please try again." });
      assert.equal(logged.length, 1, "the error is logged for operators");
    } finally {
      await app.close();
    }
  });

  test("health reflects an enabled AI service", async () => {
    const app = await startApp({ ideasService: { enabled: true, getIdeas: async () => ({}) } });
    try {
      assert.deepEqual(await (await fetch(`${app.base}/api/health`)).json(), { status: "ok", ai: true });
    } finally {
      await app.close();
    }
  });
});

describe("rate limiting", () => {
  test("limits the plan endpoint per client and sends Retry-After", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 2 }) });
    try {
      assert.equal((await postTo(app.base, request())).status, 200);
      assert.equal((await postTo(app.base, request())).status, 200);
      const res = await postTo(app.base, request());
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get("retry-after")) > 0);
      assert.match((await res.json()).error, /Too many requests/);
    } finally {
      await app.close();
    }
  });

  test("invalid requests also count, so validation errors cannot be used to probe for free", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 1 }) });
    try {
      assert.equal((await postTo(app.base, {})).status, 422);
      assert.equal((await postTo(app.base, request())).status, 429);
    } finally {
      await app.close();
    }
  });

  test("health and static files are not rate limited", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 0 }) });
    try {
      for (let i = 0; i < 5; i++) {
        assert.equal((await fetch(`${app.base}/api/health`)).status, 200);
        assert.equal((await fetch(`${app.base}/`)).status, 200);
      }
    } finally {
      await app.close();
    }
  });

  test("X-Forwarded-For is ignored unless a proxy is trusted", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 1 }) });
    try {
      assert.equal((await postTo(app.base, request(), { ...jsonHeaders, "X-Forwarded-For": "1.1.1.1" })).status, 200);
      assert.equal((await postTo(app.base, request(), { ...jsonHeaders, "X-Forwarded-For": "2.2.2.2" })).status, 429);
    } finally {
      await app.close();
    }
  });

  test("behind a trusted proxy, spoofed left-most X-Forwarded-For entries cannot dodge the limit", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 1 }), trustProxy: true });
    try {
      const send = (spoofed) => postTo(app.base, request(), { ...jsonHeaders, "X-Forwarded-For": `${spoofed}, 198.51.100.7` });
      assert.equal((await send("10.0.0.1")).status, 200);
      assert.equal((await send("10.0.0.2")).status, 429);
      assert.equal((await send("10.0.0.3")).status, 429);
    } finally {
      await app.close();
    }
  });

  test("behind a trusted proxy, different real clients get separate limits", async () => {
    const app = await startApp({ rateLimiter: new RateLimiter({ limit: 1 }), trustProxy: true });
    try {
      const send = (client) => postTo(app.base, request(), { ...jsonHeaders, "X-Forwarded-For": client });
      assert.equal((await send("198.51.100.1")).status, 200);
      assert.equal((await send("198.51.100.2")).status, 200);
      assert.equal((await send("198.51.100.1")).status, 429);
    } finally {
      await app.close();
    }
  });
});
