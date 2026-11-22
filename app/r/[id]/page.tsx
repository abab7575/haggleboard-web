import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveAuction } from "../../../components/live-auction";
import { OfferList } from "../../../components/offer-list";
import { PRICE_NOTE } from "../../../lib/copy";
import { HttpError } from "../../../lib/http";
import { logPageRead } from "../../../lib/page-read";
import { jsonLdText, PRIVATE_OFFER_HOOK, productJsonLd, requestSummary } from "../../../lib/seo";
import { defaultDeps, getOffers } from "../../../lib/service";
import { publicStream } from "../../../lib/stream";
import type { PublicNeed, PublicOffer } from "../../../referee/types";

export const dynamic = "force-dynamic";

/** The public view only: no delete token, so no private field is loaded into this page. */
async function publicView(id: string) {
  try {
    const result = await getOffers({ request_id: id }, await defaultDeps());
    return { need: result.need as PublicNeed, offers: result.offers as PublicOffer[], result };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const view = await publicView(id);
  if (!view) return { title: "Request" };
  const summary = requestSummary(view.need, view.offers, view.result.created_at);
  return { title: { absolute: `${summary.title} · HaggleBoard` }, description: summary.description, alternates: { canonical: `/r/${id}` } };
}

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await publicView(id);
  if (!view) notFound();
  const { need, offers, result } = view;
  const deps = await defaultDeps();
  const summary = requestSummary(need, offers, result.created_at);
  const site = (process.env.SITE_URL?.trim() || "https://haggleboard.com").replace(/\/$/, "");
  const stream = await publicStream(deps.store, id);
  await logPageRead(deps.store, { kind: "request", path: `/r/${id}`, request_id: id });
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(productJsonLd(need, offers, `${site}/r/${id}`)) }} />
      <section className="hero">
        <p className="kicker">Request{result.created_at ? ` · posted ${result.created_at.slice(0, 16).replace("T", " ")} UTC` : ""}</p>
        <h1>{need.label}</h1>
        <p className="lede">{summary.title}.</p>
        <p className="lede">
          Public prices from stores that list this product. The poster&apos;s own words, budget and any order they
          already hold are not shown. {PRICE_NOTE}
        </p>
        <p className="skill-link">
          {PRIVATE_OFFER_HOOK} Ask your agent to haggle for it on HaggleBoard: <a href="/skill.md">the skill</a>, or open{" "}
          <code>/find?q=…</code>.
        </p>
      </section>
      {stream ? <LiveAuction requestId={id} initial={stream} /> : null}
      <OfferList offers={offers} omitted={result.omitted_unavailable} />
      <form className="panel report" action={`/api/requests/${id}/report`} method="post">
        <p>
          Report this request. One report goes to review. The request is hidden after three distinct reports, or right
          away with the delete token returned when it was posted.
        </p>
        <label>
          Note
          <input name="reason" maxLength={200} />
        </label>
        <button type="submit">Send report</button>
      </form>
      <p className="meta">
        <a href="/board">Back to the board</a> · Live events as JSON:{" "}
        <a href={`/api/requests/${id}/events`}>/api/requests/{id}/events</a>
      </p>
    </main>
  );
}
