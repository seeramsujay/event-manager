// Entry point: wires configuration, the Anthropic client and the HTTP server.
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { createIdeasService } from "./ai/ideas.js";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./lib/rateLimiter.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

// The key stays on the server; the browser only ever talks to this app.
// 30 s per attempt and one retry bound the worst case well under the browser timeout.
const client = config.hasCredentials ? new Anthropic({ timeout: 30_000, maxRetries: 1 }) : null;
const ideasService = createIdeasService({ client, model: config.model });
const rateLimiter = new RateLimiter({ limit: config.rateLimitPerMinute });

const server = createServer(createApp({ ideasService, rateLimiter, trustProxy: config.trustProxy }));
server.requestTimeout = 90_000;
server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`Event planner running at http://${config.host}:${port} (AI ideas: ${client ? `on, ${config.model}` : "off — curated mode"})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
