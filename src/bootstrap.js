// Wires the production app from environment variables. Shared by the
// standalone server (src/server.js) and the serverless entry (api/index.js),
// so both run exactly the same handler with the same safeguards.
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { createIdeasService } from "./ai/ideas.js";
import { createGeocodeService } from "./lib/geocode.js";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./lib/rateLimiter.js";

/**
 * Builds the request handler and everything it depends on.
 *
 * The Anthropic client reads its credentials from `process.env` as usual; the
 * `env` argument only drives this app's own settings, so tests can pass
 * overrides without touching the process environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ config: import("./config.js").AppConfig,
 *   handler: ReturnType<typeof createApp>,
 *   ideasService: ReturnType<typeof createIdeasService>,
 *   geocodeService: ReturnType<typeof createGeocodeService> }}
 * @throws {Error} when a configuration value is invalid (see config.js)
 */
export function createAppFromEnv(env = process.env) {
  const config = loadConfig(env);
  // 30 s per attempt and one retry bound the worst case well under the browser timeout.
  const client = config.hasCredentials ? new Anthropic({ timeout: 30_000, maxRetries: 1 }) : null;
  const ideasService = createIdeasService({ client, model: config.model });
  const rateLimiter = new RateLimiter({ limit: config.rateLimitPerMinute });
  const geocodeService = createGeocodeService();
  const handler = createApp({ ideasService, rateLimiter, geocodeService, trustProxy: config.trustProxy });
  return { config, handler, ideasService, geocodeService };
}
