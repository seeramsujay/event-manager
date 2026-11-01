import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPlan } from "./planner/index.js";
import { validatePlanRequest } from "./validation.js";
import { RateLimiter, clientBucket } from "./lib/rateLimiter.js";
import { createGeocodeService } from "./lib/geocode.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_BODY_BYTES = 16 * 1024; // 16 KB is plenty for any legitimate request

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/**
 * Allow-listed static files, loaded once at startup with a content hash as
 * ETag. No user path ever touches the file system.
 */
function loadStaticFiles() {
  const routes = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js", "/theme.js": "theme.js", "/favicon.svg": "favicon.svg" };
  return new Map(
    Object.entries(routes).map(([route, file]) => {
      const body = readFileSync(path.join(PUBLIC_DIR, file));
      const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 16)}"`;
      return [route, { body, etag, type: CONTENT_TYPES[path.extname(file)] }];
    }),
  );
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Sends a JSON body. Plans contain user data, so API responses are never cached. */
function sendJson(res, status, body, extraHeaders = {}) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extraHeaders });
}

function send(res, status, payload, type, extraHeaders = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extraHeaders });
  res.end(payload);
}

/** Extracts the path without ever throwing: `new URL()` rejects some raw request targets. */
function pathnameOf(req) {
  return (req.url ?? "/").split("?", 1)[0];
}

/**
 * Rate-limit key. Behind a trusted proxy, the client address is the
 * right-most X-Forwarded-For entry: that is the one the proxy itself appended.
 * Entries further left are supplied by the client and can be forged.
 */
function clientKey(req, trustProxy) {
  const forwarded = trustProxy ? req.headers["x-forwarded-for"]?.split(",").at(-1).trim() : "";
  return clientBucket(forwarded || req.socket?.remoteAddress || "unknown");
}

/** True for `application/json`, with any parameters and in any letter case (RFC 9110 §8.3.1). */
function isJsonContentType(header = "") {
  return header.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readJsonBody(req) {
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new HttpError(400, "Body must be valid JSON");
      }
    }
    return req.body;
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
 * Builds the HTTP request listener. Pure wrapper around injected services:
 * tests pass fake AI clients, fake geocode services, clocks and in-memory caches to exercise the
 * full HTTP stack without network access or a real clock.
 *
 * Routes:
 *  - `POST /api/plan`    validated plan request → plan + ideas (rate limited)
 *  - `GET  /api/health`  liveness and whether AI ideas are enabled
 *  - `GET  /api/geocode` reverse geocodes lat/lon to city/region name
 *  - `GET  /`, `/styles.css`, `/app.js`, `/theme.js`, `/favicon.svg` static frontend (ETag / 304)
 *
 * Works both as a Node `http` listener and as a serverless handler: when a
 * platform has already parsed the JSON body into `req.body`, that is used
 * instead of reading the stream.
 *
 * @param {object} deps
 * @param {{ enabled: boolean, getIdeas: Function }} deps.ideasService
 * @param {RateLimiter} [deps.rateLimiter]
 * @param {ReturnType<typeof createGeocodeService>} [deps.geocodeService]
 * @param {() => Date} [deps.now]       Clock, injectable for deterministic tests.
 * @param {boolean} [deps.trustProxy]   Key rate limits on X-Forwarded-For (only behind a trusted proxy).
 * @param {Pick<Console, "error" | "warn">} [deps.logger]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createApp({
  ideasService,
  rateLimiter = new RateLimiter(),
  geocodeService = createGeocodeService(),
  now = () => new Date(),
  trustProxy = false,
  logger = console,
}) {
  const staticFiles = loadStaticFiles();

  async function handlePlan(req, res) {
    const limit = rateLimiter.check(clientKey(req, trustProxy));
    if (!limit.allowed) {
      return sendJson(res, 429, { error: "Too many requests. Please wait a moment." }, { "Retry-After": String(limit.retryAfterSeconds) });
    }

    const body = await readJsonBody(req);
    const clock = now();
    const validation = validatePlanRequest(body, { now: clock });
    if (!validation.success) {
      return sendJson(res, 422, { error: "Please check the highlighted fields.", details: validation.errors });
    }

    const plan = buildPlan(validation.data, { now: clock });
    const ideas = await ideasService.getIdeas(validation.data, plan);
    return sendJson(res, 200, { ...plan, ideas });
  }

  async function handleGeocode(req, res) {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed", { Allow: "GET" });
    const query = (req.url ?? "").split("?")[1] || "";
    const params = new URLSearchParams(query);
    const latStr = params.get("lat");
    const lonStr = params.get("lon");
    if (latStr === null || lonStr === null || latStr === "" || lonStr === "") {
      throw new HttpError(400, "Missing required query parameters: lat and lon");
    }
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new HttpError(400, "Latitude must be a number between -90 and 90");
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new HttpError(400, "Longitude must be a number between -180 and 180");
    }
    try {
      const location = await geocodeService.reverse(lat, lon);
      return sendJson(res, 200, { location });
    } catch (error) {
      logger.warn(`[geocode] reverse geocoding failed: ${error.message}`);
      throw new HttpError(502, "Geocoding service unavailable");
    }
  }

  return async function handler(req, res) {
    try {
      const pathname = pathnameOf(req);
      if (pathname === "/api/plan") {
        if (req.method !== "POST") throw new HttpError(405, "Method not allowed", { Allow: "POST" });
        return await handlePlan(req, res);
      }
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, { status: "ok", ai: ideasService.enabled });
      }
      if (pathname === "/api/geocode") {
        return await handleGeocode(req, res);
      }
      const file = staticFiles.get(pathname);
      if (file && (req.method === "GET" || req.method === "HEAD")) {
        // `no-cache` makes browsers revalidate every time; a matching ETag then
        // costs a 304 with no body instead of a full transfer.
        const headers = { "Cache-Control": "no-cache", ETag: file.etag };
        if (req.headers["if-none-match"] === file.etag) return send(res, 304, "", file.type, headers);
        return send(res, 200, req.method === "HEAD" ? "" : file.body, file.type, headers);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: error.message }, error.headers);
      }
      logger.error("[server] unexpected error", error);
      return sendJson(res, 500, { error: "Something went wrong. Please try again." });
    }
  };
}
