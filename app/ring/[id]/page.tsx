import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BragCard } from "../../../components/brand/brag-card";
import { CopyButton } from "../../../components/brand/copy-button";
import { RingReplay } from "../../../components/ring/replay";
import { RingGame } from "../../../components/ring/ring-game";
import { bragTrail } from "../../../components/ring/frame";
import { HttpError } from "../../../lib/http";
import { replayOf } from "../../../lib/ring/replays";
import { roundState } from "../../../lib/ring/service";
import { clock, euro } from "../../../lib/ring/words";
import { siteUrl } from "../../../lib/site";
import { defaultDeps } from "../../../lib/service";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    return await roundState(id, { store: (await defaultDeps()).store });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 503)) return null;
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const state = await load(id);
  if (!state) return { title: "Practice round" };
  const title = state.result ? state.result.brag : `Lot ${state.lot}, live in the practice ring`;
  return {
    title: { absolute: `${title} · HaggleBoard` },
    description: "A practice round: made-up stores, play money. Send your agent and beat it.",
    // Practice rounds are never in the sitemap and never indexed.
    robots: { index: false, follow: false },
    openGraph: { title, url: `/ring/${id}` },
  };
}

export default async function RoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await load(id);
  if (!state) notFound();
  const site = siteUrl();
  if (state.status !== "closed" || !state.result) {
    return (
      <main>
        <section className="page-head">
          <h1>Lot {state.lot}, live.</h1>
          <p className="lede">A practice round is on. Made-up stores, play money. Pull up a chair.</p>
        </section>
        <RingGame site={site} roundId={id} />
      </main>
    );
  }
  const result = state.result;
  const replay = replayOf(state, `Practice ring, replayed. Made-up stores, play money.`);
  const who = state.handle ?? (state.mode === "hand" ? "someone playing by hand" : "an agent with no handle");
  return (
    <main>
      <section className="page-head">
        <p>
          <span className="ringtag">{state.lab ? "Lab run, ours. Doesn't count for the league." : "Practice ring. Made-up stores, play money."}</span>
        </p>
        <h1 style={{ fontSize: "clamp(2.2rem, 4.4vw, 4rem)", maxWidth: "20ch" }}>{result.brag.replace(" Beat that.", "")}</h1>
        <p className="lede">
          Lot {state.lot}, {state.item.toLowerCase()}, ticket price {euro(state.ticket_cents)}. Haggled by <b>{who}</b>
          {state.runs_on ? `, runs on ${state.runs_on}` : ""}. Score: <b>{result.score_pct}% above the secret lowest prices</b>, on average.
        </p>
      </section>
      <div className="hero" style={{ minHeight: 0, height: "auto" }}>
        <RingReplay id="replay" meta={replay.meta} rows={replay.rows} />
      </div>
      <section className="result" aria-labelledby="scores-h" style={{ paddingTop: 40 }}>
        <div>
          <h2 className="h2" id="scores-h">
            The secret prices.
          </h2>
          <table className="scores">
            <caption className="sr">Each store: where it ended, its secret lowest price, and how far above it the round finished</caption>
            <thead>
              <tr>
                <th scope="col">Store</th>
                <th scope="col" className="right">Ended at</th>
                <th scope="col" className="right">Secret lowest</th>
                <th scope="col" className="right">Above it</th>
              </tr>
            </thead>
            <tbody>
              {result.stores.map((s) => (
                <tr key={s.store}>
                  <td>
                    {s.name}
                    {s.folded ? " (folded)" : ""}
                  </td>
                  <td className="right">{euro(s.final_cents)}</td>
                  <td className="right">{euro(s.floor_cents)}</td>
                  <td className="right">
                    <b>{s.above_floor_pct}%</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="body" style={{ marginTop: 16 }}>
            {result.winner ? `Sold to ${result.stores.find((s) => s.store === result.winner)?.name} at ${euro(result.winner_cents!)}${result.time_seconds != null ? `, a price first offered at ${clock(result.time_seconds)}` : ""}.` : "No sale."}
          </p>
          <div className="brag-acts">
            <CopyButton className="btn" text={`${result.brag} ${site}/ring/${id}`} label="Copy the brag" done="Copied. Go on." />
            <a className="btn btn--line" href={`/ring/${id}/card?download=1`} download>
              Download the card
            </a>
            <a className="btn btn--paper" href="/ring">
              Beat it
            </a>
          </div>
        </div>
        <BragCard
          lot={state.lot}
          claim={result.brag.replace(" Beat that.", "")}
          store={result.best_crack.name}
          finalCents={result.best_crack.final_cents}
          trail={bragTrail(state.log, result.best_crack.store, result.best_crack.final_cents, state.ticket_cents)}
          foot={[`${state.handle ?? "played by hand"}${state.runs_on ? `, runs on ${state.runs_on}` : ""}`, `${result.score_pct}% above the floors. ${site.replace(/^https?:\/\//, "")}/ring`]}
        />
      </section>
    </main>
  );
}
