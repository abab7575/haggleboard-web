import type { BoardRow } from "../lib/service";

/** Renders public board rows. It only receives BoardRow, which has no private field. */
export function BoardList({ rows }: { rows: BoardRow[] }) {
  if (rows.length === 0) {
    return <p className="empty">No requests on the board yet.</p>;
  }
  return (
    <ol className="board">
      {rows.map((row) => (
        <li className="panel board-row" key={row.id}>
          <p className="title">
            <a href={row.url}>{row.need.label}</a>
          </p>
          <p className="meta">
            Posted {row.created_at.slice(0, 16).replace("T", " ")} UTC
            {" · "}
            {row.stores_answered === 0
              ? "no store has answered yet"
              : `${row.stores_answered} store${row.stores_answered === 1 ? "" : "s"} answered`}
          </p>
          {row.prices.length > 0 ? (
            <ul className="board-prices">
              {row.prices.slice(0, 5).map((price, index) => (
                <li key={`${price.product_url}-${index}`}>
                  <a href={price.product_url} rel="noopener noreferrer">
                    {price.store_domain}
                  </a>
                  {": "}
                  {price.price} {price.currency}
                  {price.available ? "" : " (sold out)"}
                  <span className="meta"> · public price, observed {price.observed_at.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
