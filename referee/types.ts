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
};

export type ResolvedNeed = {
  text: string | null;
  brand: string | null;
  model: string | null;
  gender: Gender | null;
  size: string | null;
  max_price_cents: number | null;
  currency: string | null;
  region: string | null;
  country: string | null;
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
};
