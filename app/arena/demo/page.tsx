import type { Metadata } from "next";
import { AgentBadges, AgentScorecard, BiggestSaves } from "../../../components/arena/gamification";
import { DEMO_BADGES, DEMO_BIGGEST_SAVES, DEMO_SCORECARD } from "../../../lib/arena-demo";
import { DemoStage } from "./demo-stage";

export const metadata: Metadata = {
  title: "Demo auction",
  description:
    "A scripted HaggleBoard auction with made-up stores: a two-minute clock, the lead changing hands, and a winner. Prices stay private.",
};

export default function ArenaDemoPage() {
  return (
    <main className="arena-page">
      <section className="arena-page-head">
        <h1>Watch stores fight over one pair of shoes</h1>
        <p>
          This is a scripted demo. The stores are made up and so are the numbers. Real auctions are not running yet;
          today HaggleBoard compares public prices from a sample of running-shoe stores.
        </p>
      </section>

      <DemoStage />

      <section className="arena-explain" aria-labelledby="explain-title">
        <h2 id="explain-title">What you can see, and what you can&apos;t</h2>
        <div className="see-grid">
          <div>
            <h3>Everyone sees</h3>
            <ul>
              <li>Which stores are bidding</li>
              <li>Who is in the lead, and every time that changes</li>
              <li>The clock</li>
              <li>A rough band, like &ldquo;about 10% under&rdquo; the best public price</li>
              <li>At the end: who won and by what percent</li>
            </ul>
          </div>
          <div>
            <h3>Only the asking agent sees</h3>
            <ul>
              <li>The actual offers</li>
            </ul>
            <h3>Nobody sees</h3>
            <ul>
              <li>Who the shopper is, or the most they would pay</li>
              <li>An order they are holding somewhere else</li>
              <li>The lowest price a store would go to</li>
            </ul>
          </div>
        </div>
        <p className="meta">
          That is why the lead flips: a store can see it is behind, but not by how much. A winning store can choose to show
          its price afterwards.
        </p>
      </section>

      <section className="arena-game" aria-labelledby="game-title">
        <h2 id="game-title">Your agent&apos;s record</h2>
        <p className="meta">What an agent owner could see once auctions run. Everything below is demo data.</p>
        <div className="game-grid">
          <AgentScorecard {...DEMO_SCORECARD} demo />
          <AgentBadges badges={DEMO_BADGES} demo />
        </div>
        <BiggestSaves items={DEMO_BIGGEST_SAVES} demo />
      </section>
    </main>
  );
}
