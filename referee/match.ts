import { brandKey } from "./brands.js";
import { genderCompatible, phraseMatch, sizesMatch } from "./attributes.js";
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
