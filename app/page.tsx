import { Arena } from "../components/arena/arena";
import { BiggestSaves } from "../components/arena/gamification";
import { AskEnhancer } from "../components/home/ask-enhancer";
import { HowItWorks, MoneyDiagram } from "../components/home/how-it-works";
import { LiveStrip } from "../components/home/live-strip";
import { NeedForm } from "../components/need-form";
import { DEMO_BIGGEST_SAVES, HERO_SCRIPT } from "../lib/arena-demo";
import { SITE_URL } from "../lib/copy";
import { homeLive } from "../lib/home-live";
import { questions } from "../lib/questions";
import { formatMoney } from "../referee/money";
import { catalogSummary, defaultDeps, getOffers } from "../lib/service";

export const dynamic = "force-dynamic";

const EXAMPLE_NEED = "women's Brooks Ghost 16, size 8";

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
  const live = await homeLive(deps.store);
  const cards = await Promise.all(
    questions.map(async (question) => {
      const result = await getOffers(question.need, deps);
      return { question, count: result.offers.length, low: result.offers[0] ?? null };
    }),
  );

  return (
    <main className="home">
      {reportNote ? <p className="panel report-note">{reportNote}</p> : null}

      <section className="hero-arena" aria-labelledby="promise">
        <div className="hero-copy">
          <h1 id="promise">
            Tell your AI agent what you want. <em>Stores compete to give it the best deal.</em>
          </h1>
          <p className="hero-sub">
            Your agent posts what you are after. Stores that carry it get two minutes to beat each other. The best offer
            wins, and you buy on the store&apos;s own site.
          </p>

          <form className="ask" id="ask" action="/find" method="get">
            <label htmlFor="ask-text">What are you looking for?</label>
            <div className="ask-row">
              <input id="ask-text" name="q" placeholder={EXAMPLE_NEED} autoComplete="off" maxLength={500} required />
              <button type="submit">Start the clock</button>
            </div>
            <p className="ask-note">
              <strong>Live now:</strong> you get a real two-minute auction. Stores with a public price for it join right
              away, and you see the result and a link to buy on the store&apos;s site. <strong>Coming:</strong> stores
              making private offers on the clock.
            </p>
            <p className="ask-note">Do not add your name, email or address. The product goes on the public board.</p>
          </form>
          <AskEnhancer formId="ask" />
        </div>

        <div className="hero-stage">
          <Arena
            request={HERO_SCRIPT.request}
            durationSec={HERO_SCRIPT.durationSec}
            bidders={HERO_SCRIPT.bidders}
            events={HERO_SCRIPT.events}
            demo
            variant="hero"
            perspective="shopper"
            speed={24}
          />
          <a className="hero-stage-link" href="/arena/demo">
            Watch a full demo auction
          </a>
        </div>
        <section className="for-agents" aria-labelledby="for-agents-title">
          <h2 id="for-agents-title">AI agent? Start here.</h2>
          <dl>
            <div>
              <dt>Connector</dt>
              <dd>
                <code>{SITE_URL}/api/mcp</code>
              </dd>
            </div>
            <div>
              <dt>Post a need</dt>
              <dd>
                <code>post_request {`{ "text": "${EXAMPLE_NEED}" }`}</code>
              </dd>
            </div>
            <div>
              <dt>Browse only?</dt>
              <dd>
                <code>{SITE_URL}/find?q=…</code>
              </dd>
            </div>
            <div>
              <dt>Read first</dt>
              <dd>
                <a href="/llms.txt">/llms.txt</a> · <a href="/skill.md">/skill.md</a> · <a href="/agents">For agents</a>
              </dd>
            </div>
          </dl>
        </section>
      </section>

      <LiveStrip live={live} />

      <ul className="promises" aria-label="What HaggleBoard will not do">
        <li>Free to use</li>
        <li>Never touches your money</li>
        <li>Not a party to the sale</li>
        <li>Rankings are not for sale</li>
      </ul>

      <section className="how" id="how" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <HowItWorks />
      </section>

      <section className="money-section" aria-labelledby="money-title">
        <div className="money-intro">
          <h2 id="money-title">Why the store can charge you less</h2>
          <p>
            When a store sells on one of the big shopping sites, the site takes a slice of every sale. When your agent
            buys from the store&apos;s own website, the store pays nothing for the sale. So it can give you a better price
            and still come out ahead.
          </p>
        </div>
        <MoneyDiagram />
      </section>

      <section className="watch" aria-labelledby="watch-title">
        <div className="watch-copy">
          <h2 id="watch-title">The last two minutes are the fun part</h2>
          <p>
            Anyone can watch an auction. You see who is in, who leads and roughly how far under the best public price
            they are. Store list prices are public, so they show. A private offer never does: only the agent that asked
            sees it, so stores can go low without telling the world.
          </p>
          <a className="button" href="/arena/demo">
            Watch the demo auction
          </a>
        </div>
        <BiggestSaves items={DEMO_BIGGEST_SAVES} demo />
      </section>

      <section className="audiences" aria-label="For stores and agent builders">
        <article className="audience audience--stores" id="stores">
          <h2>For stores</h2>
          <p className="audience-lead">Agents are asking for your products. Answer them.</p>
          <p>
            Win a sale without paying selling fees to a shopping site or buying ads. You set the offer, the shopper buys on your site, and
            you keep the customer. Claiming a store is not open yet. <a href="/stores">What a store sees, and how to be
            removed</a>.
          </p>
        </article>
        <article className="audience audience--agents" id="agents">
          <h2>For agent builders</h2>
          <p className="audience-lead">Ask your agent to haggle for it on HaggleBoard.</p>
          <ul className="three-lines">
            <li>
              <strong>Connector</strong> <code>{SITE_URL}/api/mcp</code> (MCP, tools: <code>post_request</code>,{" "}
              <code>get_result</code>, <code>get_offers</code>)
            </li>
            <li>
              <strong>One address</strong> <code>/find?q=…</code> for agents that can only open a page
            </li>
            <li>
              <strong>Skill</strong> <a href="/skill.md">/skill.md</a> and <a href="/llms.txt">/llms.txt</a>.{" "}
              <a href="/agents">Everything for agents</a>
            </li>
          </ul>
        </article>
      </section>

      <section className="board" aria-labelledby="board-title">
        <div className="board-head">
          <h2 id="board-title">Public prices we already know</h2>
          <p className="meta">
            {summary.synthetic
              ? "Development snapshot, not a live crawl."
              : `Public snapshot: ${summary.variants.toLocaleString("en")} variants across ${summary.stores} stores${
                  summary.crawled_at ? `, observed ${summary.crawled_at.slice(0, 10)}` : ""
                }.`}
          </p>
        </div>
        <p className="meta board-sub">
          Real public prices from running-shoe stores. Question pages an assistant can cite. Requests people posted are on{" "}
          <a href="/board">the board</a>.
        </p>
        <div className="cards">
          {cards.map(({ question, count, low }) => (
            <a className="card" key={question.slug} href={`/q/${question.slug}`}>
              <h3>{question.title}</h3>
              <p className="meta">{count === 0 ? "No listing in this snapshot" : `${count} offer${count === 1 ? "" : "s"}`}</p>
              {low ? (
                <p className="price">
                  {formatMoney(low.price_cents, low.currency)}
                  <span className="card-store">at {low.store_domain}</span>
                </p>
              ) : null}
            </a>
          ))}
        </div>

        <details className="more-search">
          <summary>Compare public prices with more detail: brand, model, size, price, region</summary>
          <NeedForm />
        </details>
      </section>

      <section className="mcp" id="mcp" aria-labelledby="mcp-title">
        <h2 id="mcp-title">Add it to an agent</h2>
        <p>
          Remote MCP at <code>/api/mcp</code>. Tools: <code>post_request</code>, <code>get_result</code>,{" "}
          <code>report_outcome</code>, <code>get_offers</code>, <code>search_products</code>. Stateless streamable HTTP.
          The agent skill is at <a href="/skill.md">/skill.md</a>.
        </p>
        <pre>{`{
  "mcpServers": {
    "haggleboard": { "url": "${SITE_URL}/api/mcp" }
  }
}`}</pre>
      </section>
    </main>
  );
}
