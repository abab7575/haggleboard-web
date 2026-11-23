"use client";

import { useEffect, useState } from "react";
import type { PublicStream, PublicStreamEvent } from "../lib/stream";

/**
 * A plain, functional live view of one request's public event stream. Placeholder for the arena
 * component, which takes the same props: { requestLabel, deadline, events[] }.
 */
export function LiveAuction({ requestId, initial }: { requestId: string; initial: PublicStream }) {
  const [state, setState] = useState<PublicStream>(initial);
  const [now, setNow] = useState<number>(() => Date.parse(initial.now));

  useEffect(() => {
    if (initial.status === "no_auction") return;
    let stopped = false;
    let source: EventSource | null = null;
    const merge = (event: PublicStreamEvent) =>
      setState((prev) => (prev.events.some((e) => e.seq === event.seq) ? prev : { ...prev, events: [...prev.events, event] }));
    const poll = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`/api/requests/${requestId}/events`, { cache: "no-store" });
          if (res.ok) {
            const next = (await res.json()) as PublicStream;
            setState(next);
            if (next.status === "closed") return;
          }
        } catch {
          // try again
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    if (typeof EventSource !== "undefined") {
      source = new EventSource(`/api/requests/${requestId}/stream`);
      for (const type of ["auction.opened", "store.joined", "lead.changed", "auction.closed"]) {
        source.addEventListener(type, (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as PublicStreamEvent;
          merge(event);
          if (event.type === "auction.closed") {
            setState((prev) => ({ ...prev, status: "closed" }));
            source?.close();
          }
        });
      }
      source.onerror = () => {
        if (source && source.readyState === EventSource.CLOSED) void poll();
      };
    } else {
      void poll();
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      source?.close();
      clearInterval(timer);
    };
  }, [requestId, initial.status]);

  if (state.status === "no_auction" || !state.deadline) {
    return <p className="meta">This request was posted before timed auctions and has no live window.</p>;
  }
  const left = Math.max(0, Math.ceil((Date.parse(state.deadline) - now) / 1000));
  const closed = state.events.find((event) => event.type === "auction.closed");
  return (
    <section className="panel live-auction">
      <h2>Live</h2>
      <p className="meta">
        {closed ? "Closed." : left > 0 ? `${left} seconds left.` : "Closing."} Deadline {state.deadline.slice(11, 19)} UTC.
        Private offer amounts are never shown here.
      </p>
      <ol>
        {state.events.map((event) => (
          <li key={event.seq}>
            <span className="meta">{event.at.slice(11, 19)} </span>
            {describe(event)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function describe(event: PublicStreamEvent): string {
  switch (event.type) {
    case "auction.opened":
      return `Window opened for ${event.window_seconds} seconds.`;
    case "store.joined":
      return event.public_price
        ? `${event.store} joined with a public price of ${event.public_price} ${event.currency ?? ""}.`
        : `${event.store} joined with a private offer.`;
    case "price.confirmed":
      return `${event.store} confirmed its public price live: ${event.public_price} ${event.currency ?? ""}.`;
    case "store.withdrawn":
      return `${event.store}: no longer listed. Its old snapshot price is out.`;
    case "lead.changed":
      return `${event.store} took the lead (${event.band_label}).`;
    case "auction.closed":
      if (event.winner && event.result === "last_seen") {
        return `Closed. ${event.result_label}: ${event.winner.store}. ${event.bidders} stores, ${event.lead_changes} lead changes.`;
      }
      return event.winner
        ? `Closed. ${event.winner.store} won (${event.band_label}). ${event.bidders} stores, ${event.lead_changes} lead changes.`
        : `Closed with no offer in stock. ${event.bidders} stores answered.`;
  }
}
