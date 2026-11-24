import { runningTests } from "./origin.js";

/**
 * IndexNow (https://www.indexnow.org): tell participating search engines that a public URL is new.
 * OFF unless INDEXNOW_ENABLED is 1, true or yes AND INDEXNOW_KEY is set (8 to 128 letters, digits or
 * dashes). Never runs under tests. The key file is served at /indexnow-key.txt and passed as
 * keyLocation. Only public pages are submitted (request pages of outside requests, store pages).
 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_KEY_PATH = "/indexnow-key.txt";

export function indexNowKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.INDEXNOW_KEY?.trim();
  return key && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : null;
}

export function indexNowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.INDEXNOW_ENABLED?.trim().toLowerCase();
  return (value === "1" || value === "true" || value === "yes") && indexNowKey(env) != null && !runningTests(env);
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function submitIndexNow(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetcher: FetchLike = (url, init) => fetch(url, init),
): Promise<{ sent: boolean; status: number | null; reason?: string }> {
  if (!indexNowEnabled(env)) return { sent: false, status: null, reason: "off" };
  const site = (env.SITE_URL?.trim() || "https://haggleboard.com").replace(/\/$/, "");
  const host = new URL(site).hostname;
  const urlList = [...new Set(paths)].slice(0, 100).map((p) => (p.startsWith("http") ? p : `${site}${p}`));
  if (urlList.length === 0) return { sent: false, status: null, reason: "nothing to send" };
  const response = await fetcher(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: indexNowKey(env), keyLocation: `${site}${INDEXNOW_KEY_PATH}`, urlList }),
    signal: AbortSignal.timeout(5_000),
  });
  return { sent: true, status: response.status };
}
