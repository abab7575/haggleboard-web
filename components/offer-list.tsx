import { PRICE_NOTE } from "../lib/copy";
import { genderLabel } from "../referee/attributes";
import { formatMoney } from "../referee/money";
import type { PublicOffer } from "../referee/types";

export function OfferList({ offers, omitted = 0 }: { offers: PublicOffer[]; omitted?: number }) {
  if (offers.length === 0) {
    return (
      <p className="empty">
        No matching public listings in this snapshot.
        {omitted > 0 ? ` ${omitted} sold-out listing${omitted === 1 ? "" : "s"} hidden.` : ""}
      </p>
    );
  }
  return (
    <>
      <ol className="offers">
        {offers.map((offer, index) => (
          <li className="offer" key={`${offer.product_url}-${offer.source}-${index}`}>
            <p className="price">
              {formatMoney(offer.price_cents, offer.currency)}
              {offer.compare_at_cents != null && offer.compare_at_cents > offer.price_cents ? (
                <span className="compare">{formatMoney(offer.compare_at_cents, offer.currency)}</span>
              ) : null}
            </p>
            <div>
              <p className="title">{offer.title || `${offer.brand} ${offer.model}`}</p>
              <p className="meta">
                {offer.store_domain}
                {" · "}
                {genderLabel(offer.gender)}
                {offer.size ? ` · size ${offer.size}` : ""}
                {offer.color ? ` · ${offer.color}` : ""}
                {" · "}
                {offer.available ? "in stock" : "sold out"}
                {" · "}
                {offer.source === "bid" ? (offer.verified ? "store bid" : "unverified") : "public listing"}
                {" · "}
                observed {offer.observed_at.slice(0, 10)}
              </p>
              <p className="meta">{PRICE_NOTE}</p>
              {offer.shipping || offer.delivery_days != null || offer.returns_days != null ? (
                <p className="meta">
                  {[
                    offer.shipping,
                    offer.delivery_days != null ? `${offer.delivery_days} day delivery` : null,
                    offer.returns_days != null ? `${offer.returns_days} day returns` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              {offer.note ? <p className="meta">{offer.note}</p> : null}
            </div>
            <a className="checkout" href={offer.product_url} rel="noopener noreferrer">
              Checkout on this store&apos;s site
            </a>
          </li>
        ))}
      </ol>
      {omitted > 0 ? <p className="meta">{omitted} sold-out listing{omitted === 1 ? "" : "s"} hidden.</p> : null}
    </>
  );
}
