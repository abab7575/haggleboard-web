import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OfferList } from "../../../components/offer-list";
import { PRICE_NOTE } from "../../../lib/copy";
import { HttpError } from "../../../lib/http";
import { defaultDeps, getOffers, publicNeedLabel } from "../../../lib/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Request" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Public view: no delete token, so no private field is loaded into this page.
    const result = await getOffers({ request_id: id }, await defaultDeps());
    const label = "label" in result.need ? result.need.label : publicNeedLabel(result.need);
    return (
      <main>
        <section className="hero">
          <p className="kicker">Request{result.created_at ? ` · posted ${result.created_at.slice(0, 16).replace("T", " ")} UTC` : ""}</p>
          <h1>{label}</h1>
          <p className="lede">
            Public prices from stores that list this product. The poster&apos;s own words, budget and any order they
            already hold are not shown. {PRICE_NOTE}
          </p>
        </section>
        <OfferList offers={result.offers} omitted={result.omitted_unavailable} />
        <form className="panel report" action={`/api/requests/${id}/report`} method="post">
          <p>
            Report this request. One report goes to review. The request is hidden after three distinct reports, or
            right away with the delete token returned when it was posted.
          </p>
          <label>
            Note
            <input name="reason" maxLength={200} />
          </label>
          <button type="submit">Send report</button>
        </form>
        <p className="meta">
          <a href="/board">Back to the board</a>
        </p>
      </main>
    );
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
}
