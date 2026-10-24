import type { Metadata } from "next";
import { PRICE_NOTE, REMOVAL_EMAIL, USER_AGENT } from "../../lib/copy";

export const metadata: Metadata = { title: "Crawler" };

export default function BotPage() {
  return (
    <main>
      <section className="hero">
        <p className="kicker">HaggleBoard</p>
        <h1>How the crawler identifies itself</h1>
        <p className="lede">
          HaggleBoard reads public Shopify product feeds for running shoes. It is not affiliated with any store or
          brand. {PRICE_NOTE}
        </p>
      </section>
      <section className="panel">
        <h2>User-Agent</h2>
        <p>
          <code>{USER_AGENT}</code>
        </p>
        <p>
          The crawler waits about five seconds between requests to a store and between stores. It reads{" "}
          <code>robots.txt</code> and skips a store that disallows <code>/products.json</code>. A rate limit or a bot
          challenge stops that store, and a second one stops the run.
        </p>
        <p>What is kept from a listing: the title, the price, the product URL, and the date it was observed.</p>
        <p>
          Store owner? Ask us to remove your listings: <a href={`mailto:${REMOVAL_EMAIL}`}>{REMOVAL_EMAIL}</a>
        </p>
      </section>
    </main>
  );
}
