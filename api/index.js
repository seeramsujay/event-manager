// Serverless entry for Vercel. Every request is rewritten here (see
// vercel.json), and Vercel invokes the export with Node's `req`/`res`, with
// JSON bodies already parsed into `req.body`, which app.js understands.
//
// Vercel terminates TLS and appends the real client address to
// X-Forwarded-For, so the proxy is trusted by default. Any explicit
// TRUST_PROXY setting in the project's environment still wins.
import { createAppFromEnv } from "../src/bootstrap.js";

const { handler } = createAppFromEnv({ TRUST_PROXY: "true", ...process.env });

export default handler;
