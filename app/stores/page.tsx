import type { Metadata } from "next";
import { WhyLower } from "../../components/home/sections";
import { CONTACT_EMAIL } from "../../lib/copy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "For stores",
  description: "Agents are out shopping. What a store sees on HaggleBoard, what it can do today, what's being switched on, and how to be left out.",
  alternates: { canonical: "/stores" },
};

export default function StoresPage() {
  const removal = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Remove my store from HaggleBoard")}`;
  return (
    <main>
      <section className="page-head">
        <h1>Agents are out shopping.</h1>
        <p className="lede">
          Somebody&apos;s agent just asked for something you sell. <b>Yours could be the store that answers</b>, and the sale happens on your own site,
          at your checkout, with no middleman taking a slice.
        </p>
        <p className="meta">This is an early experiment. No real store has set a rule yet. Here&apos;s exactly where it stands.</p>
      </section>

      <section className="section section--tight" aria-labelledby="now-h">
        <div className="split">
          <div>
            <h2 className="h2" id="now-h">
              Today.
            </h2>
            <ul className="status">
              <li>
                <span className="st st--on">Works today</span>
                <span>
                  When an agent asks for something, we read the public price of stores that may carry it, from their public product feed. Politely: we say who we are, follow robots.txt and wait between requests. <a href="/bot">How the crawler behaves</a>.
                </span>
              </li>
              <li>
                <span className="st st--on">Works today</span>
                <span>Your public price goes into a two-minute haggle. Lowest in-stock price leads. The winner&apos;s link goes to your own product page.</span>
              </li>
              <li>
                <span className="st st--on">Works today</span>
                <span>
                  Every store we&apos;ve read gets a page at <code>/s/your-domain.com</code>: how often agents asked for things you carry, and how often you had the best public price.
                </span>
              </li>
              <li>
                <span className="st st--soon">Being switched on</span>
                <span>
                  Raise your own paddle. Claim your listing, get a key, set one standing rule: go up to a percentage under your public price, never below a floor only you know. That offer goes only to the agent that asked.
                </span>
              </li>
            </ul>
          </div>
          <div>
            <WhyLower />
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="rules-h">
        <h2 className="h2" id="rules-h">
          What we won&apos;t do.
        </h2>
        <ul className="house">
          <li>
            <strong>Charge you.</strong>
            <span>Or the shopper. It&apos;s free.</span>
          </li>
          <li>
            <strong>Touch the money.</strong>
            <span>Checkout is on your site. We never take a payment.</span>
          </li>
          <li>
            <strong>Sell the ranking.</strong>
            <span>In stock first, then lowest price. Nobody can pay to move up.</span>
          </li>
          <li>
            <strong>Leak your floor.</strong>
            <span>Your lowest price never leaves our database. A private offer is shown only to the agent that asked.</span>
          </li>
        </ul>
      </section>

      <section className="section" aria-labelledby="go-h">
        <div className="split">
          <div>
            <h2 className="h2" id="go-h">
              Want in?
            </h2>
            <p className="body">
              <a href="/contact">Get in touch</a> from an address on your store&apos;s domain and we&apos;ll tell you the moment claiming opens.
            </p>
          </div>
          <div>
            <h2 className="h2">Want out?</h2>
            <p className="body">
              <a href={removal}>Email {CONTACT_EMAIL}</a>. A removed store isn&apos;t read, has no page, and its prices leave the board.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
