import type { Metadata } from "next";
import { NeedForm } from "../../components/need-form";
import { OfferList } from "../../components/offer-list";
import { HttpError } from "../../lib/http";
import { defaultDeps, getOffers } from "../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare" };

type Search = Record<string, string | string[] | undefined>;

export default async function ResultsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const value = (key: string) => {
    const raw = params[key];
    const first = Array.isArray(raw) ? raw[0] : raw;
    return first?.trim() || "";
  };
  const values = {
    text: value("text"),
    brand: value("brand"),
    model: value("model"),
    gender: value("gender"),
    size: value("size"),
    max_price: value("max_price"),
    currency: value("currency"),
    region: value("region"),
  };
  const max = values.max_price ? Number(values.max_price) : undefined;
  let error: string | null = null;
  let offers = null as Awaited<ReturnType<typeof getOffers>> | null;
  const hasQuery = Object.values(values).some(Boolean);
  if (hasQuery) {
    try {
      offers = await getOffers(
        {
          text: values.text || undefined,
          brand: values.brand || undefined,
          model: values.model || undefined,
          gender: values.gender || undefined,
          size: values.size || undefined,
          max_price: max != null && Number.isFinite(max) ? max : undefined,
          currency: values.currency || undefined,
          region: values.region || undefined,
        },
        await defaultDeps(),
      );
    } catch (caught) {
      error = caught instanceof HttpError ? caught.message : "Could not compare that need";
    }
  }

  return (
    <main>
      <section className="hero">
        <p className="kicker">Compare</p>
        <h1>{values.text || "What does the agent need?"}</h1>
      </section>
      {error ? <p className="empty">{error}</p> : null}
      {offers ? (
        <section>
          <div className="section-head">
            <h2>Offers</h2>
            <p className="meta">{offers.offers.length} shown. Checkout stays on the store.</p>
          </div>
          <OfferList offers={offers.offers} omitted={offers.omitted_unavailable} />
        </section>
      ) : null}
      <NeedForm values={values} />
    </main>
  );
}
