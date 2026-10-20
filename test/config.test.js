import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { DEFAULT_MODEL } from "../src/ai/ideas.js";

describe("loadConfig", () => {
  test("uses safe defaults with an empty environment", () => {
    assert.deepEqual(loadConfig({}), {
      port: 3000,
      host: "127.0.0.1",
      model: DEFAULT_MODEL,
      rateLimitPerMinute: 20,
      trustProxy: false,
      hasCredentials: false,
    });
  });

  test("reads every supported variable", () => {
    const config = loadConfig({
      PORT: "8080", HOST: "0.0.0.0", ANTHROPIC_MODEL: "claude-sonnet-5-5",
      RATE_LIMIT_PER_MINUTE: "5", TRUST_PROXY: "true", ANTHROPIC_API_KEY: "sk-test",
    });
    assert.deepEqual(config, {
      port: 8080, host: "0.0.0.0", model: "claude-sonnet-5-5", rateLimitPerMinute: 5, trustProxy: true, hasCredentials: true,
    });
  });

  test("treats empty strings as unset", () => {
    const config = loadConfig({ PORT: "", HOST: "  ", ANTHROPIC_MODEL: "", RATE_LIMIT_PER_MINUTE: "", TRUST_PROXY: "", ANTHROPIC_API_KEY: "" });
    assert.equal(config.port, 3000);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.model, DEFAULT_MODEL);
    assert.equal(config.hasCredentials, false);
  });

  test("detects an auth token as credentials", () => {
    assert.equal(loadConfig({ ANTHROPIC_AUTH_TOKEN: "token" }).hasCredentials, true);
  });

  test("accepts port 0 for a random free port", () => {
    assert.equal(loadConfig({ PORT: "0" }).port, 0);
  });

  for (const PORT of ["abc", "-1", "65536", "3.5", "1e3x", "NaN"]) {
    test(`rejects PORT=${PORT}`, () => assert.throws(() => loadConfig({ PORT }), /PORT must be an integer/));
  }

  for (const RATE_LIMIT_PER_MINUTE of ["0", "-5", "10001", "ten"]) {
    test(`rejects RATE_LIMIT_PER_MINUTE=${RATE_LIMIT_PER_MINUTE}`, () =>
      assert.throws(() => loadConfig({ RATE_LIMIT_PER_MINUTE }), /RATE_LIMIT_PER_MINUTE/));
  }

  for (const [value, expected] of [["1", true], ["TRUE", true], ["yes", true], ["0", false], ["false", false], ["No", false]]) {
    test(`TRUST_PROXY=${value} → ${expected}`, () => assert.equal(loadConfig({ TRUST_PROXY: value }).trustProxy, expected));
  }

  test("rejects an unclear TRUST_PROXY value", () => {
    assert.throws(() => loadConfig({ TRUST_PROXY: "maybe" }), /TRUST_PROXY must be true or false/);
  });
});
