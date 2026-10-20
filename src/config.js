import { DEFAULT_MODEL } from "./ai/ideas.js";

/**
 * @typedef {object} AppConfig
 * @property {number} port                TCP port to listen on (0 = random free port).
 * @property {string} host                Interface to bind; 127.0.0.1 keeps the app local by default.
 * @property {string} model               Claude model id used for idea generation.
 * @property {number} rateLimitPerMinute  Plan requests allowed per client per minute.
 * @property {boolean} trustProxy         Use the first X-Forwarded-For address as the client id.
 * @property {boolean} hasCredentials     Whether Anthropic credentials are present.
 */

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${value}").`);
  }
  return parsed;
}

function boolean(value, name) {
  if (value === undefined || value === "") return false;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false (got "${value}").`);
}

/**
 * Reads and validates configuration from environment variables. Fails fast
 * with a readable message instead of starting with a broken setup.
 * @param {Record<string, string | undefined>} [env]
 * @returns {AppConfig}
 */
export function loadConfig(env = process.env) {
  return {
    port: integer(env.PORT, 3000, 0, 65_535, "PORT"),
    host: env.HOST?.trim() || "127.0.0.1",
    model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    rateLimitPerMinute: integer(env.RATE_LIMIT_PER_MINUTE, 20, 1, 10_000, "RATE_LIMIT_PER_MINUTE"),
    trustProxy: boolean(env.TRUST_PROXY, "TRUST_PROXY"),
    hasCredentials: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  };
}
