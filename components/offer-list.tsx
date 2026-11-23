import { genderLabel } from "../referee/attributes";
import { formatMoney } from "../referee/money";
import type { PublicOffer } from "../referee/types";

/** Public prices for a product, as catalogue lots. Each links to the store's own page. */
export function OfferList({ offers, omitted = 0 }: { offers: PublicOffer[]; omitted?: number }) {
  if (offers.length === 0) {
    return (
      <div className="empty">
        <strong>No public price found.</strong>
        <p>
          Nobody bit, and we couldn&apos;t find a store listing it publicly either.
          {omitted > 0 ? ` ${omitted} sold-out listing${omitted === 1 ? "" : "s"} left out.` : ""}
        </p>
      </div>
    );
  }
  return (
    <>
      <ol className="lots">
        {offers.map((offer, index) => {
          const details = [genderLabel(offer.gender), offer.size ? `size ${offer.size}` : null, offer.color, offer.available ? "in stock" : "sold out"].filter(Boolean).join(", ");
          return (
            <li key={`${offer.product_url}-${offer.source}-${index}`}>
              <article className="lotcard">
                <div className="lotline">
                  <b>{formatMoney(offer.price_cents, offer.currency)}</b>
                  <span>
                    {offer.compare_at_cents != null && offer.compare_at_cents > offer.price_cents ? <s>{formatMoney(offer.compare_at_cents, offer.currency)}</s> : null}{" "}
                    {offer.source === "bid" ? (offer.verified ? "Store bid" : "Unverified") : "Public price"}
                  </span>
                </div>
                <h3 style={{ fontSize: "1.15rem" }}>{offer.title || `${offer.brand} ${offer.model}`}</h3>
                <p className="state" style={{ fontWeight: 500 }}>
                  {offer.store_domain.replace(/^www\./, "")}. {details}. Seen {offer.observed_at.slice(0, 10)}.
                </p>
                {offer.shipping || offer.delivery_days != null || offer.returns_days != null ? (
                  <p className="state" style={{ fontWeight: 500 }}>
                    {[offer.shipping, offer.delivery_days != null ? `${offer.delivery_days} day delivery` : null, offer.returns_days != null ? `${offer.returns_days} day returns` : null].filter(Boolean).join(", ")}
                  </p>
                ) : null}
                {offer.note ? <p className="state" style={{ fontWeight: 500 }}>{offer.note}</p> : null}
                <div className="foot">
                  <span>Checkout on the store&apos;s site</span>
                  <a href={offer.product_url} rel="noopener noreferrer">
                    Go to {offer.store_domain.replace(/^www\./, "")}
                  </a>
                </div>
              </article>
            </li>
          );
        })}
      </ol>
      {omitted > 0 ? <p className="small" style={{ marginTop: 14 }}>{omitted} sold-out listing{omitted === 1 ? "" : "s"} left out.</p> : null}
    </>
  );
}
