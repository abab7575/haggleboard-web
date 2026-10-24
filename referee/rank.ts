import type { PublicOffer } from "./types.js";

function discountCents(offer: PublicOffer): number {
  if (offer.compare_at_cents == null || offer.compare_at_cents <= offer.price_cents) return 0;
  return offer.compare_at_cents - offer.price_cents;
}

/**
 * Available listings first, then currency (never treat mixed currencies as one scale),
 * then lowest price, then larger compare-at gap, then newer observation.
 * The order is deterministic. Nothing can pay to move up.
 */
export function rankOffers(offers: PublicOffer[]): PublicOffer[] {
  return [...offers].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    if (a.price_cents !== b.price_cents) return a.price_cents - b.price_cents;
    const discount = discountCents(b) - discountCents(a);
    if (discount !== 0) return discount;
    if (a.observed_at !== b.observed_at) return a.observed_at < b.observed_at ? 1 : -1;
    const store = a.store_domain.localeCompare(b.store_domain);
    if (store !== 0) return store;
    return a.product_url.localeCompare(b.product_url);
  });
}
