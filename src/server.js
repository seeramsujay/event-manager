import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { createIdeasService, DEFAULT_MODEL } from "./ai/ideas.js";
import { RateLimiter } from "./lib/rateLimiter.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// The key stays on the server; the browser only ever talks to this app.
const client = hasCredentials ? new Anthropic({ timeout: 60_000, maxRetries: 1 }) : null;
const ideasService = createIdeasService({ client, model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL });
const rateLimiter = new RateLimiter({ limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20) });

const server = createServer(createApp({ ideasService, rateLimiter }));
server.requestTimeout = 90_000;
server.listen(port, host, () => {
  console.log(`Event planner running at http://${host}:${port} (AI ideas: ${client ? "on" : "off — curated mode"})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
