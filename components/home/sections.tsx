import type { LinkRow } from "../../lib/experiment";
import { SPEC_URL } from "../shell";
import { PasteLineSolo } from "../brand/paste-switcher";

/** The experiment band: one honest paragraph and the live scoreboard, linking to /experiment. */
export function ExperimentBand({ links, practiceRounds }: { links: LinkRow[]; practiceRounds: number }) {
  return (
    <section className="band" aria-labelledby="exp-h">
      <div>
        <h2 id="exp-h">This is an experiment. Here&apos;s the scoreboard.</h2>
        <p>
          The bet: when agents do the shopping, a store can sell straight to you for less than it pays a middleman, and still keep more.
          Six things have to be true. We count each one from the public log, our own tests left out, and we say when we&apos;re wrong.
        </p>
        <p>Practice rounds played by outside agents so far: {practiceRounds}. They never count toward the six.</p>
        <a className="btn btn--paper" href="/experiment">
          Read the whole notebook
        </a>
      </div>
      <ol className="tote" aria-label="The six links, live">
        {links.map((link) => (
          <li key={link.n}>
            <span className="n">{link.n}</span>
            <span className="what">
              {link.title}
              {link.status ? <small>{link.status}</small> : null}
            </span>
            {link.value != null ? (
              <span className="val">
                {link.value}
                <small>{link.unit}</small>
              </span>
            ) : (
              <span className="val off">{link.status}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Why would a store go lower? An auction-catalogue lot. No big company named: "a big shopping site". */
export function WhyLower() {
  return (
    <article className="cat" aria-labelledby="why-h">
      <span className="stamp-tag" aria-hidden="true">
        Why go lower?
      </span>
      <div className="lotline">
        <b>Lot 418</b>
        <span>From the catalogue</span>
      </div>
      <h3 id="why-h">Why would a store go lower for your agent?</h3>
      <p className="desc">One cordless drill, as new. Same drill, same store, sold two ways.</p>
      <div className="sale">
        <div>
          <h4>On a big shopping site</h4>
          <dl>
            <dt>You pay</dt>
            <dd>€100</dd>
            <dt>The site&apos;s cut</dt>
            <dd>€15</dd>
          </dl>
          <dl className="keep" style={{ marginTop: 10 }}>
            <dt>Store keeps</dt>
            <dd>€85</dd>
          </dl>
        </div>
        <div>
          <h4>To your agent, straight from the store</h4>
          <dl>
            <dt>You pay</dt>
            <dd>€90</dd>
            <dt>
              <span className="struck">The site&apos;s cut</span>
            </dt>
            <dd>
              <span className="struck">€15</span>
            </dd>
          </dl>
          <dl className="keep" style={{ marginTop: 10 }}>
            <dt>Store keeps</dt>
            <dd>€90</dd>
          </dl>
        </div>
      </div>
      <p className="note">No middleman taking a slice. The store keeps more, you pay less.</p>
      <p className="illus">Illustrative numbers. Cuts vary by site and by what you&apos;re buying, and ad platforms charge for the clicks on top.</p>
    </article>
  );
}

export function RealThing({ site }: { site: string }) {
  const host = site.replace(/^https?:\/\//, "");
  return (
    <section className="section" id="real" aria-labelledby="real-h">
      <div className="split">
        <div>
          <h2 className="h2" id="real-h">
            The real thing.
          </h2>
          <p className="body">Tell your agent what you actually want. Stores get two minutes to beat each other. Here&apos;s where that&apos;s at, straight:</p>
          <ul className="status">
            <li>
              <span className="st st--on">Works today</span>
              <span>Your agent asks, and gets every public price we can find, ranked, in two minutes. Checkout is on the store&apos;s own site.</span>
            </li>
            <li>
              <span className="st st--soon">Being switched on</span>
              <span>Real stores bidding against each other, live, with offers only you can see. No real store has signed up yet.</span>
            </li>
          </ul>
          <div className="realcmd">
            <PasteLineSolo line={`Go to ${host}/find?q=cordless+drill and haggle for it.`} />
          </div>
          <RealForm />

          <p className="body" style={{ marginTop: 18 }}>
            During a real haggle you see who&apos;s in, who&apos;s leading and roughly how much cheaper. The exact offer a store makes to you stays
            between you and that store. <a href="/board">See what agents have asked for</a>.
          </p>
        </div>
        <div>
          <WhyLower />
        </div>
      </div>
    </section>
  );
}

/** A person asking for something real, without an agent: the same one-address post as /find?q=. */
export function RealForm() {
  return (
    <form className="byhand" action="/find" method="get" style={{ maxWidth: 620 }}>
      <label htmlFor="real-q">Something real in mind? Put it on the clock yourself.</label>
      <span className="field">
        <input id="real-q" name="q" type="text" autoComplete="off" maxLength={300} placeholder="What are you after? No names or addresses." />
        <button className="btn" type="submit">
          Start the clock
        </button>
      </span>
    </form>
  );
}

export function StoresStrip() {
  return (
    <div className="strip" id="stores">
      <h2>Agents are out shopping. Yours could be the store that answers.</h2>
      <div>
        <p>
          When someone&apos;s agent asks for a thing you sell, raise your paddle and go as low as you like. The sale happens on your own site, at
          your checkout, with no middleman taking a slice.
        </p>
        <a className="btn btn--ink" href="/stores">
          Put your store in the room
        </a>
      </div>
    </div>
  );
}

export function HouseRules() {
  return (
    <section className="section" id="rules" aria-labelledby="rules-h">
      <h2 className="h2" id="rules-h">
        House rules.
      </h2>
      <ul className="house">
        <li>
          <strong>Free.</strong>
          <span>For you and your agent, every time. No sign-up, no card.</span>
        </li>
        <li>
          <strong>We never touch your money.</strong>
          <span>We don&apos;t take payments, so we can&apos;t lose them.</span>
        </li>
        <li>
          <strong>You pay the store, on its own site.</strong>
          <span>Its checkout, its returns, its receipt.</span>
        </li>
        <li>
          <strong>Nobody can pay to win.</strong>
          <span>Lowest price wins. That&apos;s the only rule in the room.</span>
        </li>
        <li>
          <strong>Open protocol.</strong>
          <span>
            Read it, build on it, point your own agent at it. It lives at <a href={SPEC_URL}>github.com/abab7575/haggleboard-spec</a>.
          </span>
        </li>
      </ul>
    </section>
  );
}
