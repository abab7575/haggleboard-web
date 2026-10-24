import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

export function bidsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BID_KEYS_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function newStoreKey(): string {
  return randomBytes(32).toString("base64url");
}

export function newDeleteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** HMAC of the poster's delete token, bound to the request id. The raw token is not stored. */
export function deleteTokenHmac(signingKey: string, requestId: string, rawToken: string): string {
  return createHmac("sha256", signingKey).update(`delete\n${requestId}\n${rawToken}`).digest("hex");
}

/** Separate from the bid signing key and the IP salt. There is no fallback. */
export function deleteTokenKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.DELETE_TOKEN_KEY?.trim();
  if (!key) throw new HttpError(503, "Set DELETE_TOKEN_KEY before storing or removing a need.");
  return key;
}

/** HMAC-SHA256 of the raw key, bound to the store hostname. Hex, never the key itself. */
export function storeKeyHmac(signingKey: string, domain: string, rawKey: string): string {
  return createHmac("sha256", signingKey).update(`${domain.trim().toLowerCase()}\n${rawKey}`).digest("hex");
}

export function hmacEqual(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
