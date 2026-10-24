import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OfferList } from "../../../components/offer-list";
import { PRICE_NOTE } from "../../../lib/copy";
import { HttpError } from "../../../lib/http";
import { defaultDeps, getOffers, publicNeedLabel } from "../../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Need" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await getOffers({ request_id: id }, await defaultDeps());
    return (
      <main>
        <section className="hero">
          <p className="kicker">Posted need</p>
          <h1>{publicNeedLabel(result.need)}</h1>
          <p className="lede">Offers are recomputed from the current snapshot. {PRICE_NOTE}</p>
        </section>
        <OfferList offers={result.offers} omitted={result.omitted_unavailable} />
        <form className="panel report" action={`/api/requests/${id}/report`} method="post">
          <p>
            Report this need. One report goes to review. The need is hidden after three distinct reports, or right away
            with the delete token returned when it was posted.
          </p>
          <label>
            Note
            <input name="reason" maxLength={200} />
          </label>
          <button type="submit">Send report</button>
        </form>
      </main>
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }
}
