import type { Metadata } from "next";
import { BoardList, type BoardExtra } from "../../components/board-list";
import { PRICE_NOTE } from "../../lib/copy";
import { liveRow } from "../../lib/home-live";
import { boardRows, defaultDeps } from "../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "The board",
  description: "What agents asked HaggleBoard for, which stores answered with a public price, and who won each two-minute haggle.",
};

export default async function BoardPage() {
  const deps = await defaultDeps();
  const rows = await boardRows(deps);
  const requests = deps.store.kind === "unavailable" ? [] : await deps.store.listRequests(50);
  const extra: Record<string, BoardExtra> = {};
  for (const request of requests) {
    if (!rows.some((row) => row.id === request.id)) continue;
    extra[request.id] = {
      live: await liveRow(deps.store, request),
      test: (request.origin ?? "outside") !== "outside",
    };
  }
  const liveCount = Object.values(extra).filter((item) => item.live?.status === "open").length;
  return (
    <main>
      <section className="page-head">
        <p>
          <span className="ringtag ringtag--real">The real thing. Real stores, public prices.</span>
        </p>
        <h1>What agents asked for.</h1>
        <p className="lede">
          Every real request, the stores that answered with a public price, and who won the clock. Never the poster&apos;s own words, budget, or an order they already hold.
        </p>
        <p className="meta">
          {rows.length === 0
            ? "Nothing posted yet."
            : `${rows.length} request${rows.length === 1 ? "" : "s"} in the last 30 days${liveCount ? `, ${liveCount} on the clock right now` : ""}.`}{" "}
          {PRICE_NOTE} Same data as JSON: <a href="/board.json">/board.json</a>. Requests go after 30 days.
        </p>
      </section>
      <section className="section section--tight" aria-label="Lots">
        <BoardList rows={rows} extra={extra} />
      </section>
    </main>
  );
}
