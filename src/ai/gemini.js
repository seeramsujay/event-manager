// Zero-dependency Gemini client using Node's native fetch.
// Calls Google Generative AI generateContent endpoint with structured JSON outputs.

/**
 * Creates a Gemini API client.
 * @param {object} options
 * @param {string} options.apiKey
 * @param {number} [options.timeout]
 * @param {typeof fetch} [options.fetchFn]
 */
export function createGeminiClient({ apiKey, timeout = 30_000, fetchFn = globalThis.fetch } = {}) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("GEMINI_API_KEY is required and must be a non-empty string.");
  }

  return {
    type: "gemini",
    apiKey,
    timeout,

    async generateContent({ model = "gemini-2.0-flash-lite", systemPrompt, prompt, schema }) {
      const targetModel = model.startsWith("gemini") ? model : "gemini-2.0-flash-lite";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body = {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.7,
        },
      };

      if (schema) {
        body.generationConfig.responseSchema = schema;
      }

      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        const message = errorJson?.error?.message || `Gemini API error (HTTP ${res.status})`;
        const error = new Error(message);
        error.status = res.status;
        error.code = errorJson?.error?.code;
        throw error;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("Empty candidate response from Gemini API");
      }
      return text;
    },
  };
}
