import { rowStatus } from "./home/live-strip";
import type { LiveRow } from "../lib/home-live";
import type { BoardRow } from "../lib/service";

export type BoardExtra = { live?: LiveRow; test?: boolean };

function money(price: string, currency: string): string {
  const amount = Number(price);
  if (/^[A-Z]{3}$/.test(currency) && currency !== "UNK" && Number.isFinite(amount)) {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
    } catch {
      // fall through
    }
  }
  return `${price} ${currency}`;
}

/** Renders public board rows. It only receives BoardRow and public live status, which have no private field. */
export function BoardList({ rows, extra = {} }: { rows: BoardRow[]; extra?: Record<string, BoardExtra> }) {
  if (rows.length === 0) {
    return (
      <div className="board-empty">
        <p>No requests on the board yet.</p>
        <a className="button" href="/">
          Post the first one
        </a>
      </div>
    );
  }
  return (
    <ol className="board-grid">
      {rows.map((row) => {
        const info = extra[row.id] ?? {};
        const live = info.live;
        const status = live?.status ?? "no_auction";
        // One line per store: its best public price (rows arrive ranked).
        const prices = row.prices.filter((price, i, all) => all.findIndex((p) => p.store_domain === price.store_domain) === i);
        return (
          <li className={`board-card board-card--${status}`} key={row.id}>
            <div className="board-card-top">
              <span className={`live-status live-status--${status}`}>
                {status === "open" ? "Live" : status === "closed" ? "Closed" : status === "closing" ? "Closing" : "Listed"}
              </span>
              {info.test ? (
                <span className="board-test" title="Posted by our own tests or tools. Not counted in any number.">
                  test post
                </span>
              ) : null}
              <time dateTime={row.created_at}>{row.created_at.slice(0, 16).replace("T", " ")} UTC</time>
            </div>
            <p className="board-card-title">
              <a href={row.url}>{row.need.label}</a>
            </p>
            <p className="board-card-status">
              {live
                ? rowStatus(live)
                : row.stores_answered === 0
                  ? "no store has answered yet"
                  : `${row.stores_answered} store${row.stores_answered === 1 ? "" : "s"} answered`}
            </p>
            {prices.length > 0 ? (
              <ul className="board-prices">
                {prices.slice(0, 3).map((price, index) => (
                  <li key={`${price.product_url}-${index}`}>
                    <a href={price.product_url} rel="noopener noreferrer nofollow">
                      {price.store_domain.replace(/^www\./, "")}
                    </a>
                    <span className="board-price">
                      {money(price.price, price.currency)}
                      {price.available ? "" : " (sold out)"}
                    </span>
                  </li>
                ))}
                {prices.length > 3 ? <li className="meta">and {prices.length - 3} more</li> : null}
              </ul>
            ) : null}
            <p className="board-card-foot meta">
              Public prices, observed {row.prices[0]?.observed_at.slice(0, 10) ?? "when stores answer"}.{" "}
              <a href={row.url}>{status === "open" ? "Watch it live" : "See the auction"}</a>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
