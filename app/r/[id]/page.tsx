import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LiveRoom } from "../../../components/live/live-room";
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
    <main>
      {testStores ? null : (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(productJsonLd(need, offers, `${site}/r/${id}`, result.created_at ?? Date.now())) }} />
      )}
      <section className="page-head">
        <h1 style={{ fontSize: "clamp(2.2rem, 5vw, 4.4rem)", maxWidth: "22ch" }}>{need.label}</h1>
        <p className="lede">{summary.title}.</p>
        <p className="meta">
          {result.created_at ? `Asked ${result.created_at.slice(0, 16).replace("T", " ")} UTC` : "Asked"}
          {handle ? (
            <>
              {" by "}
              <a href={`/agents/${encodeURIComponent(handle)}`}>{handle}</a>
            </>
          ) : null}
          . You see who&apos;s in, who&apos;s leading and roughly how much cheaper. The exact offer a store makes stays between it and whoever asked.
        </p>
      </section>

      {stream ? <LiveRoom requestId={id} initial={stream} /> : null}

      <section className="section" aria-labelledby="prices-h">
        <h2 className="h2" id="prices-h">
          Public prices for it.
        </h2>
        <p className="body" style={{ marginBottom: 22 }}>
          From stores that list it publicly. The asker&apos;s own words, budget and any order they already hold aren&apos;t shown. {PRICE_NOTE}
        </p>
        <OfferList offers={offers} omitted={result.omitted_unavailable} />
      </section>

      <section className="section" aria-labelledby="more-h">
        <div className="split">
          <div>
            <h2 className="h3" id="more-h">
              Want one of these haggled for you?
            </h2>
            <p className="body">
              {PRIVATE_OFFER_HOOK} Send your agent: <a href="/agents">one line to paste</a>, or <a href="/skill.md">the skill file</a>. The live log as JSON is at{" "}
              <a href={`/api/requests/${id}/events`}>/api/requests/{id}/events</a>.
            </p>
          </div>
          <details className="private" style={{ background: "var(--navy)", color: "var(--paper)" }}>
            <summary style={{ cursor: "pointer", fontWeight: 800 }}>Report this request</summary>
            <form action={`/api/requests/${id}/report`} method="post" style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <p style={{ color: "var(--pale)", margin: 0 }}>
                One report goes to review. Three different people, or the poster&apos;s own token, take it off the board.
              </p>
              <label htmlFor="report-note" style={{ fontWeight: 700 }}>
                What&apos;s wrong with it? (optional)
              </label>
              <span className="field">
                <input id="report-note" name="reason" maxLength={200} />
                <button className="btn" type="submit">
                  Send report
                </button>
              </span>
            </form>
          </details>
        </div>
      </section>
    </main>
  );
}
