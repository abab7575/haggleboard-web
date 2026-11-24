import type { Metadata } from "next";
import { OfferList } from "../../components/offer-list";
import { HttpError } from "../../lib/http";
import { defaultDeps, getOffers } from "../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare public prices", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;

/** A plain price check against the public snapshot, for a server with no database. Nothing is posted. */
export default async function ResultsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const value = (key: string) => {
    const raw = params[key];
    const first = Array.isArray(raw) ? raw[0] : raw;
    return first?.trim() || "";
  };
  const text = value("text");
  const size = value("size");
  let error: string | null = null;
  let offers = null as Awaited<ReturnType<typeof getOffers>> | null;
  if (text || size) {
    try {
      offers = await getOffers({ text: text || undefined, size: size || undefined }, await defaultDeps());
    } catch (caught) {
      error = caught instanceof HttpError ? caught.message : "Couldn't compare that.";
    }
  }
  return (
    <main>
      <section className="page-head">
        <h1>{text || "Check a price."}</h1>
        <p className="lede">Public prices from the snapshot, cheapest first. Nothing is posted and no store is asked. Checkout stays on the store&apos;s site.</p>
        <form action="/results" method="get" className="byhand" style={{ maxWidth: 640, marginTop: 20 }}>
          <label htmlFor="results-text">What are you after?</label>
          <span className="field">
            <input id="results-text" name="text" defaultValue={text} placeholder="Brooks Ghost 16 women's size 8" autoComplete="off" maxLength={200} />
            <button className="btn" type="submit">
              Check
            </button>
          </span>
        </form>
      </section>
      <section className="section section--tight">
        {error ? <p className="body">{error}</p> : null}
        {offers ? <OfferList offers={offers.offers} omitted={offers.omitted_unavailable} /> : null}
      </section>
    </main>
  );
}
