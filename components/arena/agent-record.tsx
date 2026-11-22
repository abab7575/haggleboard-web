import { BAND_LABELS, type Band } from "../../lib/auction";
import type { agentScorecard } from "../../lib/stats";

type Card = NonNullable<Awaited<ReturnType<typeof agentScorecard>>>;

const BAND_ORDER = ["under_20_plus", "under_10_20", "under_5_10", "under_0_5", "at_public", "above_public", "not_compared", "no_public_price", "no_offer"];

function bandWords(band: string): string {
  if (band === "no_offer") return "no store had it in stock";
  return BAND_LABELS[band as Band] ?? band;
}

/**
 * A real agent's public scorecard, from /api/agents/{handle}. Counts and bands only: never an
 * amount, and nothing about anyone else's deal.
 */
export function AgentRecord({ card }: { card: Card }) {
  const bands = [...card.result_bands].sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
  const maxBand = Math.max(1, ...bands.map((b) => b.count));
  return (
    <article className="scorecard scorecard--real" aria-label={`${card.handle} scorecard`}>
      <header className="scorecard-head">
        <h2>{card.handle}</h2>
        <span className="result-card-real">Real record</span>
      </header>
      <dl className="scorecard-stats">
        <div>
          <dt>Requests</dt>
          <dd>{card.requests}</dd>
        </div>
        <div>
          <dt>Auctions closed</dt>
          <dd>{card.auctions_closed}</dd>
        </div>
        <div>
          <dt>Beat the best public price</dt>
          <dd>{card.beat_best_public_price}</dd>
        </div>
        <div>
          <dt>Outcomes reported</dt>
          <dd>{card.outcomes_reported.count}</dd>
        </div>
      </dl>
      {bands.length > 0 ? (
        <div className="record-bands">
          <h3>How its auctions closed</h3>
          <ul>
            {bands.map((item) => (
              <li key={item.band}>
                <span className="record-band-label">{bandWords(item.band)}</span>
                <span className="record-band-bar" aria-hidden="true">
                  <span style={{ width: `${(item.count / maxBand) * 100}%` }} />
                </span>
                <span className="record-band-count">{item.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.outcomes_reported.count > 0 ? (
        <p className="meta">
          Bought at the winner {card.outcomes_reported.bought_at_winner}, bought elsewhere{" "}
          {card.outcomes_reported.bought_elsewhere}, did not buy {card.outcomes_reported.did_not_buy}.
        </p>
      ) : null}
      <p className="meta">
        First post {card.first_post.slice(0, 10)}, last post {card.last_post.slice(0, 10)}. {card.note}
      </p>
    </article>
  );
}
