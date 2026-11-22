"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clockLabel, durationWords } from "../../lib/arena";
import { feedToArena, formatPublicPrice, mergeFeedEvents, storeName } from "../../lib/arena-live";
import type { PublicStream, PublicStreamEvent } from "../../lib/stream";
import { Arena } from "./arena";
import { ResultCard } from "./result-card";

/**
 * The live arena on /r/{id}: the designed Arena fed by the real public feed.
 *
 * Feed: Server-Sent Events from /api/requests/{id}/stream, falling back to polling
 * /api/requests/{id}/events when EventSource is missing or keeps failing.
 *
 * The poster's view: a delete token kept in this browser (localStorage, written by the homepage
 * form, or read once from a #t=<token> fragment and then removed from the address bar). The token
 * never goes into a query string, a canonical tag or an OG tag. With it, this component asks
 * /api/requests/{id}/result (token in a header) for the standing with amounts and the winner's link.
 */

const FEED_TYPES = ["auction.opened", "store.joined", "lead.changed", "auction.closed"] as const;
const POLL_MS = 2000;
const POSTER_POLL_MS = 4000;

export const tokenKey = (id: string) => `hb:token:${id}`;

type Standing = {
  rank: number;
  store_domain: string;
  source: "public_price" | "private_offer" | "store_bid";
  price: string;
  currency: string;
  available: boolean;
  product_url: string;
  band: string;
};

type PosterAuction = {
  status: "open" | "closing" | "closed";
  standing: Standing[];
  winner: (Standing & { checkout_url: string }) | null;
};

type Outcome = "bought_at_winner" | "bought_elsewhere" | "did_not_buy";

function readToken(id: string): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/[#&](?:t|token)=([^&]+)/);
  if (match) {
    const token = decodeURIComponent(match[1]!);
    try {
      window.localStorage.setItem(tokenKey(id), token);
    } catch {
      // Storage blocked: the token still works for this visit.
    }
    // Take it out of the address bar so it is never copied, shared or bookmarked.
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    return token;
  }
  try {
    return window.localStorage.getItem(tokenKey(id));
  } catch {
    return null;
  }
}

function forgetToken(id: string) {
  try {
    window.localStorage.removeItem(tokenKey(id));
  } catch {
    // nothing to do
  }
}

