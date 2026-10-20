// Runs the real entry point as a child process: configuration, startup and shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
const BASE_ENV = { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0" };

function start(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...BASE_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
    child.stdout.on("data", () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    exited.then(() => { clearTimeout(timer); reject(new Error(`server exited: ${output}`)); });
  });
  return { child, ready, exited, output: () => output };
}

test("starts in curated mode without credentials and serves requests", async () => {
  const server = start({});
  try {
    const base = await server.ready;
    assert.match(server.output(), /AI ideas: off/);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: "ok", ai: false });
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    server.child.kill("SIGTERM");
  }
  assert.equal(await server.exited, 0, "shuts down cleanly on SIGTERM");
});

test("starts in AI mode when a key is present, without calling the API", async () => {
  const server = start({ ANTHROPIC_API_KEY: "sk-test-not-real", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
  try {
    const base = await server.ready;
    assert.match(server.output(), /AI ideas: on, claude-sonnet-5-5/);
    assert.doesNotMatch(server.output(), /sk-test/, "the key is never logged");
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: "ok", ai: true });
  } finally {
    server.child.kill("SIGINT");
  }
  assert.equal(await server.exited, 0, "shuts down cleanly on SIGINT");
});

for (const [name, env, message] of [
  ["an invalid port", { PORT: "http" }, /PORT must be an integer/],
  ["an invalid rate limit", { RATE_LIMIT_PER_MINUTE: "0" }, /RATE_LIMIT_PER_MINUTE/],
  ["an unclear TRUST_PROXY", { TRUST_PROXY: "sometimes" }, /TRUST_PROXY/],
]) {
  test(`exits with a clear message on ${name}`, async () => {
    const server = start(env);
    server.ready.catch(() => {});
    assert.equal(await server.exited, 1);
    assert.match(server.output(), /Configuration error/);
    assert.match(server.output(), message);
  });
}
