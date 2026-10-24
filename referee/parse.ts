import { findBrandInText } from "./brands.js";
import { canonicalBrand } from "./brands.js";
import { canonicalSize, detectGender, normalizeGender } from "./attributes.js";
import { currencyFromToken } from "./money.js";
import type { NeedInput, ResolvedNeed } from "./types.js";

const STOPWORDS =
  /\b(women's|womens|men's|mens|unisex|kids|youth|wmns|ladies|cheapest|cheap|best|price|for|a|an|the|in|of|with|please|find|show|me|pair|pairs|running|shoe|shoes|sneakers|under|size|us|uk|eu)\b/gi;

export function parseFreeText(text: string): ResolvedNeed {
  const cleaned = text.replace(/[’‘]/g, "'");
  let working = cleaned;
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
  };
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
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function needIsEmpty(need: ResolvedNeed): boolean {
  return !need.text && !need.brand && !need.model && !need.size && need.max_price_cents == null;
}
