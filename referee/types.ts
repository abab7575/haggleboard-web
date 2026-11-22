export type Gender = "women" | "men" | "unisex" | "kids" | "unknown";

export type CatalogVariant = {
  id: string;
  store_domain: string;
  shop_origin: string;
  country: string | null;
  region: string | null;
  brand: string;
  model: string;
  title: string;
  gender: Gender;
  size: string | null;
  size_raw: string | null;
  size_system: string | null;
  size_men: string | null;
  size_women: string | null;
  width: string | null;
  color: string | null;
  available: boolean;
  price: string;
  price_cents: number;
  compare_at_price: string | null;
  compare_at_cents: number | null;
  currency: string;
  product_url: string;
  handle: string;
  external_product_id: string;
  external_variant_id: string;
  category: "shoe" | "other";
  observed_at: string;
};

export type PublicOffer = {
  store_domain: string;
  brand: string;
  model: string;
  title: string;
  gender: Gender;
  size: string | null;
  color: string | null;
  available: boolean;
  price: string;
  price_cents: number;
  compare_at_price: string | null;
  compare_at_cents: number | null;
  currency: string;
  product_url: string;
  source: "feed" | "bid";
  observed_at: string;
  shipping: string | null;
  delivery_days: number | null;
  returns_days: number | null;
  note: string | null;
  checkout: "store_site";
  /** Null on a public listing. A store bid is true only after its key matches. */
  verified: boolean | null;
  /** Only in the response to the posting agent, and only when the need has a holding. */
  vs_holding?: HoldingComparison;
  /** Private offers under a store rule: when the offer lapses. Poster only. */
  expires_at?: string;
  /** Private offers under a store rule: the HBP-shaped offer message (unsigned). Poster only. */
  hbp?: unknown;
};

/**
 * An order the shopper already holds somewhere else. PRIVATE: only the posting agent sees it
 * (and, later, stores that carry the item). Never on a public page, feed or listing.
 */
export type Holding = {
  seller: string | null;
  /** Total for the quantity in the need, in minor units. */
  price_cents: number;
  currency: string;
  /** True when the held price already includes delivery to the shopper. */
  delivered: boolean;
  /** YYYY-MM-DD */
  delivery_by: string | null;
};

export type ResolvedNeed = {
  /** PRIVATE: the poster's own words. */
  text: string | null;
  brand: string | null;
  model: string | null;
  gender: Gender | null;
  size: string | null;
  /** PRIVATE: the buyer's maximum price. */
  max_price_cents: number | null;
  currency: string | null;
  /** PRIVATE (coarse location of the shopper). */
  region: string | null;
  /** PRIVATE (coarse location of the shopper). */
  country: string | null;
  /** Barcode: GTIN-8, UPC-A (12), EAN-13 or GTIN-14. */
  gtin: string | null;
  color: string | null;
  /** Other variant attributes such as width or storage. PRIVATE because keys and values are free-form. */
  attributes: Record<string, string>;
  quantity: number;
  /** Short product category such as "running shoes" or "coffee grinder". */
  category: string | null;
  /** PRIVATE: see Holding. */
  holding: Holding | null;
};

/** The public part of a need: what product it is for. Nothing that identifies the shopper. */
export type PublicNeed = {
  label: string;
  brand: string | null;
  model: string | null;
  gtin: string | null;
  gender: Gender | null;
  size: string | null;
  color: string | null;
  category: string | null;
};

export type HoldingComparison = {
  /** Null when the two prices cannot be compared (different currency). */
  beats: boolean | null;
  /** Held total minus this offer's total, in minor units. Positive means this offer is cheaper. */
  by_cents: number | null;
  by: string | null;
  currency: string;
  note: string | null;
};

export type HoldingInput = {
  seller?: string | null;
  price: number;
  currency: string;
  delivered?: boolean | null;
  delivery_by?: string | null;
};

export type NeedInput = {
  text?: string | null;
  brand?: string | null;
  model?: string | null;
  gender?: string | null;
  size?: string | null;
  max_price?: number | null;
  currency?: string | null;
  region?: string | null;
  country?: string | null;
  gtin?: string | null;
  color?: string | null;
  attributes?: Record<string, string> | null;
  quantity?: number | null;
  category?: string | null;
  holding?: HoldingInput | null;
};
