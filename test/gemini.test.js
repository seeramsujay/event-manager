import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiClient } from "../src/ai/gemini.js";
import { createIdeasService, describeFailure } from "../src/ai/ideas.js";
import { createAppFromEnv } from "../src/bootstrap.js";
import { buildPlan } from "../src/planner/index.js";
import { NOW, request } from "./helpers.js";

const AI_IDEAS = {
  themes: [{ name: "Lantern garden", description: "Paper lanterns over long tables." }],
  decor: ["Lanterns"],
  food: ["Mezze boards"],
  activities: ["Wish tree"],
  budgetTips: ["Borrow lanterns"],
  personalTouch: "Make it yours.",
};

describe("createGeminiClient", () => {
  test("uses default fetch and options", () => {
    const client = createGeminiClient({ apiKey: "key" });
    assert.equal(client.apiKey, "key");
    assert.equal(client.timeout, 30_000);
  });

  test("throws when apiKey is missing or empty", () => {
    assert.throws(() => createGeminiClient({ apiKey: "" }), /GEMINI_API_KEY is required/);
    assert.throws(() => createGeminiClient({}), /GEMINI_API_KEY is required/);
  });

  test("calls Gemini API and parses candidate text", async () => {
    let calledUrl = "";
    let calledBody = null;

    const mockFetch = async (url, options) => {
      calledUrl = url;
      calledBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(AI_IDEAS) }],
              },
            },
          ],
        }),
      };
    };

    const client = createGeminiClient({ apiKey: "test-gemini-key", fetchFn: mockFetch });
    const text = await client.generateContent({
      model: "gemini-2.5-flash-lite",
      systemPrompt: "You are an assistant",
      prompt: "Hello",
      schema: { type: "OBJECT" },
    });

    assert.ok(calledUrl.includes("models/gemini-2.5-flash-lite:generateContent"));
    assert.ok(calledUrl.includes("key=test-gemini-key"));
    assert.equal(calledBody.systemInstruction.parts[0].text, "You are an assistant");
    assert.equal(calledBody.contents[0].parts[0].text, "Hello");
    assert.equal(calledBody.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(JSON.parse(text), AI_IDEAS);
  });

  test("handles non-gemini model name by falling back to flash-lite", async () => {
    let calledUrl = "";
    const mockFetch = async (url) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(AI_IDEAS) }] } }],
        }),
      };
    };

    const client = createGeminiClient({ apiKey: "key", fetchFn: mockFetch });
    await client.generateContent({ model: "other-model", systemPrompt: "sys", prompt: "user" });
    assert.ok(calledUrl.includes("models/gemini-2.5-flash-lite:generateContent"));
  });

  test("throws formatted error on non-ok API response", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: { message: "Invalid argument", code: 400 } }),
    });

    const client = createGeminiClient({ apiKey: "key", fetchFn: mockFetch });
    await assert.rejects(
      () => client.generateContent({ systemPrompt: "sys", prompt: "user" }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /Invalid argument/);
        return true;
      },
    );
  });

  test("handles non-JSON error response", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error("not JSON"); },
    });

    const client = createGeminiClient({ apiKey: "key", fetchFn: mockFetch });
    await assert.rejects(
      () => client.generateContent({ systemPrompt: "sys", prompt: "user" }),
      (err) => {
        assert.equal(err.status, 502);
        assert.match(err.message, /HTTP 502/);
        return true;
      },
    );
  });

  test("handles empty candidate text error", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    const client = createGeminiClient({ apiKey: "key", fetchFn: mockFetch });
    await assert.rejects(
      () => client.generateContent({ systemPrompt: "sys", prompt: "user" }),
      /Empty candidate response/,
    );
  });
});

describe("Gemini ideas generation integration", () => {
  test("generates and parses ideas via Gemini client in createIdeasService", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(AI_IDEAS) }] } }],
      }),
    });

    const client = createGeminiClient({ apiKey: "gemini-key", fetchFn: mockFetch });
    const service = createIdeasService({ client, model: "gemini-2.5-flash-lite" });
    assert.equal(service.enabled, true);

    const input = request({ vibe: "relaxed", notes: "Mocktail bar" });
    const plan = buildPlan(input, { now: NOW });
    const result = await service.getIdeas(input, plan);

    assert.equal(result.source, "ai");
    assert.deepEqual(result.ideas, AI_IDEAS);
  });

  test("describeFailure handles HTTP error statuses", () => {
    assert.equal(describeFailure({ status: 429 }), "AI service is busy");
    assert.equal(describeFailure({ status: 401 }), "AI service is not authorized");
    assert.equal(describeFailure({ status: 403 }), "AI service is not authorized");
    assert.equal(describeFailure({ name: "TimeoutError" }), "AI service is unreachable");
    assert.equal(describeFailure({ status: 500 }), "AI service error");
    assert.equal(describeFailure(new Error("Random")), "AI response could not be used");
  });

  test("createAppFromEnv wires Gemini client when GEMINI_API_KEY is present", () => {
    const { ideasService, config } = createAppFromEnv({ GEMINI_API_KEY: "gemini-key" });
    assert.equal(ideasService.enabled, true);
    assert.equal(config.hasCredentials, true);
  });
});
