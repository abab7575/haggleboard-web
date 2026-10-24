import { categorize, detectGender, detectSizeSystem, modelFromTitle, parseSize } from "../referee/attributes.js";
import { canonicalBrand } from "../referee/brands.js";
import { centsToDecimal, toCents } from "../referee/money.js";
import type { CatalogVariant } from "../referee/types.js";

export type ShopifyOption = { name?: string; position?: number; values?: string[] };
export type ShopifyVariant = {
  id?: number | string;
  title?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  price?: string | number | null;
  compare_at_price?: string | number | null;
  available?: boolean;
};
export type ShopifyProduct = {
  id?: number | string;
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  options?: ShopifyOption[];
  variants?: ShopifyVariant[];
};

export type NormalizeContext = {
  domain: string;
  origin: string;
  currency: string;
  country: string | null;
  region: string | null;
  observedAt: string;
};

type Slot = 1 | 2 | 3;

export function normalizeProduct(product: ShopifyProduct, ctx: NormalizeContext): CatalogVariant[] {
  if (!product.handle || product.id == null || !product.variants) return [];
  const title = (product.title ?? "").trim();
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : (product.tags ?? "");
  const productType = product.product_type ?? "";
  const brand = canonicalBrand((product.vendor ?? "").trim() || title.split(/\s+/)[0] || "Unknown");
  const model = modelFromTitle(title, brand) || title;
  const gender = detectGender(title, tags, productType);
  const slots = optionSlots(product.options ?? []);
  const origin = ctx.origin.replace(/\/$/, "");
  const out: CatalogVariant[] = [];

  for (const variant of product.variants) {
    if (variant.id == null) continue;
    const priceCents = toCents(variant.price);
    if (priceCents == null || priceCents < 0) continue;
    const compareCentsRaw = toCents(variant.compare_at_price);
    const compareCents = compareCentsRaw != null && compareCentsRaw > priceCents ? compareCentsRaw : null;
    const sizeRaw = readSlot(variant, slots.size) ?? sizeFromTitle(variant.title);
    const parsed = parseSize(sizeRaw ?? "", slots.sizeSystem);
    let size = parsed.size;
    if (gender === "women" && parsed.women) size = parsed.women;
    if (gender === "men" && parsed.men) size = parsed.men;
    const color = readSlot(variant, slots.color) ?? colorFromTitle(variant.title, sizeRaw);
    const variantId = String(variant.id);
    out.push({
      category: "other",
      id: `${ctx.domain}:${variantId}`,
      store_domain: ctx.domain,
      shop_origin: origin,
      country: ctx.country,
      region: ctx.region,
      brand,
      model,
      title,
      gender,
      size,
      size_raw: sizeRaw,
      size_system: parsed.system,
      size_men: parsed.men,
      size_women: parsed.women,
      width: parsed.width,
      color,
      available: variant.available === true,
      price: centsToDecimal(priceCents),
      price_cents: priceCents,
      compare_at_price: compareCents == null ? null : centsToDecimal(compareCents),
      compare_at_cents: compareCents,
      currency: ctx.currency.toUpperCase(),
      product_url: `${origin}/products/${encodeURIComponent(product.handle)}?variant=${encodeURIComponent(variantId)}`,
      handle: product.handle,
      external_product_id: String(product.id),
      external_variant_id: variantId,
      observed_at: ctx.observedAt,
    });
  }
  const category = categorize({ title, productType, tags }, out.some((item) => item.size != null));
  for (const item of out) item.category = category;
  return out;
}

export function normalizeProducts(products: ShopifyProduct[], ctx: NormalizeContext): CatalogVariant[] {
  return products.flatMap((product) => normalizeProduct(product, ctx));
}

function optionSlots(options: ShopifyOption[]): {
  size: Slot | null;
  color: Slot | null;
  width: Slot | null;
  sizeSystem: string | null;
} {
  const slots: { size: Slot | null; color: Slot | null; width: Slot | null; sizeSystem: string | null } = {
    size: null,
    color: null,
    width: null,
    sizeSystem: null,
  };
  for (const option of options) {
    const name = option.name ?? "";
    const position = option.position ?? 0;
    if (position < 1 || position > 3) continue;
    const slot = position as Slot;
    if (/width/i.test(name)) slots.width = slot;
    else if (/colou?r/i.test(name)) slots.color = slot;
    else if (/size/i.test(name)) {
      slots.size = slot;
      slots.sizeSystem = detectSizeSystem(name);
    }
  }
  return slots;
}

function readSlot(variant: ShopifyVariant, slot: Slot | null): string | null {
  if (!slot) return null;
  const value = variant[`option${slot}`];
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "default title") return null;
  return text;
}

function sizeFromTitle(title: string | null | undefined): string | null {
  if (!title || title.toLowerCase() === "default title") return null;
  const parts = title.split("/").map((part) => part.trim()).filter(Boolean);
  const sized = parts.find((part) => /\d/.test(part) && part.length <= 24);
  return sized ?? null;
}

function colorFromTitle(title: string | null | undefined, sizeRaw: string | null): string | null {
  if (!title || title.toLowerCase() === "default title") return null;
  const parts = title.split("/").map((part) => part.trim()).filter(Boolean);
  const color = parts.find((part) => part !== sizeRaw && !/^\d/.test(part));
  return color ?? null;
}
