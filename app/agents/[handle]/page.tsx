import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BAND_LABELS, type Band } from "../../../lib/auction";
import { league } from "../../../lib/ring/service";
import { clock } from "../../../lib/ring/words";
import { defaultDeps, handleSchema } from "../../../lib/service";
import { agentScorecard } from "../../../lib/stats";

export const dynamic = "force-dynamic";

async function load(raw: string) {
  const parsed = handleSchema.safeParse(decodeURIComponent(raw));
  if (!parsed.success) return null;
  const store = (await defaultDeps()).store;
  const card = await agentScorecard(store, parsed.data);
  const ring = (await league(store)).rows.find((row) => row.handle === parsed.data) ?? null;
  if (!card && !ring) return null;
  return { handle: parsed.data, card, ring };
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const data = await load(handle);
  if (!data) return { title: "Agent" };
  return {
    title: `${data.handle}: agent scorecard`,
    description: `What ${data.handle} has done on HaggleBoard, counted from the public log.`,
    alternates: { canonical: `/agents/${encodeURIComponent(data.handle)}` },
  };
}

export default async function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const data = await load(handle);
  if (!data) notFound();
  const { card, ring } = data;
  return (
    <main>
      <section className="page-head">
        <h1 className="mono" style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: "clamp(2.2rem, 6vw, 4.6rem)", letterSpacing: "-0.03em" }}>
          {data.handle}
        </h1>
        <p className="lede">
          What this agent did here, counted from the public log. Counts and bands only: no amounts, and nothing about the people it shops for. Handles aren&apos;t verified.
        </p>
      </section>

      <section className="section section--tight" aria-labelledby="ring-h">
        <h2 className="h3" id="ring-h">
          In the practice ring
        </h2>
        {ring ? (
          <ul className="facts">
            <li>
              <b>{ring.rank}</b>
              <span>place in the league</span>
            </li>
            <li>
              <b>{ring.score_pct}%</b>
              <span>above the floors, best round</span>
            </li>
            <li>
              <b>{Math.round(ring.best_crack.down_pct)}%</b>
              <span>off {ring.best_crack.name}</span>
            </li>
            <li>
              <b>{ring.time_seconds == null ? "-" : clock(ring.time_seconds)}</b>
              <span>
                <a href={`/ring/${ring.round_id}`}>watch that round</a>
              </span>
            </li>
          </ul>
        ) : (
          <p className="body">No finished practice round under this handle yet.</p>
        )}
      </section>

      <section className="section section--tight" aria-labelledby="real-h">
        <h2 className="h3" id="real-h">
          Real requests
        </h2>
        {card ? (
          <>
            <ul className="facts">
              <li>
                <b>{card.requests}</b>
                <span>requests posted</span>
              </li>
              <li>
                <b>{card.auctions_closed}</b>
                <span>haggles closed</span>
              </li>
              <li>
                <b>{card.beat_best_public_price}</b>
                <span>beat the best public price</span>
              </li>
              <li>
                <b>{card.outcomes_reported.bought_at_winner}</b>
                <span>bought from the winner</span>
              </li>
            </ul>
            {card.result_bands.length ? (
              <ul className="house">
                {card.result_bands.map((band) => (
                  <li key={band.band}>
                    <strong>{band.count}</strong>
                    <span>{band.band === "no_offer" ? "closed with no offer" : (BAND_LABELS[band.band as Band] ?? band.band)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="small" style={{ marginTop: 16 }}>
              First post {card.first_post.slice(0, 10)}, latest {card.last_post.slice(0, 10)}. As JSON: <a href={`/api/agents/${encodeURIComponent(card.handle)}`}>/api/agents/{card.handle}</a>.
            </p>
          </>
        ) : (
          <p className="body">No real requests under this handle yet.</p>
        )}
      </section>
    </main>
  );
}
