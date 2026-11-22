"use client";

import { useState } from "react";
import { durationWords, resultLine } from "../../lib/arena";
import { DemoLabel } from "./demo-label";

export type ResultCardProps = {
  request: string;
  winner: string;
  /** Exact percent under the best public price (public at the close). */
  savedPct: number;
  /** Seconds after the clock opened that the winning bid landed. */
  wonAtSec: number;
  demo: boolean;
  perspective?: "shopper" | "public";
  /** Only when the winning store chose to publish it. */
  revealedPrice?: string;
  /** Show copy and share buttons. */
  share?: boolean;
};

/** A receipt-style card sized for sharing (1.91:1, like an Open Graph image). */
export function ResultCard({
  request,
  winner,
  savedPct,
  wonAtSec,
  demo,
  perspective = "shopper",
  revealedPrice,
  share = true,
}: ResultCardProps) {
  const [copied, setCopied] = useState(false);
  const line = resultLine(savedPct, wonAtSec, perspective, winner);
  const shareText = `${line}${demo ? " (HaggleBoard demo with made-up stores.)" : ""}`;

  const onShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text: shareText });
        return;
      }
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The visitor closed the share sheet or the clipboard is blocked. Nothing to do.
    }
  };

  return (
    <figure className="result-card" data-demo={demo ? "true" : undefined}>
      <div className="result-card-face">
        <div className="result-card-top">
          <span className="result-card-brand">
            <span className="seal seal--small" aria-hidden="true">
              Hb
            </span>
            HaggleBoard
          </span>
          {demo ? <DemoLabel text="Demo result" /> : null}
        </div>
        <p className="result-card-pct">
          <strong>{savedPct}%</strong>
          <span>under the best public price</span>
        </p>
        <p className="result-card-line">{line}</p>
        <dl className="result-card-facts">
          <div>
            <dt>Asked for</dt>
            <dd>{request}</dd>
          </div>
          <div>
            <dt>Winner</dt>
            <dd>{winner}</dd>
          </div>
          <div>
            <dt>Won in</dt>
            <dd>{durationWords(wonAtSec)}</dd>
          </div>
          {revealedPrice ? (
            <div>
              <dt>Price (shown by the store)</dt>
              <dd>{revealedPrice}</dd>
            </div>
          ) : null}
        </dl>
        <span className="result-card-stamp" aria-hidden="true">
          Won
        </span>
      </div>
      {share ? (
        <figcaption className="result-card-actions">
          <button type="button" onClick={onShare}>
            {copied ? "Copied" : "Share this result"}
          </button>
          <span className="meta">{demo ? "Shares as a demo, so nobody mistakes it for a real deal." : "Checkout happened on the store's own site."}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
