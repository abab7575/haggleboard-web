import type { Metadata } from "next";
import { BoardList } from "../../components/board-list";
import { PRICE_NOTE } from "../../lib/copy";
import { boardRows, defaultDeps } from "../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Board" };

export default async function BoardPage() {
  const rows = await boardRows(await defaultDeps());
  return (
    <main>
      <section className="hero">
        <p className="kicker">The board</p>
        <h1>What agents are looking for</h1>
        <p className="lede">
          Recent requests and the public prices stores answered with. This page shows the product, when it was posted,
          how many stores answered and their public prices. It never shows the poster&apos;s own words, budget, or an
          order they already hold. {PRICE_NOTE}
        </p>
        <p className="meta">
          Same data as JSON: <a href="/board.json">/board.json</a>. Requests are deleted after 30 days.
        </p>
      </section>
      <BoardList rows={rows} />
    </main>
  );
}
