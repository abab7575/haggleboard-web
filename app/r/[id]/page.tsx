import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveArena } from "../../../components/arena/live-arena";
import { OfferList } from "../../../components/offer-list";
import { PRICE_NOTE } from "../../../lib/copy";
import { requestEvents } from "../../../lib/events";
import { HttpError } from "../../../lib/http";
import { logPageRead } from "../../../lib/page-read";
import { jsonLdText, PRIVATE_OFFER_HOOK, productJsonLd, requestSummary } from "../../../lib/seo";
import { defaultDeps, getOffers } from "../../../lib/service";
import { publicStream, standingCounts } from "../../../lib/stream";
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
  const stream = await publicStream((await defaultDeps()).store, id);
  const summary = requestSummary(view.need, view.offers, view.result.created_at, Date.now(), stream ? standingCounts(stream.events) : undefined);
  // Canonical and OG carry the bare path only. A poster's token lives in their browser, never in a URL.
  return {
    ...(stream?.test_stores ? { robots: { index: false, follow: false } } : {}),
    title: { absolute: `${summary.title} · HaggleBoard` },
    description: summary.description,
    alternates: { canonical: `/r/${id}` },
    openGraph: { title: summary.title, description: summary.description, url: `/r/${id}` },
  };
}

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await publicView(id);
  if (!view) notFound();
  const { need, offers, result } = view;
  const deps = await defaultDeps();
  const site = (process.env.SITE_URL?.trim() || "https://haggleboard.com").replace(/\/$/, "");
  const stream = await publicStream(deps.store, id);
  const summary = requestSummary(need, offers, result.created_at, Date.now(), stream ? standingCounts(stream.events) : undefined);
  // Test stores (TEST_STORES=1, local only): no JSON-LD, and the page is kept out of every index.
  const testStores = stream?.test_stores === true;
  const posted = (await requestEvents(deps.store, id)).find((event) => event.type === "request.posted");
  const handle = typeof posted?.public.handle === "string" ? posted.public.handle : null;
  await logPageRead(deps.store, { kind: "request", path: `/r/${id}`, request_id: id });
  return (
    <main className="request-page">
      {testStores ? null : (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdText(productJsonLd(need, offers, `${site}/r/${id}`, result.created_at ?? Date.now())) }}
        />
      )}
      <section className="request-head">
        <p className="kicker">
          Request{result.created_at ? ` · posted ${result.created_at.slice(0, 16).replace("T", " ")} UTC` : ""}
          {handle ? (
            <>
              {" · by agent "}
              <a href={`/agents/${encodeURIComponent(handle)}`}>{handle}</a>
            </>
          ) : null}
        </p>
        <h1>{need.label}</h1>
        <p className="request-summary">{summary.title}.</p>
      </section>

      {stream ? (
        <LiveArena requestId={id} initial={stream} shareUrl={`${site}/r/${id}`} />
      ) : null}

      <section className="request-prices" aria-labelledby="prices-title">
        <div className="section-head">
          <h2 id="prices-title">Public prices for this product</h2>
          <p className="meta">
            From stores that list it publicly. The poster&apos;s own words, budget and any order they already hold are not
            shown. {PRICE_NOTE}
          </p>
        </div>
        <OfferList offers={offers} omitted={result.omitted_unavailable} />
      </section>

      <section className="request-foot">
        <p className="skill-link">
          {PRIVATE_OFFER_HOOK} Ask your agent to haggle for it on HaggleBoard: <a href="/skill.md">the skill</a>, or open{" "}
          <code>/find?q=…</code>.
        </p>
        <details className="panel report">
          <summary>Report this request</summary>
          <form action={`/api/requests/${id}/report`} method="post">
            <p>
              One report goes to review. The request is hidden after three distinct reports, or right away with the delete
              token returned when it was posted.
            </p>
            <label>
              Note
              <input name="reason" maxLength={200} />
            </label>
            <button type="submit">Send report</button>
          </form>
        </details>
        <p className="meta">
          <a href="/board">Back to the board</a> · Live events as JSON:{" "}
          <a href={`/api/requests/${id}/events`}>/api/requests/{id}/events</a>
        </p>
      </section>
    </main>
  );
}
