import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CONTACT_EMAIL } from "../../../lib/copy";
import { bidsEnabled } from "../../../lib/keys";
import { logPageRead } from "../../../lib/page-read";
import { defaultDeps } from "../../../lib/service";
import { storePageData } from "../../../lib/store-page";
import { storeRulesEnabled } from "../../../watcher/constants";

export const dynamic = "force-dynamic";

async function load(raw: string) {
  const deps = await defaultDeps();
  const data = await storePageData(deps.store, raw, await deps.loadVariants());
  return { deps, data };
}

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
  const { domain } = await params;
  const { data } = await load(domain);
  if (!data) return { title: "Store" };
  return {
    title: `${data.domain} and AI shopping agents`,
    description: `AI shopping agents asked HaggleBoard for products ${data.domain} carries ${data.requests_7d} times in the last 7 days and ${data.requests_30d} times in the last 30 days.`,
    alternates: { canonical: `/s/${data.domain}` },
  };
}

export default async function StorePage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const { deps, data } = await load(domain);
  if (!data) notFound();
  await logPageRead(deps.store, { kind: "store", path: `/s/${data.domain}`, store_domain: data.domain });
  const claimOpen = bidsEnabled() && storeRulesEnabled();
  const removal = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Remove ${data.domain} from HaggleBoard`)}`;
  return (
    <main>
      <section className="page-head">
        <p>
          <span className="ringtag ringtag--real">A real store, read from its public feed</span>
        </p>
        <h1 style={{ overflowWrap: "anywhere", fontSize: "clamp(2.2rem, 9vw, 5.6rem)" }}>{data.domain.replace(/\./g, ".\u200b")}</h1>
        <p className="lede">
          How often agents asked us for things this store carries, and how its public price did. Outside requests only, our own tests left out. As of{" "}
          {data.as_of.slice(0, 16).replace("T", " ")} UTC.
        </p>
      </section>

      <section className="section section--tight" aria-label="The numbers">
        {data.requests_30d === 0 ? (
          <div className="empty">
            <strong>Quiet so far.</strong>
            <p>No outside agent has asked for something this store carries in the last 30 days.</p>
          </div>
        ) : (
          <ul className="facts">
            <li>
              <b>{data.requests_7d}</b>
              <span>asks, last 7 days</span>
            </li>
            <li>
              <b>{data.requests_30d}</b>
              <span>asks, last 30 days</span>
            </li>
            <li>
              <b>{data.compared_30d}</b>
              <span>closed with a public price to compare</span>
            </li>
            <li>
              <b>{data.compared_30d === 0 ? "0" : `${data.best_public_30d}/${data.compared_30d}`}</b>
              <span>times it had the best public price</span>
            </li>
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="claim-h">
        <div className="split">
          <div>
            <h2 className="h2" id="claim-h">
              Raise your own paddle.
            </h2>
            <p className="body">
              Claim this listing and you get a store key and one standing rule: go up to a percentage under your public price, never below a floor only you know. The offer goes only to the agent that asked, and checkout stays on your own site.
            </p>
            <p className="body">
              {claimOpen ? "Claiming is open. " : "Claiming isn't switched on yet. "}
              <a href="/contact">Get in touch</a> from an address on {data.domain}.
            </p>
          </div>
          <div>
            <h2 className="h2">Rather not?</h2>
            <p className="body">
              <a href={removal}>Email {CONTACT_EMAIL}</a> and we stop reading this store&apos;s public prices and take this page down.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
