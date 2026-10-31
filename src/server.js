// Entry point for running as a standalone HTTP server.
import { createServer } from "node:http";
import { createAppFromEnv } from "./bootstrap.js";

let app;
try {
  app = createAppFromEnv();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const { config, handler, ideasService } = app;
const server = createServer(handler);
server.requestTimeout = 90_000;
server.listen(config.port, config.host, () => {
  const { port } = server.address();
  const aiMode = ideasService.enabled ? `on, ${config.model}` : "off — curated mode";
  console.log(`Event planner running at http://${config.host}:${port} (AI ideas: ${aiMode})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
