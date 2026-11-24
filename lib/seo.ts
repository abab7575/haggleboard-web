import { centsToDecimal, formatMoney } from "../referee/money.js";
import type { PublicNeed, PublicOffer } from "../referee/types.js";
import { STALE_AFTER_MS } from "./auction.js";
import { publicOffer } from "./privacy.js";
import { standingWords } from "./stream.js";

/**
 * What a request page says about itself to search engines and agents. Built ONLY from the public
 * need and public offers (publicOffer strips anything poster-only), so nothing private can reach a
 * title, a description or the JSON-LD.
 */
export const PRIVATE_OFFER_HOOK =
  "Stores that claim their listing can make private offers here, which only the posting agent sees. Post through HaggleBoard to get them.";

function mainCurrency(offers: PublicOffer[]): string | null {
  const counts = new Map<string, number>();
  for (const offer of offers) counts.set(offer.currency, (counts.get(offer.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function checkedLabel(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A public price is stale when it was observed more than STALE_AFTER_DAYS before `reference`. */
export function offerIsStale(offer: Pick<PublicOffer, "observed_at">, reference: string | number): boolean {
  const ref = typeof reference === "number" ? reference : Date.parse(reference);
  const seen = Date.parse(offer.observed_at);
  if (!Number.isFinite(seen) || !Number.isFinite(ref)) return true;
  return ref - seen > STALE_AFTER_MS;
}

/**
 * The page's title and summary follow the auction's stale-price rule: the best price is the best
 * price observed within STALE_AFTER_DAYS of the request. When only older prices exist, the summary
 * says "best last-seen price ... seen <date>, not confirmed" instead of "best public price".
 * Offers from stores a live read withdrew are already left out by the caller.
 */
export function requestSummary(
  need: PublicNeed,
  rawOffers: PublicOffer[],
  createdAt: string | null,
  now = Date.now(),
  /** The auction's standing (lib/stream.ts standingCounts). When given, the count comes from it. */
  standing?: { stores: number; real: number; test: number },
) {
  const offers = rawOffers.map(publicOffer);
  const reference = createdAt ?? now;
  const stores = new Set(offers.map((offer) => offer.store_domain)).size;
  const currency = mainCurrency(offers.filter((offer) => offer.available));
  const inCurrency = offers.filter((offer) => offer.available && offer.currency === currency);
  const fresh = inCurrency.filter((offer) => !offerIsStale(offer, reference));
  const pool = fresh.length > 0 ? fresh : inCurrency;
  const best = [...pool].sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
  const bestStale = best != null && fresh.length === 0;
  const checked = offers.map((offer) => offer.observed_at).sort().at(-1) ?? createdAt;
  const parts = [standing ? standingWords(standing) : `${stores} store${stores === 1 ? "" : "s"} answered`];
  if (best && !bestStale) parts.push(`best public price ${formatMoney(best.price_cents, best.currency)}`);
  if (best && bestStale) {
    parts.push(`best last-seen price ${formatMoney(best.price_cents, best.currency)}, seen ${best.observed_at.slice(0, 10)}, not confirmed`);
  }
  if (checked && !bestStale) parts.push(`checked ${checkedLabel(checked)}`);
  return {
    title: `${need.label}: ${parts.join(", ")}`,
    description: `${need.label} on HaggleBoard: ${parts.join(", ")}. ${PRIVATE_OFFER_HOOK}`,
    stores,
    best,
    best_stale: bestStale,
    checked,
  };
}

/**
 * schema.org Product with an AggregateOffer from public prices only (no offers key when none).
 * Stale prices (observed more than STALE_AFTER_DAYS before the request) are left out: machine
 * readers cannot see the "not confirmed" label, so they never get an old price as a current offer.
 */
export function productJsonLd(
  need: PublicNeed,
  rawOffers: PublicOffer[],
  pageUrl: string,
  reference: string | number = Date.now(),
): Record<string, unknown> {
  const offers = rawOffers.map(publicOffer).filter((offer) => !offerIsStale(offer, reference));
  const currency = mainCurrency(offers);
  const priced = offers.filter((offer) => offer.currency === currency);
  const cents = priced.map((offer) => offer.price_cents);
  const product: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: need.label,
    url: pageUrl,
  };
  if (need.brand) product.brand = { "@type": "Brand", name: need.brand };
  if (need.model) product.model = need.model;
  if (need.gtin) product.gtin = need.gtin;
  if (need.color) product.color = need.color;
  if (need.size) product.size = need.size;
  if (priced.length > 0 && currency) {
    product.offers = {
      "@type": "AggregateOffer",
      priceCurrency: currency,
      lowPrice: centsToDecimal(Math.min(...cents)),
      highPrice: centsToDecimal(Math.max(...cents)),
      offerCount: priced.length,
      offers: priced.slice(0, 20).map((offer) => ({
        "@type": "Offer",
        price: offer.price,
        priceCurrency: offer.currency,
        url: offer.product_url,
        availability: offer.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        seller: { "@type": "Organization", name: offer.store_domain },
      })),
    };
  }
  return JSON.parse(JSON.stringify(product)) as Record<string, unknown>;
}

/** Safe to put inside <script type="application/ld+json">. */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
