"use client";

import { useState } from "react";
import { durationWords, resultLine } from "../../lib/arena";
import { DemoLabel } from "./demo-label";

export type ResultCardProps = {
  request: string;
  winner: string;
  /** Exact percent under the best public price (the demo publishes it at the close). */
  savedPct?: number | null;
  /**
   * Live auctions: the band's words, such as "5 to 10% under the best public price". Only the band
   * is public, so a live card shows it instead of an exact percent.
   */
  bandLabel?: string;
  /** Seconds after the clock opened that the winning offer took first place. */
  wonAtSec: number;
  /** Length of the clock, for live cards. */
  windowSec?: number;
  /** How many stores answered, for live cards. */
  stores?: number;
  demo: boolean;
  perspective?: "shopper" | "public";
  /** Only when the winning store chose to publish it. */
  revealedPrice?: string;
  /** Show copy and share buttons. */
  share?: boolean;
  /** Public page to share with the result (never a private link). */
  shareUrl?: string;
  /** Live: "last_seen" when no store confirmed a price during the auction. Never shown as "Won". */
  resultKind?: "won" | "last_seen";
  /** Live: when the winning public price was seen ("confirmed today", "last seen 18 Oct, not confirmed"). */
  priceNote?: string | null;
  /** Live: fictional test stores took part (TEST_STORES=1 only). */
  testStores?: boolean;
};

/** Headline words for a band, short enough for the big line on the card. */
function bandHeadline(label: string): { big: string; rest: string } {
  const under = label.match(/^(.*?%) under (.*)$/);
  if (under) return { big: under[1]!, rest: `under ${under[2]}` };
  if (label === "at the best public price") return { big: "Lowest price", rest: "of the public prices. No store went under it this time." };
  if (label === "above the best public price") return { big: "Above", rest: "the best public price" };
  if (label === "within 5% of the best public price") return { big: "Within 5%", rest: "of the best public price" };
  if (label === "private offer") return { big: "Private offer", rest: "Only the asking agent sees the amount. No band is shown for this one." };
  return { big: "Winner", rest: label };
}

/** A receipt-style card sized for sharing (1.91:1, like an Open Graph image). */
export function ResultCard({
  request,
  winner,
  savedPct = null,
  bandLabel,
  wonAtSec,
  windowSec,
  stores,
  demo,
  perspective = "shopper",
  revealedPrice,
  share = true,
  shareUrl,
  resultKind = "won",
  priceNote,
  testStores = false,
}: ResultCardProps) {
  const [copied, setCopied] = useState(false);
  const lastSeen = resultKind === "last_seen";
  const line = lastSeen
    ? `Best last-seen price was at ${winner}, not confirmed today.`
    : resultLine(savedPct, wonAtSec, perspective, winner, bandLabel);
  const shareText = `${line}${demo ? " (HaggleBoard demo with made-up stores.)" : testStores ? " (Local test with made-up stores.)" : ""}`;
  const headline = lastSeen
    ? { big: "Not confirmed", rest: "Best last-seen price, not confirmed today" }
    : bandLabel
      ? bandHeadline(bandLabel)
      : null;

  const onShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share(shareUrl ? { text: shareText, url: shareUrl } : { text: shareText });
        return;
      }
      await navigator.clipboard.writeText(shareUrl ? `${shareText} ${shareUrl}` : shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The visitor closed the share sheet or the clipboard is blocked. Nothing to do.
    }
  };

  return (
    <figure className={`result-card${headline ? " result-card--band" : ""}`} data-demo={demo ? "true" : undefined}>
      <div className="result-card-face">
        <div className="result-card-top">
          <span className="result-card-brand">
            <span className="seal seal--small" aria-hidden="true">
              Hb
            </span>
            HaggleBoard
          </span>
          {demo ? (
            <DemoLabel text="Demo result" />
          ) : testStores ? (
            <span className="test-stores-label">Test stores</span>
          ) : (
            <span className="result-card-real">Real auction</span>
          )}
        </div>
        {headline ? (
          <p className="result-card-pct result-card-pct--band">
            <strong>{headline.big}</strong>
            <span>{headline.rest}</span>
          </p>
        ) : (
          <p className="result-card-pct">
            <strong>{savedPct ?? 0}%</strong>
            <span>under the best public price</span>
          </p>
        )}
        <p className="result-card-line">{line}</p>
        <dl className="result-card-facts">
          <div>
            <dt>Asked for</dt>
            <dd>{request}</dd>
          </div>
          <div>
            <dt>{lastSeen ? "Last seen at" : "Winner"}</dt>
            <dd>{winner}</dd>
          </div>
          {priceNote ? (
            <div>
              <dt>Price date</dt>
              <dd>{priceNote}</dd>
            </div>
          ) : null}
          {windowSec != null ? (
            <div>
              <dt>Winning offer in</dt>
              <dd>
                {wonAtSec < 1 ? "At the open" : `After ${durationWords(wonAtSec)}`} (clock: {durationWords(windowSec)})
              </dd>
            </div>
          ) : (
            <div>
              <dt>Won in</dt>
              <dd>{durationWords(wonAtSec)}</dd>
            </div>
          )}
          {stores != null ? (
            <div>
              <dt>Stores in</dt>
              <dd>{stores}</dd>
            </div>
          ) : null}
          {revealedPrice ? (
            <div>
              <dt>Price (shown by the store)</dt>
              <dd>{revealedPrice}</dd>
            </div>
          ) : null}
        </dl>
        <span className={`result-card-stamp${lastSeen ? " result-card-stamp--unconfirmed" : ""}`} aria-hidden="true">
          {lastSeen ? "Last seen" : "Won"}
        </span>
      </div>
      {share ? (
        <figcaption className="result-card-actions">
          <button type="button" onClick={onShare}>
            {copied ? "Copied" : "Share this result"}
          </button>
          <span className="meta">{demo ? "Shares as a demo, so nobody mistakes it for a real deal." : "Shares the public page only. Checkout is on the store's own site."}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
