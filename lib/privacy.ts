import { genderLabel } from "../referee/attributes.js";
import { centsToDecimal } from "../referee/money.js";
import { stripContactDetails } from "../referee/parse.js";
import type { Holding, HoldingComparison, PublicNeed, PublicOffer, ResolvedNeed } from "../referee/types.js";

/**
 * PUBLIC vs PRIVATE.
 *
 * Public (board page, board feed, request page, public API and MCP reads of someone else's request):
 * that a request exists, what product it is for, when, how many stores answered, each store's
 * public list price, and the outcome.
 *
 * Private (only the posting agent, and later stores that carry the item): the poster's free text,
 * the buyer's maximum price, the held order (seller, price, delivery), country and region, free-form
 * attributes, any store's floor, and the amount of any private offer.
 *
 * Every public surface builds its need with publicNeed() and its offers with publicOffer(). Nothing
 * else from a stored need is allowed out.
 */
export const PRIVATE_NEED_FIELDS = [
  "text",
  "max_price_cents",
  "currency",
  "region",
  "country",
  "attributes",
  "quantity",
  "holding",
] as const;

const MAX_LABEL_PART = 80;

/** Strips things that identify a person: emails, links, phone numbers, @handles. */
export function scrubPublicText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = stripContactDetails(value.replace(/[\u0000-\u001f]/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_PART)
    .trim();
  return cleaned || null;
}

export function publicNeed(need: ResolvedNeed): PublicNeed {
  const brand = scrubPublicText(need.brand);
  const model = scrubPublicText(need.model);
  const color = scrubPublicText(need.color);
  const category = scrubPublicText(need.category);
  const gender = need.gender && need.gender !== "unknown" ? need.gender : null;
  const parts = [
    gender ? genderLabel(gender) : null,
    brand,
    model,
    need.size ? `size ${need.size}` : null,
    color,
  ].filter((part): part is string => Boolean(part));
  let label = parts.join(" ");
  if (!brand && !model && need.gtin) label = [label, `barcode ${need.gtin}`].filter(Boolean).join(" ");
  if (!label) label = category ? `A ${category}` : "A product";
  return {
    label,
    brand,
    model,
    gtin: need.gtin,
    gender,
    size: need.size,
    color,
    category,
  };
}

/** Only the product fields of a need. Public listings match on these, so a private cap cannot be inferred. */
export function productOnly(need: ResolvedNeed): ResolvedNeed {
  return {
    ...need,
    text: null,
    max_price_cents: null,
    currency: null,
    region: null,
    country: null,
    attributes: {},
    quantity: 1,
    holding: null,
  };
}

/** A public offer never carries a comparison with the poster's held order, or a private offer's terms. */
export function publicOffer(offer: PublicOffer): PublicOffer {
  const { vs_holding: _holding, expires_at: _expires, hbp: _hbp, ...rest } = offer;
  return rest;
}

/** How an offer compares with the order the shopper already holds. Poster only. */
export function compareWithHolding(offer: PublicOffer, holding: Holding, quantity: number): HoldingComparison {
  const notes: string[] = [];
  if (offer.currency.toUpperCase() !== holding.currency.toUpperCase()) {
    return {
      beats: null,
      by_cents: null,
      by: null,
      currency: holding.currency,
      note: `Not compared: this offer is in ${offer.currency} and the held order is in ${holding.currency}.`,
    };
  }
  const total = offer.price_cents * Math.max(1, quantity);
  const by = holding.price_cents - total;
  if (quantity > 1) notes.push(`Compared as ${quantity} x ${offer.price} ${offer.currency}.`);
  if (holding.delivered && !offer.shipping) {
    notes.push("The held price includes delivery. This price does not include shipping, so check the store's delivery cost.");
  }
  if (holding.delivery_by && offer.delivery_days == null) {
    notes.push(`The held order arrives by ${holding.delivery_by}. This offer has no delivery date.`);
  }
  if (!offer.available) notes.push("This listing is sold out.");
  return {
    beats: by > 0,
    by_cents: by,
    by: centsToDecimal(by),
    currency: holding.currency,
    note: notes.length ? notes.join(" ") : null,
  };
}
