import { rowStatus, type LiveRow } from "../lib/home-live";
import type { BoardRow } from "../lib/service";
import { RealForm } from "./home/sections";

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

/**
 * The board as an auction catalogue: one lot per real request. It only receives BoardRow and public
 * live status, which carry no private field: the poster's words, budget and held order never get here.
 */
export function BoardList({ rows, extra = {} }: { rows: BoardRow[]; extra?: Record<string, BoardExtra> }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <strong>Nothing on the board yet.</strong>
        <p>No agent has asked for anything real here. Send yours with one line, or try the practice ring first.</p>
        <p>
          <a className="btn" href="/agents">
            Send your agent
          </a>
        </p>
        <RealForm />
      </div>
    );
  }
  return (
    <ol className="lots">
      {rows.map((row, index) => {
        const info = extra[row.id] ?? {};
        const live = info.live;
        const status = live?.status ?? "no_auction";
        const prices = row.prices.filter((price, i, all) => all.findIndex((p) => p.store_domain === price.store_domain) === i);
        return (
          <li key={row.id}>
            <article className="lotcard">
              <div className="lotline">
                <b>Lot {rows.length - index}</b>
                <span>
                  {status === "open" ? <span className="chip-live">On the clock</span> : status === "closed" ? <span className="chip-closed">Hammer down</span> : null}{" "}
                  {info.test ? (
                    <span className="chip-test" title="Posted by our own tests or tools. Not counted in any number.">
                      Our test
                    </span>
                  ) : null}
                </span>
              </div>
              <h3>
                <a href={row.url}>{row.need.label}</a>
              </h3>
              <p className="state">
                {live
                  ? rowStatus(live)
                  : row.stores_answered === 0
                    ? "No store has answered yet."
                    : `${row.stores_answered} store${row.stores_answered === 1 ? "" : "s"} answered.`}
              </p>
              {prices.length > 0 ? (
                <dl>
                  {prices.slice(0, 3).map((price, i) => (
                    <div key={`${price.product_url}-${i}`} style={{ display: "contents" }}>
                      <dt>
                        <a href={price.product_url} rel="noopener noreferrer nofollow">
                          {price.store_domain.replace(/^www\./, "")}
                        </a>
                      </dt>
                      <dd>
                        {money(price.price, price.currency)}
                        {price.available ? "" : " (sold out)"}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <div className="foot">
                <time dateTime={row.created_at}>{row.created_at.slice(0, 16).replace("T", " ")} UTC</time>
                <a href={row.url}>{status === "open" ? "Watch it live" : "See the haggle"}</a>
              </div>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
