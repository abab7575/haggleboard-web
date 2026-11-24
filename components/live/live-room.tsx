"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { feedToArena, formatPublicPrice, mergeFeedEvents, priceNote, storeName } from "../../lib/arena-live";
import type { PublicStream, PublicStreamEvent } from "../../lib/stream";
import { COSTUMES, Room, type GavelState, type LogRow, type PaddleView, type RoomView } from "../brand/room";

/**
 * A REAL HAGGLE on /r/{id}, in the same room as the practice ring.
 *
 * Public view: the public feed only (Server-Sent Events from /api/requests/{id}/stream, polling
 * /api/requests/{id}/events as the fallback), mapped through feedToArena (lib/arena-live.ts), which
 * keeps it public: who is in, who leads, each lead change, the clock, a store's own public list
 * price, and for a private offer a rough band such as "5 to 10% under". Never an amount offered
 * only to the poster.
 *
 * The poster's view: a delete token kept in this browser (localStorage, written by the page that
 * posted, or read once from a #t=<token> fragment and then removed from the address bar). The token
 * never goes into a query string, a canonical tag or an OG tag. With it, this component asks
 * /api/requests/{id}/result (token in a header) for the standing with amounts and the winner's link.
 */

const FEED_TYPES = ["auction.opened", "store.joined", "price.confirmed", "store.withdrawn", "lead.changed", "auction.closed"] as const;
const POLL_MS = 2000;
const POSTER_POLL_MS = 4000;
const MAX_PADDLES = 4;

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
  observed_at: string | null;
  confirmed: boolean;
  stale: boolean;
  test: boolean;
  list_price?: string | null;
};