export function LiveArena({ requestId, initial, shareUrl }: { requestId: string; initial: PublicStream; shareUrl: string }) {
  const [feed, setFeed] = useState<PublicStream>(initial);
  const [token, setToken] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterAuction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [transport, setTransport] = useState<"stream" | "polling" | "idle">("idle");
  const closedRef = useRef(initial.status === "closed");

  useEffect(() => {
    setToken(readToken(requestId));
  }, [requestId]);

  // The public feed: SSE first, polling as the fallback.
  useEffect(() => {
    if (initial.status === "no_auction" || initial.status === "closed") return;
    let stopped = false;
    let source: EventSource | null = null;
    let failures = 0;
    let pollTimer: number | undefined;

    const poll = async () => {
      if (stopped) return;
      setTransport("polling");
      try {
        const res = await fetch(`/api/requests/${requestId}/events`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as PublicStream;
          setFeed((prev) => ({ ...next, events: mergeFeedEvents(prev.events, next.events) }));
          if (next.status === "closed") {
            closedRef.current = true;
            return;
          }
        }
      } catch {
        // try again
      }
      pollTimer = window.setTimeout(poll, POLL_MS);
    };

    if (typeof EventSource === "undefined") {
      void poll();
    } else {
      source = new EventSource(`/api/requests/${requestId}/stream`);
      setTransport("stream");
      const onEvent = (message: MessageEvent<string>) => {
        failures = 0;
        const event = JSON.parse(message.data) as PublicStreamEvent;
        setFeed((prev) => ({
          ...prev,
          events: mergeFeedEvents(prev.events, [event]),
          status: event.type === "auction.closed" ? "closed" : prev.status,
        }));
        if (event.type === "auction.closed") {
          closedRef.current = true;
          source?.close();
          setTransport("idle");
        }
      };
      for (const type of FEED_TYPES) source.addEventListener(type, onEvent as EventListener);
      source.addEventListener("tick", ((message: MessageEvent<string>) => {
        failures = 0;
        const tick = JSON.parse(message.data) as { seconds_left: number; status: PublicStream["status"] };
        setFeed((prev) => (prev.status === "closed" ? prev : { ...prev, seconds_left: tick.seconds_left, status: tick.status }));
      }) as EventListener);
      source.onerror = () => {
        // The server ends each connection after 25 seconds and EventSource reconnects by itself.
        // Repeated failures, or a closed source, mean the stream is not working here: poll instead.
        failures += 1;
        if (closedRef.current) {
          source?.close();
          return;
        }
        if (source?.readyState === EventSource.CLOSED || failures >= 3) {
          source?.close();
          source = null;
          void poll();
        }
      };
    }
    return () => {
      stopped = true;
      source?.close();
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [requestId, initial.status]);

  // The poster's view, only with a token held in this browser.
  useEffect(() => {
    if (!token || initial.status === "no_auction") return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/requests/${requestId}/result?wait=0`, {
          cache: "no-store",
          headers: { "x-haggleboard-delete-token": token },
        });
        if (res.status === 403 || res.status === 404 || res.status === 400) {
          forgetToken(requestId);
          setToken(null);
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { auction: PosterAuction | null; outcome_reported: Outcome | null };
          if (stopped) return;
          setPoster(body.auction);
          if (body.outcome_reported) setOutcome(body.outcome_reported);
          if (body.auction?.status === "closed") return;
        }
      } catch {
        // try again
      }
      if (!stopped) timer = window.setTimeout(load, POSTER_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [token, requestId, initial.status, feed.status === "closed"]);

  const data = useMemo(() => feedToArena(feed), [feed]);
  const shopper = token != null;
  const result = data.result;

  if (feed.status === "no_auction" || !data.opensAt) {
    return (
      <EmptyArena
        title="No live clock on this request"
        body="It was posted before timed auctions started, so there is nothing to watch. The public prices stores listed for it are below."
      />
    );
  }

  if (result && data.joined === 0) {
    return (
      <EmptyArena
        title="No store answered in time"
        body={`The clock ran for ${durationWords(data.durationSec)} and no store answered for ${data.request}. Nothing was hidden: no offer came in. Stores that carry it can answer the next request.`}
        actions
      />
    );
  }

  const winnerStanding = poster?.winner ?? null;
  const publicNote = shopper
    ? "You posted this, so you see the amounts. Everyone else sees bands."
    : "The asker's own words, budget and any order they hold stay private.";

  return (
    <div className="live-stage" data-perspective={shopper ? "shopper" : "public"} data-transport={transport}>
      <Arena
        request={data.request}
        durationSec={data.durationSec}
        bidders={data.bidders}
        events={data.events}
        demo={false}
        variant="full"
        perspective={shopper ? "shopper" : "public"}
        opensAt={data.opensAt}
        requestNote={publicNote}
        privacyNote="Store list prices are public, so they are shown. A private offer shows only a band. Amounts go only to the agent that asked."
        emptyLanes="No store has answered yet. Stores that may carry it are being checked."
        hideFinish={Boolean(result)}
      />
      <aside className="live-side" aria-label={shopper ? "Your offers and result" : "Result"}>
        {result && result.winner && result.winnerName ? (
          <ResultCard
            request={data.request}
            winner={result.winnerName}
            bandLabel={result.label ?? undefined}
            wonAtSec={result.wonAtSec}
            windowSec={data.durationSec}
            stores={result.bidders}
            demo={false}
            perspective={shopper ? "shopper" : "public"}
            shareUrl={shareUrl}
          />
        ) : null}
        {result && !result.winner ? (
          <div className="live-note panel">
            <h2>Clock&apos;s out, no winner</h2>
            <p>
              {result.bidders} store{result.bidders === 1 ? "" : "s"} answered, but none had it in stock at the close.
            </p>
          </div>
        ) : null}
        {!result ? (
          <div className="result-pending" role="status">
            <p>The result card lands here at 0:00.</p>
            <p className="meta">
              Closes at {data.deadline ? new Date(data.deadline).toISOString().slice(11, 19) : ""} UTC. Lead changes until the last
              second.
            </p>
          </div>
        ) : null}

        {shopper ? (
          <ShopperPanel
            requestId={requestId}
            token={token!}
            poster={poster}
            closed={Boolean(result)}
            winner={winnerStanding}
            outcome={outcome}
            onOutcome={setOutcome}
          />
        ) : null}
      </aside>
    </div>
  );
}

function ShopperPanel({
  requestId,
  token,
  poster,
  closed,
  winner,
  outcome,
  onOutcome,
}: {
  requestId: string;
  token: string;
  poster: PosterAuction | null;
  closed: boolean;
  winner: (Standing & { checkout_url: string }) | null;
  outcome: Outcome | null;
  onOutcome: (o: Outcome) => void;
}) {
  const [sending, setSending] = useState(false);
  const report = async (value: Outcome) => {
    setSending(true);
    try {
      const res = await fetch(`/api/requests/${requestId}/outcome`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-haggleboard-delete-token": token },
        body: JSON.stringify({ outcome: value }),
      });
      if (res.ok) onOutcome(value);
    } finally {
      setSending(false);
    }
  };
  const standing = poster?.standing ?? [];
  return (
    <section className="shopper-panel" aria-labelledby="shopper-title">
      <header>
        <h2 id="shopper-title">{closed ? "Your result" : "Your standing"}</h2>
        <span className="shopper-only">Only you see this</span>
      </header>
      {closed && winner ? (
        <div className="shopper-winner">
          <p className="meta">Winning offer</p>
          <p className="shopper-winner-price">
            {formatPublicPrice(winner.price, winner.currency) ?? winner.price}
            <span> at {storeName(winner.store_domain)}</span>
          </p>
          <a className="button buy" href={winner.checkout_url} rel="noopener noreferrer nofollow" target="_blank">
            Buy at {storeName(winner.store_domain)}
          </a>
          <p className="meta">
            Opens the store&apos;s own page. You check out there, with them. HaggleBoard never takes payment. Price and stock can change;
            the store&apos;s page is what counts.
          </p>
        </div>
      ) : null}
      {closed && !winner && poster ? <p>No store had it in stock at the close.</p> : null}
      {standing.length > 0 ? (
        <ol className="standing">
          {standing.slice(0, 6).map((entry) => (
            <li key={`${entry.store_domain}-${entry.source}`} className={entry.rank === 1 ? "is-first" : undefined}>
              <span className="standing-rank">{entry.rank}</span>
              <span className="standing-store">
                {storeName(entry.store_domain)}
                <small>
                  {entry.source === "public_price" ? "public price" : entry.source === "private_offer" ? "private offer to you" : "store bid"}
                  {entry.available ? "" : ", sold out"}
                </small>
              </span>
              <span className="standing-price">{formatPublicPrice(entry.price, entry.currency) ?? entry.price}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="meta">{poster ? "No offers yet." : "Loading your offers."}</p>
      )}
      {closed && winner ? (
        <div className="outcome-row">
          <p className="meta">{outcome ? "Thanks. Noted." : "What did you do? It helps stores and keeps the numbers honest."}</p>
          {outcome ? null : (
            <div className="outcome-buttons">
              <button type="button" className="ghost" disabled={sending} onClick={() => report("bought_at_winner")}>
                Bought it there
              </button>
              <button type="button" className="ghost" disabled={sending} onClick={() => report("bought_elsewhere")}>
                Bought elsewhere
              </button>
              <button type="button" className="ghost" disabled={sending} onClick={() => report("did_not_buy")}>
                Did not buy
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function EmptyArena({ title, body, actions = false }: { title: string; body: string; actions?: boolean }) {
  return (
    <section className="arena-empty" aria-labelledby="arena-empty-title">
      <div className="arena-empty-clock" aria-hidden="true">
        <span>{clockLabel(0)}</span>
      </div>
      <div>
        <h2 id="arena-empty-title">{title}</h2>
        <p>{body}</p>
        {actions ? (
          <p className="arena-empty-actions">
            <a className="button" href="/">
              Post it again
            </a>
            <a href="/board">See what others asked for</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}
