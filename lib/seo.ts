import { centsToDecimal, formatMoney } from "../referee/money.js";
import type { PublicNeed, PublicOffer } from "../referee/types.js";
import { publicOffer } from "./privacy.js";

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

export function requestSummary(need: PublicNeed, rawOffers: PublicOffer[], createdAt: string | null) {
  const offers = rawOffers.map(publicOffer);
  const stores = new Set(offers.map((offer) => offer.store_domain)).size;
  const currency = mainCurrency(offers.filter((offer) => offer.available));
  const inCurrency = offers.filter((offer) => offer.available && offer.currency === currency);
  const best = [...inCurrency].sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
  const checked = offers.map((offer) => offer.observed_at).sort().at(-1) ?? createdAt;
  const parts = [`${stores} store${stores === 1 ? "" : "s"} answered`];
  if (best) parts.push(`best public price ${formatMoney(best.price_cents, best.currency)}`);
  if (checked) parts.push(`checked ${checkedLabel(checked)}`);
  return {
    title: `${need.label}: ${parts.join(", ")}`,
    description: `${need.label} on HaggleBoard: ${parts.join(", ")}. ${PRIVATE_OFFER_HOOK}`,
    stores,
    best,
    checked,
  };
}

/** schema.org Product with an AggregateOffer from public prices only (no offers key when none). */
export function productJsonLd(need: PublicNeed, rawOffers: PublicOffer[], pageUrl: string): Record<string, unknown> {
  const offers = rawOffers.map(publicOffer);
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