type PosterAuction = {
  status: "open" | "closing" | "closed";
  standing: Standing[];
  winner: (Standing & { checkout_url: string }) | null;
  result: { kind: "won" | "last_seen" | "none"; label: string | null } | null;
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

/** "5 to 10% under the best public price" becomes "about 5 to 10% cheaper". */
export function cheaperWords(label: string | null | undefined): string | null {
  if (!label) return null;
  if (/^at the best public price/.test(label)) return "level with the cheapest price";
  if (/above/.test(label)) return "not cheaper yet";
  if (/private offer|other currency|no public price/.test(label)) return null;
  const m = label.match(/(up to [\d.]+%|[\d.]+ to [\d.]+%|more than [\d.]+%|within [\d.]+%)/);
  if (!m) return null;
  return m[1]!.startsWith("within") ? `within ${m[1]!.replace("within ", "")} of the cheapest` : `about ${m[1]} cheaper`;
}

/** The tag on a paddle is a sticker, not a sentence: "Confirmed today", "Seen 18 Oct". */
function shortNote(note: string | undefined): string {
  if (!note) return "In";
  if (note.startsWith("confirmed")) return "Confirmed today";
  const seen = note.match(/(?:last )?seen (\d+ \w{3})/);
  return seen ? `Seen ${seen[1]}` : note.length > 18 ? "In" : note;
}

const mmss =(s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

export function liveView(feed: PublicStream, nowMs: number, opts: { still?: boolean; hit?: boolean } = {}): RoomView & { closed: boolean; noStores: boolean } {
  const data = feedToArena(feed);
  const opened = data.opensAt ? Date.parse(data.opensAt) : nowMs;
  const closed = Boolean(data.result) || feed.status === "closed";
  const t = closed ? data.durationSec : Math.min(data.durationSec, Math.max(0, (nowMs - opened) / 1000));
  const secsLeft = Math.max(0, data.durationSec - t);
  const events = data.events.filter((event) => event.at <= t + 0.01 || closed);
  const joined: string[] = [];
  const withdrawn = new Set<string>();
  let leader: string | null = null;
  let leadLabel: string | null = null;
  let leadPrivate = false;
  for (const event of events) {
    if (event.kind === "join" && !joined.includes(event.bidder)) joined.push(event.bidder);
    if (event.kind === "withdraw") withdrawn.add(event.bidder);
    if (event.kind === "lead") {
      leader = event.bidder;
      leadLabel = event.label ?? null;
      leadPrivate = event.private === true;
    }
  }
  const result = data.result;
  if (closed && result) leader = result.winner;
  const name = (id: string) => data.bidders.find((b) => b.id === id)?.name ?? storeName(id);
  const bidder = (id: string) => data.bidders.find((b) => b.id === id);

  const shown = [...(leader ? [leader] : []), ...joined.filter((id) => id !== leader)].slice(0, MAX_PADDLES);
  const paddles: PaddleView[] = shown.map((id, i) => {
    const b = bidder(id);
    const isLeader = id === leader;
    const gone = withdrawn.has(id);
    const cheaper = isLeader ? cheaperWords(closed ? (result?.label ?? leadLabel) : leadLabel) : null;
    return {
      id,
      no: i + 1,
      name: name(id).replace(/\./g, ".\u200b"),
      amount: gone ? "Gone" : isLeader && leadPrivate ? "Private" : (b?.publicPrice ?? "Private"),
      state: gone ? "folded" : isLeader ? (closed ? "won" : "lead") : closed ? "down" : "down",
      tag: gone ? "No longer listed" : isLeader ? (cheaper ?? (closed ? "Sold" : "Leading")) : (b?.test ? "Test store" : shortNote(b?.priceNote)),
      costume: COSTUMES[i % COSTUMES.length]!,
    };
  });

  // The clerk's sheet: the public feed, line by line.
  const log: LogRow[] = [];
  for (const event of [...feed.events].sort((a, b) => a.seq - b.seq)) {
    const at = data.opensAt ? (Date.parse(event.at) - opened) / 1000 : 0;
    if (!closed && at > t + 0.01) continue;
    const base = { key: String(event.seq), time: mmss(Math.min(data.durationSec, at)), raw: event };
    if (event.type === "store.joined") {
      const price = event.source === "public_price" ? formatPublicPrice(event.public_price, event.currency) : null;
      log.push({ ...base, who: storeName(event.store), whoKind: "store", amount: price ?? "private", quiet: !price, text: price ? `In, at its public price. ${priceNote(event)}.` : "In, with an offer only the asker sees." });
    } else if (event.type === "price.confirmed") {
      log.push({ ...base, who: storeName(event.store), whoKind: "store", amount: formatPublicPrice(event.public_price, event.currency) ?? null, text: "Price checked live. Confirmed today." });
    } else if (event.type === "store.withdrawn") {
      log.push({ ...base, who: storeName(event.store), whoKind: "store", amount: "out", quiet: true, text: `${event.label}. Its old price is out.` });
    } else if (event.type === "lead.changed") {
      const words = cheaperWords(event.band_label);
      log.push({ ...base, who: storeName(event.store), whoKind: "store", amount: event.source === "public_price" ? "leads" : "private", lead: true, text: `Takes the lead${words ? `, ${words}` : ""}.` });
    } else if (event.type === "auction.closed") {
      const words = cheaperWords(event.band_label);
      log.push({
        ...base,
        who: "the clerk",
        whoKind: "clerk",
        amount: null,
        sold: Boolean(event.winner),
        text: event.winner
          ? event.result === "last_seen"
            ? `Best last-seen price at ${storeName(event.winner.store)}, not confirmed today.`
            : `Sold to ${storeName(event.winner.store)}${words ? `, ${words}` : ""}.`
          : "Nobody bit. No store had it in stock at the close.",
      });
    }
  }

  const lastEvent = events[events.length - 1];
  let say = joined.length ? "Who'll go lower?" : "Stores are being asked. Who's in?";
  if (lastEvent?.kind === "join") say = `${name(lastEvent.bidder)} raises a paddle.`;
  if (lastEvent?.kind === "lead") say = `${name(lastEvent.bidder)} takes the lead.`;
  if (lastEvent?.kind === "withdraw") say = `${name(lastEvent.bidder)} drops out. Sold out there.`;
  let gavel: GavelState = "rest";
  if (closed) {
    say = result?.winner ? (result.kind === "last_seen" ? "No sale today. Last-seen price only." : `Sold. ${name(result.winner)}.`) : "Nobody bit.";
    gavel = opts.hit ? "down" : "rest";
  } else if (secsLeft <= 1.6) {
    say = "Going twice.";
    gavel = "up2";
  } else if (secsLeft <= 3.1) {
    say = "Going once.";
    gavel = "up1";
  } else if (secsLeft <= 10 && secsLeft > 7) say = "Ten seconds. Anyone?";

  const leaderName = leader ? name(leader) : null;
  const cheaper = cheaperWords(closed ? (result?.label ?? leadLabel) : leadLabel);
  const leading = closed ? (
    leaderName ? (
      <>
        <b>{result?.kind === "last_seen" ? `Best last-seen price: ${leaderName}.` : `Sold to ${leaderName}.`}</b> {cheaper ? <span className="off">{cheaper}</span> : null}
      </>
    ) : (
      <b>Nobody bit. Here are the best public prices we found anyway.</b>
    )
  ) : leaderName ? (
    <>
      <b>Leading: {leaderName}.</b> {cheaper ? <span className="off">{cheaper}</span> : null} {cheaper ? "than the cheapest public price." : null}
    </>
  ) : (
    <>Nobody is leading yet.</>
  );

  return {
    lotNo: "Live",
    lotText: data.request,
    tag: data.testStores ? <span className="ringtag">Test stores. Made up, on our own machine.</span> : <span className="ringtag ringtag--real">The real thing. Real stores.</span>,
    say,
    leading,
    seconds: secsLeft,
    tense: !closed && secsLeft <= 10 && secsLeft > 0,
    done: closed && Boolean(result?.winner),
    gavel,
    hit: Boolean(opts.hit && closed && result?.winner),
    paddles,
    log,
    srSummary: `A real haggle for ${data.request}. ${closed ? (leaderName ? `Closed. ${result?.kind === "last_seen" ? "Best last-seen price" : "Won"}: ${leaderName}${cheaper ? `, ${cheaper}` : ""}.` : "Closed with no winner.") : `${Math.ceil(secsLeft)} seconds left. ${joined.length} store${joined.length === 1 ? "" : "s"} in.${leaderName ? ` Leading: ${leaderName}${cheaper ? `, ${cheaper}` : ""}.` : ""}`} The full public log is in the clerk's sheet.`,
    clockLabel: closed ? "hammer down" : "on the clock",
    still: opts.still,
    closed,
    noStores: joined.length === 0,
  };
}

export function LiveRoom({ requestId, initial }: { requestId: string; initial: PublicStream }) {
  const [feed, setFeed] = useState<PublicStream>(initial);
  const [token, setToken] = useState<string | null>(null);
  const [poster, setPoster] = useState<PosterAuction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [still, setStill] = useState(false);
  const [hit, setHit] = useState(false);
  const closedRef = useRef(initial.status === "closed");

  useEffect(() => {
    setToken(readToken(requestId));
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [requestId]);

  useEffect(() => {
    if (feed.status === "closed" || feed.status === "no_auction") return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [feed.status]);

  // The gavel comes down when the close arrives while you're watching.
  useEffect(() => {
    if (feed.status === "closed" && !closedRef.current) {
      closedRef.current = true;
      setHit(true);
      const t = window.setTimeout(() => setHit(false), 1200);
      return () => window.clearTimeout(t);
    }
  }, [feed.status]);

  // The public feed: SSE first, polling as the fallback.
  useEffect(() => {
    if (initial.status === "no_auction" || initial.status === "closed") return;
    let stopped = false;
    let source: EventSource | null = null;
    let failures = 0;
    let pollTimer: number | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/requests/${requestId}/events`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as PublicStream;
          setFeed((prev) => ({ ...next, events: mergeFeedEvents(prev.events, next.events) }));
          if (next.status === "closed") return;
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
      const onEvent = (message: MessageEvent<string>) => {
        failures = 0;
        const event = JSON.parse(message.data) as PublicStreamEvent;
        setFeed((prev) => ({ ...prev, events: mergeFeedEvents(prev.events, [event]), status: event.type === "auction.closed" ? "closed" : prev.status }));
        if (event.type === "auction.closed") source?.close();
      };
      for (const type of FEED_TYPES) source.addEventListener(type, onEvent as EventListener);
      source.addEventListener("tick", ((message: MessageEvent<string>) => {
        failures = 0;
        const tick = JSON.parse(message.data) as { seconds_left: number; status: PublicStream["status"] };
        setFeed((prev) => (prev.status === "closed" ? prev : { ...prev, seconds_left: tick.seconds_left, status: tick.status }));
      }) as EventListener);
      source.onerror = () => {
        failures += 1;
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

  // The poster's view, only with a token held in this browser. The token travels in a header.
  useEffect(() => {
    if (!token || initial.status === "no_auction") return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/requests/${requestId}/result?wait=0`, { cache: "no-store", headers: { "x-haggleboard-delete-token": token } });
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

  const view = useMemo(() => liveView(feed, now, { still, hit }), [feed, now, still, hit]);

  if (feed.status === "no_auction") {
    return (
      <div className="section section--tight">
        <div className="empty">
          <strong>No clock on this one.</strong>
          <p>It was posted before timed haggles started, so there&apos;s nothing to watch. The public prices stores listed for it are below.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Room id="live-room" className="room--page" view={view} logEmpty="Quiet so far. Stores that may carry it are being asked." />
      {token ? <PosterPanel requestId={requestId} token={token} poster={poster} closed={view.closed} outcome={outcome} onOutcome={setOutcome} /> : null}
    </>
  );
}

function PosterPanel({ requestId, token, poster, closed, outcome, onOutcome }: { requestId: string; token: string; poster: PosterAuction | null; closed: boolean; outcome: Outcome | null; onOutcome: (o: Outcome) => void }) {
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
  const winner = poster?.winner ?? null;
  const standing = poster?.standing ?? [];
  return (
    <section className="section section--tight" aria-labelledby="mine-h">
      <div className="private">
        <h2 id="mine-h">{closed ? "Your result. Only you see this." : "Your offers. Only you see this."}</h2>
        <p>You posted this, so you see the amounts. Everyone else sees who leads and roughly how much cheaper.</p>
        {closed && winner ? (
          <>
            <p>
              {poster?.result?.kind === "last_seen" ? "Best last-seen price, not confirmed today." : winner.source === "private_offer" ? "Winning offer: made to you, privately." : "Winning offer:"}{" "}
              <b>
                {formatPublicPrice(winner.price, winner.currency) ?? winner.price} at {storeName(winner.store_domain)}
              </b>
              {winner.source !== "public_price" && winner.list_price ? `. Its public price is ${formatPublicPrice(winner.list_price, winner.currency) ?? winner.list_price}.` : "."}
            </p>
            <div className="acts">
              <a className="btn" href={winner.checkout_url} rel="noopener noreferrer nofollow" target="_blank">
                Buy at {storeName(winner.store_domain)}
              </a>
            </div>
            <p>That opens the store&apos;s own page. You check out there, with them. We never take payment. Price and stock can change; the store&apos;s page is what counts.</p>
          </>
        ) : null}
        {standing.length ? (
          <ol>
            {standing.slice(0, 6).map((entry) => (
              <li key={`${entry.store_domain}-${entry.source}`}>
                <span>
                  {entry.rank}. {storeName(entry.store_domain)}{" "}
                  <small>
                    {entry.source === "public_price" ? `public price, ${priceNote({ confirmed: entry.confirmed, stale: entry.stale, observed_at: entry.observed_at })}` : entry.source === "private_offer" ? "offer to you only" : "store bid"}
                    {entry.available ? "" : ", sold out"}
                    {entry.test ? ", test store" : ""}
                  </small>
                </span>
                <b>{formatPublicPrice(entry.price, entry.currency) ?? entry.price}</b>
              </li>
            ))}
          </ol>
        ) : (
          <p>{poster ? "No offers yet." : "Loading your offers."}</p>
        )}
        {closed && winner ? (
          <div className="acts">
            {outcome ? (
              <p>Noted. Thanks.</p>
            ) : (
              <>
                <button type="button" className="btn btn--ink btn--small" disabled={sending} onClick={() => report("bought_at_winner")}>
                  Bought it there
                </button>
                <button type="button" className="btn btn--line btn--small" disabled={sending} onClick={() => report("bought_elsewhere")}>
                  Bought elsewhere
                </button>
                <button type="button" className="btn btn--line btn--small" disabled={sending} onClick={() => report("did_not_buy")}>
                  Didn&apos;t buy
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
