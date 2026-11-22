import { brandKey } from "./brands.js";
import { genderCompatible, phraseMatch, sizesMatch, tokenize } from "./attributes.js";
import type { CatalogVariant, ResolvedNeed } from "./types.js";

export function variantMatches(variant: CatalogVariant, need: ResolvedNeed, onlyAvailable = true): boolean {
  if (variant.category !== "shoe") return false;
  if (onlyAvailable && !variant.available) return false;
  if (need.brand && brandKey(variant.brand) !== brandKey(need.brand)) return false;
  if (need.model && !phraseMatch(need.model, `${variant.model} ${variant.title}`)) return false;
  if (!genderCompatible(variant.gender, need.gender)) return false;
  if (!sizesMatch(variant, need.size, need.gender)) return false;
  if (need.currency && variant.currency.toUpperCase() !== need.currency.toUpperCase()) return false;
  if (need.max_price_cents != null && variant.price_cents > need.max_price_cents) return false;
  if (need.country && variant.country && variant.country.toLowerCase() !== need.country.toLowerCase()) return false;
  if (need.region && variant.region && variant.region.toLowerCase() !== need.region.toLowerCase()) return false;
  if (!need.brand && !need.model && !need.size) return false;
  return true;
}

export function matchVariants(
  variants: CatalogVariant[],
  need: ResolvedNeed,
  onlyAvailable = true,
): CatalogVariant[] {
  return variants.filter((variant) => variantMatches(variant, need, onlyAvailable));
}

function tokensWithin(query: string, haystack: string): boolean {
  const want = tokenize(query);
  if (want.length === 0) return false;
  const have = new Set(tokenize(haystack));
  return want.every((token) => have.has(token));
}

/**
 * Any product, not only shoes. Used for listings the watcher read from a store's own feed.
 * The brand may sit in the vendor field or the title. Every model word must appear in the listing,
 * so "Ghost 16" never matches "Ghost 17".
 */
export function productMatches(variant: CatalogVariant, need: ResolvedNeed, onlyAvailable = true): boolean {
  if (onlyAvailable && !variant.available) return false;
  if (!need.brand && !need.model) return false;
  const haystack = `${variant.brand} ${variant.model} ${variant.title}`;
  if (need.brand && brandKey(variant.brand) !== brandKey(need.brand) && !phraseMatch(need.brand, haystack)) return false;
  if (need.model && !phraseMatch(need.model, haystack) && !tokensWithin(need.model, haystack)) return false;
  if (!genderCompatible(variant.gender, need.gender)) return false;
  if (!sizesMatch(variant, need.size, need.gender)) return false;
  if (need.color && variant.color && !tokensWithin(need.color, variant.color)) return false;
  if (need.currency && variant.currency.toUpperCase() !== need.currency.toUpperCase()) return false;
  if (need.max_price_cents != null && variant.price_cents > need.max_price_cents) return false;
  return true;
}
