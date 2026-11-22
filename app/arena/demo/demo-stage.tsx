"use client";

import { useCallback, useState } from "react";
import { Arena } from "../../../components/arena/arena";
import { AgentScorecard, BiggestSaves } from "../../../components/arena/gamification";
import { ResultCard } from "../../../components/arena/result-card";
import { DEMO_BIGGEST_SAVES, DEMO_SCORECARD, FULL_SCRIPT } from "../../../lib/arena-demo";

const close = FULL_SCRIPT.events.find((e) => e.kind === "close");

export function DemoStage() {
  // Shown by default so the page is complete without JS or with reduced motion.
  const [showResult, setShowResult] = useState(true);
  const [justClosed, setJustClosed] = useState(0);
  const onClose = useCallback(() => {
    setShowResult(true);
    setJustClosed((n) => n + 1);
  }, []);
  const onPlay = useCallback(() => setShowResult(false), []);
  const winner = close && close.kind === "close" ? FULL_SCRIPT.bidders.find((b) => b.id === close.winner)?.name ?? "" : "";

  return (
    <div className="demo-stage">
      <Arena
        request={FULL_SCRIPT.request}
        durationSec={FULL_SCRIPT.durationSec}
        bidders={FULL_SCRIPT.bidders}
        events={FULL_SCRIPT.events}
        demo
        variant="full"
        perspective="shopper"
        speed={6}
        loop={false}
        controls
        onClose={onClose}
        onPlay={onPlay}
      />
      <aside className="demo-side" aria-label="Result and scores">
        <div className={`demo-result${justClosed ? " is-fresh" : ""}`} key={justClosed}>
          {close && close.kind === "close" && showResult ? (
            <ResultCard
              request={FULL_SCRIPT.request}
              winner={winner}
              savedPct={close.saved_pct}
              wonAtSec={close.won_at}
              demo
            />
          ) : (
            <div className="result-pending" role="status">
              <p>Your result card lands here at 0:00.</p>
              <p className="meta">The lead can change hands right up to the last second.</p>
            </div>
          )}
        </div>
        <AgentScorecard {...DEMO_SCORECARD} demo />
        <BiggestSaves items={DEMO_BIGGEST_SAVES} demo />
      </aside>
    </div>
  );
}
