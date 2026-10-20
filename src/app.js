import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPlan } from "./planner/index.js";
import { validatePlanRequest } from "./validation.js";
import { RateLimiter } from "./lib/rateLimiter.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/** Allow-listed static files, loaded once at startup. No user path ever touches the file system. */
function loadStaticFiles() {
  const routes = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/favicon.svg": "favicon.svg" };
  return new Map(
    Object.entries(routes).map(([route, file]) => [
      route,
      { body: readFileSync(path.join(PUBLIC_DIR, file)), type: CONTENT_TYPES[path.extname(file)] },
    ]),
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = "application/json; charset=utf-8", extraHeaders = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extraHeaders });
  res.end(payload);
}

async function readJsonBody(req) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

/**
 * Creates the request handler. Dependencies are injected so tests can run the
 * full HTTP stack without network access or a real clock.
 */
export function createApp({ ideasService, rateLimiter = new RateLimiter(), now = () => new Date(), logger = console }) {
  const staticFiles = loadStaticFiles();

  async function handlePlan(req, res) {
    const limit = rateLimiter.check(req.socket.remoteAddress ?? "unknown");
    if (!limit.allowed) {
      return send(res, 429, { error: "Too many requests. Please wait a moment." }, undefined, { "Retry-After": String(limit.retryAfterSeconds) });
    }

    const body = await readJsonBody(req);
    const clock = now();
    const validation = validatePlanRequest(body, { now: clock });
    if (!validation.success) {
      return send(res, 422, { error: "Please check the highlighted fields.", details: validation.errors });
    }

    const plan = buildPlan(validation.data, { now: clock });
    const ideas = await ideasService.getIdeas(validation.data, plan);
    return send(res, 200, { ...plan, ideas });
  }

  return async function handler(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      if (pathname === "/api/plan") {
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
        return await handlePlan(req, res);
      }
      if (pathname === "/api/health" && req.method === "GET") {
        return send(res, 200, { status: "ok", ai: ideasService.enabled });
      }
      const file = staticFiles.get(pathname);
      if (file && (req.method === "GET" || req.method === "HEAD")) {
        return send(res, 200, req.method === "HEAD" ? "" : file.body, file.type, { "Cache-Control": "no-cache" });
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      logger.error("[server] unexpected error", error);
      return send(res, 500, { error: "Something went wrong. Please try again." });
    }
  };
}
