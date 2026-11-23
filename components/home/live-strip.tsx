import type { HomeLive, LiveRow } from "../../lib/home-live";

/** One plain line about where a real request stands. */
export function rowStatus(row: LiveRow): string {
  const count = row.test_stores ? row.standing_words.toLowerCase() : `${row.stores} store${row.stores === 1 ? "" : "s"} in`;
  if (row.status === "open") return `open, ${Math.max(0, row.seconds_left)}s left · ${count}`;
  if (row.status === "closing") return "clock just ran out";
  if (row.status === "no_auction") return row.standing_words;
  if (row.winner && row.result === "last_seen") return `best last-seen price at ${row.winner}, not confirmed today`;
  if (row.winner && row.winner_source !== "public_price") {
    const band = row.band_label && row.band_label !== "private offer" ? `, ${row.band_label}` : "";
    return `won by ${row.winner} with a private offer${band}${row.test_stores ? " (test stores)" : ""}`;
  }
  if (row.winner) return `won by ${row.winner}${row.band_label ? `, ${row.band_label}` : ""}${row.test_stores ? " (test stores)" : ""}`;
  return row.stores === 0 ? "closed, no store answered" : "closed, none in stock";
}

/**
 * The real-numbers strip under the scripted hero. Every number is counted from the event log,
 * outside traffic only. With nothing to count it says so instead of showing zeros as activity.
 */
export function LiveStrip({ live }: { live: HomeLive }) {
  const empty = live.requests === 0 && live.latest.length === 0;
  return (
    <section className="live-strip" aria-labelledby="live-strip-title">
      <header className="live-strip-head">
        <h2 id="live-strip-title">
          <span className="live-dot" aria-hidden="true" />
          Real, not demo
        </h2>
        <p className="meta">
          {live.stored
            ? `Counted from the event log, outside traffic only. Our own tests are left out. As of ${live.asOf.slice(11, 16)} UTC.`
            : "This server keeps no database, so nothing is counted here."}
        </p>
      </header>
      {empty ? (
        <p className="live-strip-empty">
          No real requests yet. Be the first.{" "}
          <a href="#ask-text">Post what you want</a>
        </p>
      ) : (
        <div className="live-strip-body">
          <dl className="live-numbers">
            <div>
              <dt>Requests</dt>
              <dd>{live.requests}</dd>
            </div>
            <div>
              <dt>Stores answered</dt>
              <dd>{live.stores}</dd>
            </div>
            <div>
              <dt>Auctions closed</dt>
              <dd>{live.closed}</dd>
            </div>
            <div>
              <dt>Beat the best public price</dt>
              <dd>
                {live.closedWithWinner === 0 ? "none yet" : `${live.beat} of ${live.closedWithWinner}`}
              </dd>
            </div>
          </dl>
          <div className="live-latest">
            <h3>Latest on the board</h3>
            {live.latest.length === 0 ? (
              <p className="meta">No real requests in the last 30 days. Be the first.</p>
            ) : (
              <ul>
                {live.latest.map((row) => (
                  <li key={row.id}>
                    <a href={row.url}>{row.label}</a>
                    <span className={`live-status live-status--${row.status}`}>{rowStatus(row)}</span>
                  </li>
                ))}
              </ul>
            )}
            <a className="live-more" href="/board">
              The whole board
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
