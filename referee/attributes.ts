import type { Gender } from "./types.js";

export function tokenize(value: string): string[] {
  const spaced = value
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)(?=[a-z])/g, "$1 ")
    .replace(/([a-z])(?=\d)/g, "$1 ");
  return spaced
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when every query token appears as a contiguous run in the haystack. */
export function phraseMatch(query: string, haystack: string): boolean {
  const q = tokenize(query);
  const h = tokenize(haystack);
  if (q.length === 0) return false;
  for (let i = 0; i <= h.length - q.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) {
      if (h[i + j] !== q[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function detectGender(...parts: string[]): Gender {
  const text = parts.join(" ");
  const women = /\b(women|women's|womens|woman|wmns|ladies|female)\b/i.test(text);
  const men = /\b(men|men's|mens|male)\b/i.test(text);
  const kids = /\b(kids|kid|youth|junior|boys|boy|girls|girl|children|child)\b/i.test(text);
  const unisex = /\bunisex\b/i.test(text);
  if (kids && !women && !men) return "kids";
  if (women && men) return "unisex";
  if (women) return "women";
  if (men) return "men";
  if (unisex) return "unisex";
  return "unknown";
}

export function normalizeGender(value: string | null | undefined): Gender | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/’/g, "'");
  if (["women", "womens", "women's", "woman", "female", "wmns", "ladies"].includes(v)) return "women";
  if (["men", "mens", "men's", "man", "male"].includes(v)) return "men";
  if (v === "unisex") return "unisex";
  if (["kids", "kid", "youth", "junior", "boys", "boy", "girls", "girl", "children"].includes(v)) return "kids";
  return null;
}

export function genderCompatible(variant: Gender, want: Gender | null): boolean {
  if (!want) return true;
  if (want === "kids") return variant === "kids";
  if (want === "unisex") return variant === "unisex" || variant === "unknown";
  if (want === "women") return variant === "women" || variant === "unisex" || variant === "unknown";
  if (want === "men") return variant === "men" || variant === "unisex" || variant === "unknown";
  return true;
}

export type ParsedSize = {
  raw: string;
  size: string | null;
  men: string | null;
  women: string | null;
  width: string | null;
  system: string | null;
};

export function canonicalNumber(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return String(n);
}

export function parseSize(raw: string, systemHint?: string | null): ParsedSize {
  const text = raw.trim();
  const system = systemHint ?? detectSizeSystem(text);
  const split = text.match(
    /m(?:en)?(?:'s)?\s*(\d+(?:\.\d+)?)\s*\/\s*w(?:omen)?(?:'s)?\s*(\d+(?:\.\d+)?)/i,
  );
  if (split?.[1] && split[2]) {
    const men = canonicalNumber(split[1]);
    const women = canonicalNumber(split[2]);
    return { raw: text, size: men, men, women, width: null, system };
  }
  const num = text.match(/(\d+(?:\.\d+)?)(?:\s*([A-Za-z]{1,3}))?/);
  if (!num?.[1]) return { raw: text, size: null, men: null, women: null, width: null, system };
  const size = canonicalNumber(num[1]);
  const letter = num[2]?.toUpperCase() ?? null;
  const width = letter && /^(B|D|E|EE|2E|4E|2A)$/.test(letter) ? letter : null;
  return { raw: text, size, men: null, women: null, width, system };
}

export function canonicalSize(value: string | null | undefined): string | null {
  if (!value) return null;
  return parseSize(value).size;
}

export function detectSizeSystem(text: string): string | null {
  if (/\b(eu|eur|euro)\b/i.test(text)) return "EU";
  if (/\buk\b/i.test(text)) return "UK";
  if (/\bus\b/i.test(text)) return "US";
  return null;
}

export function sizesMatch(
  variant: { size: string | null; size_men: string | null; size_women: string | null; size_raw: string | null },
  requested: string | null,
  gender: Gender | null,
): boolean {
  if (!requested) return true;
  const want = canonicalSize(requested);
  if (!want) return false;
  if (gender === "women" && variant.size_women) return variant.size_women === want;
  if (gender === "men" && variant.size_men) return variant.size_men === want;
  const candidates = [variant.size, variant.size_women, variant.size_men].filter(
    (item): item is string => Boolean(item),
  );
  if (candidates.includes(want)) return true;
  if (variant.size_raw && canonicalSize(variant.size_raw) === want) return true;
  return false;
}

const TRAILING_GENERIC =
  /\b(running|road|trail|shoe|shoes|sneaker|sneakers|trainer|trainers|racer|racing|footwear)\b/gi;

export function modelFromTitle(title: string, brand: string | null): string {
  let s = title.replace(/[’‘]/g, "'");
  if (brand) {
    s = s.replace(new RegExp(escapeRegExp(brand), "ig"), " ");
  }
  s = s.replace(/\b(women's|womens|men's|mens|unisex|kids|kid|youth|wmns|ladies|boys|girls)\b/gi, " ");
  const head = s.split(/\s[-–|]\s/)[0] ?? s;
  return head.replace(TRAILING_GENERIC, " ").replace(/[^a-zA-Z0-9.+]+/g, " ").replace(/\s+/g, " ").trim();
}

const SHOE_WORD =
  /\b(shoes?|sneakers?|footwear|sandals?|spikes?)\b/i;
const NON_SHOE_WORD =
  /\b(socks?|singlets?|shirts?|tees?|t-shirts?|jackets?|tights?|shorts?|bras?|vests?|hoodies?|hats?|visors?|caps?|gloves?|mittens?|bottles?|watches?|headphones?|earbuds?|electronics?|accessories|accessory|headbands?|headwear|belts?|nutrition(?:als)?|gels?|insoles?|laces?|sunglasses|packs?|bags?|gift cards?|hydration|apparel|equipment|safety|pants?|leggings?|tanks?)\b/i;

export function categorize(
  input: { title: string; productType: string; tags: string },
  hasSize = false,
): "shoe" | "other" {
  // Title wins over store tags. Several running shops label every item
  // "Running Shoes" / "New Shoes" even when the product is apparel.
  if (NON_SHOE_WORD.test(input.title) && !SHOE_WORD.test(input.title)) return "other";
  if (SHOE_WORD.test(input.title)) return "shoe";
  const blob = `${input.productType} ${input.tags}`;
  if (NON_SHOE_WORD.test(blob) && !SHOE_WORD.test(blob)) return "other";
  if (SHOE_WORD.test(blob)) return "shoe";
  return hasSize ? "shoe" : "other";
}

export function genderLabel(gender: Gender): string {
  if (gender === "women") return "Women";
  if (gender === "men") return "Men";
  if (gender === "unisex") return "Unisex";
  if (gender === "kids") return "Kids";
  return "Unspecified";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
