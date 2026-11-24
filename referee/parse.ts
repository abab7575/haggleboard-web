import { findBrandInText } from "./brands.js";
import { canonicalBrand } from "./brands.js";
import { canonicalSize, detectGender, normalizeGender } from "./attributes.js";
import { currencyFromToken } from "./money.js";
import type { NeedInput, ResolvedNeed } from "./types.js";

const STOPWORDS =
  /\b(women's|womens|men's|mens|unisex|kids|youth|wmns|ladies|cheapest|cheap|best|price|for|a|an|the|in|of|with|please|find|show|me|pair|pairs|running|shoe|shoes|sneakers|under|size|us|uk|eu)\b/gi;

/** Shopper phrasing around a product name: "I'm looking for", "I want to buy", "can you find me". */
const REQUEST_PHRASING =
  /\b(i'm|im|i am|i|we're|we are|we|looking|look|want|wanted|wanting|need|needs|buy|buying|get|getting|these|this|those|some|to|my|our|can|could|you|would|like|any|anyone|have|has|got|hi|hello|hey|pls|thanks|thank)\b/gi;

/** Removes emails, links, phone numbers and @handles, so they never become part of a product name. */
export function stripContactDetails(value: string): string {
  return value
    .replace(/\S+@\S+/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|co|uk|ie|de|fr|example)\b\S*/gi, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
    .replace(/(^|\s)@\w+/g, " ");
}

export function parseFreeText(text: string): ResolvedNeed {
  const cleaned = text.replace(/[’‘]/g, "'");
  const gtin = gtinFromText(cleaned);
  let working = stripContactDetails(gtin ? cleaned.replace(gtin, " ") : cleaned);
  const detected = detectGender(cleaned);
  const gender = detected === "unknown" ? null : detected;

  let currency: string | null = null;
  let max_price_cents: number | null = null;
  const price = working.match(
    /\bunder\s*([$£€]|usd|gbp|eur|sgd|cad)?\s*(\d+(?:\.\d{1,2})?)(?:\s*(dollars|usd|pounds|gbp|euros|eur))?\b/i,
  );
  if (price?.[2]) {
    currency = currencyFromToken(price[1]) ?? currencyFromToken(price[3]);
    const amount = Number(price[2]);
    if (Number.isFinite(amount)) max_price_cents = Math.round(amount * 100) - 1;
    working = working.replace(price[0], " ");
  }

  let size: string | null = null;
  const sizeMatch = working.match(/\b(?:size|sz)\s*[:#-]?\s*(?:(us|uk|eu)\s*)?(\d+(?:\.\d+)?)\b/i);
  if (sizeMatch?.[2]) {
    size = canonicalSize(sizeMatch[2]);
    working = working.replace(sizeMatch[0], " ");
  }

  let brand: string | null = null;
  const brandHit = findBrandInText(working);
  if (brandHit) {
    brand = brandHit.name;
    working = `${working.slice(0, brandHit.start)} ${working.slice(brandHit.end)}`;
  }

  const model =
    working
      .replace(REQUEST_PHRASING, " ")
      .replace(STOPWORDS, " ")
      .replace(/[^a-zA-Z0-9.+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null;

  return {
    text: cleaned.trim() || null,
    brand,
    model,
    gender,
    size,
    max_price_cents,
    currency,
    region: null,
    country: null,
    gtin,
    color: null,
    attributes: {},
    quantity: 1,
    category: null,
    holding: null,
  };
}

/** A bare 8, 12, 13 or 14 digit run with a valid GS1 check digit. */
function gtinFromText(text: string): string | null {
  for (const match of text.matchAll(/\b(\d{8}|\d{12,14})\b/g)) {
    const value = normalizeGtin(match[1]!);
    if (value) return value;
  }
  return null;
}

/** Returns the digits when the GS1 check digit is right, otherwise null. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[\s-]/g, "");
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return null;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits.at(-1)) ? digits : null;
}

export function parseNeed(input: NeedInput): ResolvedNeed {
  const fromText = parseFreeText(input.text ?? "");
  const maxFromField =
    input.max_price != null && Number.isFinite(input.max_price) ? Math.round(input.max_price * 100) : null;
  return {
    text: input.text?.trim() || fromText.text,
    brand: input.brand?.trim() ? canonicalBrand(input.brand) : fromText.brand,
    model: input.model?.trim() ? input.model.trim() : fromText.model,
    gender: input.gender?.trim() ? normalizeGender(input.gender) : fromText.gender,
    size: input.size?.trim() ? canonicalSize(input.size) : fromText.size,
    max_price_cents: maxFromField ?? fromText.max_price_cents,
    currency: input.currency?.trim() ? input.currency.trim().toUpperCase() : fromText.currency,
    region: emptyToNull(input.region),
    country: emptyToNull(input.country),
    gtin: input.gtin?.trim() ? normalizeGtin(input.gtin) : fromText.gtin,
    color: emptyToNull(input.color),
    attributes: cleanAttributes(input.attributes),
    quantity: input.quantity != null && Number.isInteger(input.quantity) && input.quantity > 0 ? input.quantity : 1,
    category: emptyToNull(input.category)?.toLowerCase() ?? null,
    holding: input.holding
      ? {
          seller: emptyToNull(input.holding.seller),
          price_cents: Math.round(input.holding.price * 100),
          currency: input.holding.currency.trim().toUpperCase(),
          delivered: input.holding.delivered === true,
          delivery_by: emptyToNull(input.holding.delivery_by),
        }
      : null,
  };
}

function cleanAttributes(value: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const k = key.trim().toLowerCase();
    const v = typeof raw === "string" ? raw.trim() : "";
    if (k && v) out[k] = v;
  }
  return out;
}

/** Fills fields added after a need was stored, so older rows still read. */
export function normalizeStoredNeed(value: Partial<ResolvedNeed>): ResolvedNeed {
  return {
    text: value.text ?? null,
    brand: value.brand ?? null,
    model: value.model ?? null,
    gender: value.gender ?? null,
    size: value.size ?? null,
    max_price_cents: value.max_price_cents ?? null,
    currency: value.currency ?? null,
    region: value.region ?? null,
    country: value.country ?? null,
    gtin: value.gtin ?? null,
    color: value.color ?? null,
    attributes: value.attributes ?? {},
    quantity: value.quantity ?? 1,
    category: value.category ?? null,
    holding: value.holding ?? null,
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function needIsEmpty(need: ResolvedNeed): boolean {
  return !need.text && !need.brand && !need.model && !need.size && !need.gtin && need.max_price_cents == null;
}
