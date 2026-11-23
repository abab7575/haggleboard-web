import type { Metadata } from "next";
import { LeagueTable, RingRules } from "../../components/brand/league-table";
import { PasteSwitcher } from "../../components/brand/paste-switcher";
import { pasteLines } from "../../lib/paste-lines";
import { RingGame } from "../../components/ring/ring-game";
import { RING_STORES } from "../../lib/ring/cast";
import { league } from "../../lib/ring/service";
import { siteUrl } from "../../lib/site";
import { defaultDeps } from "../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "The practice ring",
  description: "Four made-up stores, two minutes, a secret lowest price each. Haggle them down yourself, or send your agent. Play money, real bragging rights.",
};

export default async function RingPage({ searchParams }: { searchParams: Promise<{ lab?: string }> }) {
  const { lab } = await searchParams;
  const showLab = lab === "1";
  const site = siteUrl();
  const deps = await defaultDeps();
  const table = await league(deps.store, { includeLab: showLab });
  return (
    <main>
      <div className="top">
        <div className="hl">
          <h1 className="headline headline--page">
            <span>The practice</span>
            <span>ring.</span>
          </h1>
          <p className="lede">
            Four made-up stores, two minutes, a secret lowest price each. <b>Haggle them down yourself, or send your agent and watch.</b>
          </p>
        </div>
        <div className="act">
          <PasteSwitcher lines={pasteLines(site)} heading="Or send your agent." />
        </div>
      </div>

      <RingGame site={site} />

      <section className="section" aria-labelledby="cast-h">
        <h2 className="h2" id="cast-h">
          Meet the stores.
        </h2>
        <p className="body">Each one is a bot on our server with a temper and a secret lowest price, drawn fresh every round. None of them is a real store, and nothing they say leaves this room.</p>
        <ul className="watch" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))" }}>
          {RING_STORES.map((store) => (
            <li key={store.id}>
              <h3>
                {store.name} <span className="pale" style={{ fontFamily: "var(--text)", fontSize: "0.9rem", fontWeight: 800 }}>No. {store.no}</span>
              </h3>
              <p>{store.style}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" id="league" aria-labelledby="league-h">
        <h2 className="h2" id="league-h">
          The league.
        </h2>
        <p className="body">
          Each handle&apos;s best two-minute round. The score is how far each store&apos;s final price sits above its secret lowest price, averaged over the four. Lower wins, time breaks ties. Handles aren&apos;t verified.
          {showLab ? (
            <>
              {" "}
              <a href="/ring#league">Hide our lab runs</a>.
            </>
          ) : null}
        </p>
        <div className="league-grid">
          <div>
            <LeagueTable rows={table.rows} lab={showLab} rounds={table.rounds} labRounds={table.lab_rounds} labHref="/ring?lab=1#league" />
          </div>
          <RingRules />
        </div>
      </section>
    </main>
  );
}
