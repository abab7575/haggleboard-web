import type { RequestOrigin } from "./db.js";

/**
 * Where a request came from. Only "outside" requests can ever queue a store notification.
 *
 * "test" when any of these hold:
 *  - the code runs under a test runner (VITEST is set, or NODE_ENV is "test");
 *  - the request was sent to localhost, 127.0.0.1, ::1, or a .test, .local, .localhost or .example host;
 *  - it carries the header X-HaggleBoard-Origin: test.
 *
 * "internal" (our own tooling) when either holds:
 *  - it carries the header X-HaggleBoard-Origin: internal;
 *  - its User-Agent starts with "HaggleBoard-" (our crawler and scripts identify that way).
 *
 * Otherwise "outside". A caller can only use these signals to opt out of notifications, never to
 * cause one, so they do not need to be secret.
 */
export function requestOrigin(req: Request | null, env: NodeJS.ProcessEnv = process.env): RequestOrigin {
  if (runningTests(env)) return "test";
  if (!req) return "outside";
  const declared = req.headers.get("x-haggleboard-origin")?.trim().toLowerCase();
  if (declared === "test") return "test";
  if (declared === "internal") return "internal";
  if (/^haggleboard-/i.test(req.headers.get("user-agent")?.trim() ?? "")) return "internal";
  let host = "";
  try {
    host = new URL(req.url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    /\.(test|local|localhost|example)$/.test(host)
  ) {
    return "test";
  }
  return "outside";
}

export function runningTests(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

/** The origin used when a caller passes none (CLI scripts, direct service calls). */
export function defaultOrigin(env: NodeJS.ProcessEnv = process.env): RequestOrigin {
  return runningTests(env) ? "test" : "internal";
}
