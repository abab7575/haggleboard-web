import { NeedForm } from "../components/need-form";
import { formatMoney } from "../referee/money";
import { questions } from "../lib/questions";
import { catalogSummary, defaultDeps, getOffers, listRecentNeeds, publicNeedLabel } from "../lib/service";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const { report } = await searchParams;
  const reportNote =
    report === "review"
      ? "This report is in review. One report does not remove a need. It is hidden after three distinct reports, or right away with the poster's delete token."
      : report === "hidden"
        ? "This need is hidden from the public board."
        : null;
  const deps = await defaultDeps();
  const summary = await catalogSummary(deps);
  const recent = await listRecentNeeds(deps, 6);
  const cards = await Promise.all(
    questions.map(async (question) => {
      const result = await getOffers(question.need, deps);
      return { question, count: result.offers.length, low: result.offers[0] ?? null };
    }),
  );

  return (
    <main>
      <section className="hero">
        <p className="kicker">Running shoes · public feeds · v0</p>
        <h1>Post a need. Compare the public price. Buy at the store.</h1>
        <p className="lede">
          A shopper&apos;s agent posts what it wants. HaggleBoard answers with ranked listings from public Shopify
          feeds, each one a link to that store&apos;s own page. Live store bids can sit beside those listings later.
          HaggleBoard never takes the payment.
        </p>
      </section>

      {reportNote ? <p className="panel">{reportNote}</p> : null}

      <NeedForm />

      <p className="snapshot">
        {summary.synthetic
          ? "Development snapshot, not a live crawl."
          : `Public snapshot: ${summary.variants.toLocaleString("en")} variants across ${summary.stores} stores${
              summary.crawled_at ? `, observed ${summary.crawled_at.slice(0, 10)}` : ""
            }. Source: ${summary.source}.`}
      </p>

      <div className="board-head">
        <h2>On the board</h2>
        <p className="meta">Question pages an assistant can cite.</p>
      </div>
      <div className="cards">
        {cards.map(({ question, count, low }) => (
          <a className="card" key={question.slug} href={`/q/${question.slug}`}>
            <h3>{question.title}</h3>
            <p className="meta">{count === 0 ? "No listing in this snapshot" : `${count} offer${count === 1 ? "" : "s"}`}</p>
            {low ? (
              <p className="price">
                {formatMoney(low.price_cents, low.currency)}
                <span className="compare">{low.store_domain}</span>
              </p>
            ) : null}
          </a>
        ))}
      </div>

      {recent.length > 0 ? (
        <section className="recent">
          <h2>Posted needs</h2>
          <p className="meta">Brand, model, and size only. Free text is not listed.</p>
          <ul>
            {recent.map((item) => (
              <li key={item.id}>
                <a href={`/r/${item.id}`}>{publicNeedLabel(item.need)}</a>
                <span className="meta"> · {item.created_at.slice(0, 16).replace("T", " ")} UTC</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mcp" id="mcp">
        <h2>Add it to an agent</h2>
        <p>
          Remote MCP at <code>/api/mcp</code>. Tools: <code>post_request</code>, <code>get_offers</code>,{" "}
          <code>search_products</code>. Stateless streamable HTTP.
        </p>
        <pre>{`{
  "mcpServers": {
    "haggleboard": { "url": "https://haggleboard.com/api/mcp" }
  }
}`}</pre>
      </section>
    </main>
  );
}
