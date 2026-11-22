"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  arenaStateAt,
  bandText,
  clockLabel,
  savedText,
  durationWords,
  rankBidders,
  type ArenaState,
  type PublicArenaEvent,
  type PublicBidder,
} from "../../lib/arena";
import { DemoLabel } from "./demo-label";

export type ArenaProps = {
  /** Public label of what the agent asked for. No shopper details. */
  request: string;
  /** Length of the clock in seconds. The deadline is opensAt + durationSec. */
  durationSec: number;
  /** Stores that may appear. Lanes are ranked: leader on top, then by band. */
  bidders: PublicBidder[];
  /** Public events only (run raw data through toPublicArenaEvents first). */
  events: PublicArenaEvent[];
  /** True for scripted data. Shows a visible demo label. */
  demo: boolean;
  variant?: "hero" | "full";
  /** "shopper": the finish speaks to the person whose agent asked. */
  perspective?: "shopper" | "public";
  /** Demo playback: clock seconds per real second. */
  speed?: number;
  loop?: boolean;
  /** How long the finish holds before a loop restarts. */
  holdMs?: number;
  /** Live mode: ISO time the clock opened. When set the clock follows real time. */
  opensAt?: string;
  /** Render the finished story only (no playback), as reduced motion does. */
  startStatic?: boolean;
  /** Full variant: show playback controls. */
  controls?: boolean;
  /** Called once a played-through clock reaches its close. */
  onClose?: () => void;
  /** Called when playback (re)starts from the top. */
  onPlay?: () => void;
  /** Line under the request. Defaults to the demo's "No price given" line. */
  requestNote?: string;
  /** The privacy line at the foot of the arena. */
  privacyNote?: string;
  /** Shown in place of lanes while no store has answered (live auctions). */
  emptyLanes?: string;
  /** Live auctions: hide the in-arena finish banner when the page shows a result card instead. */
  hideFinish?: boolean;
};

type Mode = "static" | "playing" | "paused" | "done";

const INTRO_SEC = 0.7;

export function Arena({
  request,
  durationSec,
  bidders,
  events,
  demo,
  variant = "hero",
  perspective = "shopper",
  speed = 24,
  loop = true,
  holdMs = 3200,
  opensAt,
  startStatic = false,
  controls = false,
  onClose,
  onPlay,
  requestNote = "No price given. Stores have to come to it.",
  privacyNote = "Everyone sees who is bidding, who leads and a rough band. The prices stay between each store and the asking agent.",
  emptyLanes,
  hideFinish = false,
}: ArenaProps) {
  const lastAt = events.length ? events[events.length - 1].at : 0;
  const finalT = opensAt ? lastAt : durationSec;
  const [mode, setMode] = useState<Mode>("static");
  const [t, setT] = useState<number>(finalT);
  const [rate, setRate] = useState(speed);
  const [cycle, setCycle] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const elapsed = useRef(0);
  const visible = useRef(true);
  const closedFired = useRef(false);

  const state = useMemo(() => arenaStateAt(events, bidders, durationSec, t), [events, bidders, durationSec, t]);
  const finished = useMemo(
    () => arenaStateAt(events, bidders, durationSec, Math.max(durationSec, lastAt)),
    [events, bidders, durationSec, lastAt],
  );

  const restart = useCallback(() => {
    elapsed.current = 0;
    closedFired.current = false;
    setT(-INTRO_SEC * rate);
    setCycle((c) => c + 1);
    setMode("playing");
    onPlay?.();
  }, [rate, onPlay]);

  // Start playback unless the visitor prefers reduced motion.
  useEffect(() => {
    if (startStatic) return;
    if (opensAt) {
      setMode("playing");
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!query.matches) restart();
    const onChange = () => {
      if (query.matches) {
        setMode("static");
        setT(finalT);
      }
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startStatic, opensAt]);

  // Pause while offscreen.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      visible.current = entry.isIntersecting;
    });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  // Live clock.
  useEffect(() => {
    if (!opensAt || mode !== "playing") return;
    const opened = Date.parse(opensAt);
    const tick = () => setT(Math.min(durationSec, Math.max(0, (Date.now() - opened) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [opensAt, mode, durationSec]);

  // Demo playback.
  useEffect(() => {
    if (opensAt || mode !== "playing") return;
    let raf = 0;
    let last = performance.now();
    const runSec = durationSec / rate;
    const total = INTRO_SEC + runSec + holdMs / 1000;
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (visible.current && !document.hidden) elapsed.current += dt;
      const e = elapsed.current;
      if (e >= total) {
        if (loop) {
          elapsed.current = 0;
          closedFired.current = false;
          setCycle((c) => c + 1);
          setT(-INTRO_SEC * rate);
          onPlay?.();
        } else {
          setT(durationSec);
          setMode("done");
          return;
        }
      } else {
        const next = Math.min(durationSec, (e - INTRO_SEC) * rate);
        setT(next);
        if (next >= durationSec && !closedFired.current) {
          closedFired.current = true;
          onClose?.();
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mode, rate, durationSec, holdMs, loop, opensAt, onClose, onPlay]);

  const ranked = useMemo(() => rankBidders(state.bidders), [state.bidders]);
  const orderKey = ranked.map((b) => b.bidder.id).join(",");
  const laneRefs = useRef(new Map<string, HTMLLIElement>());
  const prevTops = useRef(new Map<string, number>());

  // FLIP: when the order changes, slide each lane from where it was. An
  // overtaking store visibly passes the one it beat.
  useLayoutEffect(() => {
    const still =
      mode === "static" ||
      (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    laneRefs.current.forEach((el, id) => {
      const top = el.offsetTop;
      const prev = prevTops.current.get(id);
      if (!still && prev != null && prev !== top && typeof el.animate === "function") {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }], {
          duration: 520,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        });
      }
      prevTops.current.set(id, top);
    });
  }, [orderKey, mode]);

  const isStatic = mode === "static";
  const intro = t < 0;
  const leader = state.bidders.find((b) => b.leading) ?? null;
  const winnerName = state.close?.winner ? bidders.find((b) => b.id === state.close?.winner)?.name ?? "A store" : null;
  const progress = Math.max(0, Math.min(1, state.remaining / durationSec));
  const latest = state.commentary.slice(-3);

  return (
    <section
      ref={rootRef}
      className={`arena arena--${variant}`}
      data-phase={intro ? "intro" : state.phase}
      data-mode={mode}
      aria-label={demo ? "Demo auction with made-up stores" : "Auction"}
    >
      <header className="arena-head">
        {demo ? <DemoLabel /> : <span className={`live-label${state.close ? " is-closed" : ""}`}>{state.close ? "Closed" : "Live"}</span>}
        <span className="arena-speed">
          {opensAt ? `Real-time clock, ${durationWords(durationSec)}` : isStatic ? "Two-minute clock, finished" : `Two-minute clock${rate > 1 ? `, ${rate}x speed` : ""}`}
        </span>
      </header>

      <div className="arena-request" key={`req-${cycle}`}>
        <p className="arena-request-label">{perspective === "shopper" ? "Your agent asked for" : "An agent asked for"}</p>
        <p className="arena-request-text">{request}</p>
        <p className="arena-request-note">{requestNote}</p>
      </div>

      <div className="arena-clock" aria-hidden={isStatic ? undefined : true}>
        <span className="arena-clock-num" key={state.phase === "final" ? Math.ceil(state.remaining) : "steady"}>
          {clockLabel(state.remaining)}
        </span>
        <span className="arena-clock-word">{state.close
            ? "Closed"
            : opensAt && state.remaining <= 0
              ? "Time. Counting offers"
              : state.phase === "final"
                ? "Final seconds"
                : "left on the clock"}</span>
        <span className="arena-clock-bar">
          <span style={{ transform: `scaleX(${progress})` }} />
        </span>
      </div>

      <ol className="arena-lanes" aria-label="Stores bidding">
        {ranked.length === 0 && emptyLanes ? <li className="lane lane--empty">{emptyLanes}</li> : null}
        {ranked.map((b) => {
          const x = b.band == null ? 0 : Math.min(1, b.band / 20);
          const won = state.close?.winner === b.bidder.id;
          return (
            <li
              key={b.bidder.id}
              ref={(el) => {
                if (el) laneRefs.current.set(b.bidder.id, el);
                else laneRefs.current.delete(b.bidder.id);
              }}
              className={`lane tone-${b.bidder.tone}${b.joined ? " is-in" : " is-waiting"}${b.leading ? " is-leading" : ""}${won ? " is-winner" : ""}`}
            >
              <span className="lane-name">
                <span className="lane-chip" aria-hidden="true">
                  {b.bidder.name.slice(0, 1)}
                </span>
                <span className="lane-label">{b.joined ? b.bidder.name : "Waiting"}</span>
              </span>
              <span className="lane-track" aria-hidden="true">
                <span className="lane-runner" style={{ transform: `translateX(${x * 100}%)` }}>
                  <span className="lane-token" />
                </span>
              </span>
              <span className="lane-band">
                {b.joined && b.bidder.publicPrice ? (
                  <span className="lane-price" title="The store's public list price">
                    {b.bidder.publicPrice}
                    <small> public price</small>
                  </span>
                ) : null}
                {b.joined
                  ? b.band == null || (b.bidder.publicPrice && !b.leading)
                    ? b.bidder.publicPrice
                      ? null
                      : "in, no lead yet"
                    : bandText(b.band, b.label)
                  : ""}
              </span>
              {b.leading ? (
                <span className="lane-stamp" key={`${state.leadKey}-${won ? "won" : "lead"}`}>
                  {won ? "Won" : "Lead"}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="arena-scale" aria-hidden="true">
        <span className="arena-scale-track">
          {["list", "5%", "10%", "15%", "20%+"].map((label, i) => (
            <span key={label} style={{ left: `${i * 25}%` }}>
              {label}
            </span>
          ))}
        </span>
      </div>

      {isStatic ? (
        <StaticStory
          state={finished}
          events={events}
          durationSec={durationSec}
          request={request}
          bidders={bidders}
          variant={variant}
          perspective={perspective}
        />
      ) : (
        <ol className="arena-commentary" aria-live="polite">
          {intro || latest.length === 0 ? (
            <li className="tone-info is-new">{perspective === "shopper" ? "Your agent posted it." : "Request posted."} The clock is running.</li>
          ) : (
            latest.map((line, i) => (
              <li key={`${cycle}-${line.at}-${line.text}`} className={`tone-${line.tone}${i === latest.length - 1 ? " is-new" : ""}`}>
                {line.text}
              </li>
            ))
          )}
        </ol>
      )}

      {state.close && !isStatic && !hideFinish ? (
        <Finish key={`fin-${cycle}`} close={state.close} winner={winnerName} perspective={perspective} />
      ) : null}

      <p className="arena-privacy">{privacyNote}</p>

      {controls ? (
        <div className="arena-controls">
          <button type="button" onClick={restart}>
            {mode === "static" ? "Play the auction" : "Replay"}
          </button>
          {mode === "playing" && !opensAt ? (
            <button type="button" className="ghost" onClick={() => setMode("paused")}>
              Pause
            </button>
          ) : null}
          {mode === "paused" ? (
            <button type="button" className="ghost" onClick={() => setMode("playing")}>
              Resume
            </button>
          ) : null}
          {!opensAt ? (
            <button
              type="button"
              className="ghost"
              aria-pressed={rate === 1}
              onClick={() => {
                const next = rate === 1 ? speed : 1;
                // Keep the clock where it is when switching speed.
                elapsed.current = INTRO_SEC + Math.max(0, t) / next;
                setRate(next);
              }}
            >
              {rate === 1 ? `Speed up (${speed}x)` : "Watch in real time"}
            </button>
          ) : null}
        </div>
      ) : null}
      {leader && !state.close ? <span className="sr-only">{leader.bidder.name} leads.</span> : null}
    </section>
  );
}

function Finish({
  close,
  winner,
  perspective,
}: {
  close: NonNullable<ArenaState["close"]>;
  winner: string | null;
  perspective: "shopper" | "public";
}) {
  if (!winner) {
    return (
      <div className="arena-finish" role="status">
        <p className="arena-finish-winner">Clock&apos;s out</p>
        <p className="arena-finish-big">No winner</p>
        <p className="arena-finish-sub">No store had it in stock when the clock ran out.</p>
      </div>
    );
  }
  if (close.label || close.saved_pct == null) {
    return (
      <div className="arena-finish" role="status">
        <p className="arena-finish-winner">{winner} wins</p>
        <p className="arena-finish-big arena-finish-big--words">{savedText(close)}</p>
        <p className="arena-finish-sub">Winning offer in after {durationWords(close.won_at)}.</p>
      </div>
    );
  }
  return (
    <div className="arena-finish" role="status">
      <p className="arena-finish-winner">{winner} wins</p>
      <p className="arena-finish-big">
        {perspective === "shopper" ? "Your agent saved you " : "Saved "}
        <strong>{close.saved_pct}%</strong>
      </p>
      <p className="arena-finish-sub">Under the best public price, in {durationWords(close.won_at)}.</p>
    </div>
  );
}

function StaticStory({
  state,
  events,
  durationSec,
  request,
  bidders,
  variant,
  perspective,
}: {
  state: ArenaState;
  events: PublicArenaEvent[];
  durationSec: number;
  request: string;
  bidders: PublicBidder[];
  variant: "hero" | "full";
  perspective: "shopper" | "public";
}) {
  const close = state.close;
  const winner = close?.winner ? bidders.find((b) => b.id === close.winner)?.name ?? "A store" : null;
  const leadNames: string[] = [];
  for (const e of events) {
    if (e.kind !== "lead") continue;
    const name = bidders.find((b) => b.id === e.bidder)?.name ?? "A store";
    if (leadNames[leadNames.length - 1] !== name) leadNames.push(name);
  }
  const joined = state.bidders.filter((b) => b.joined).length;
  return (
    <div className="arena-story" data-story="">
      {variant === "full" ? (
        <ol className="arena-story-list">
          <li className="tone-info">{perspective === "shopper" ? "Your agent posted" : "An agent posted"}: {request}. The clock starts.</li>
          {state.commentary.filter((line) => line.tone !== "close").map((line) => (
            <li key={`${line.at}-${line.text}`} className={`tone-${line.tone}`}>
              <span className="arena-story-time">{clockLabel(durationSec - line.at)}</span> {line.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="arena-story-summary">
          {perspective === "shopper" ? "Your agent posted it" : "The request went up"}. {joined} stores joined. The lead
          changed hands {Math.max(0, leadNames.length - 1)} times: {leadNames.join(", then ")}.
        </p>
      )}
      {close && !winner ? (
        <p className="arena-story-close">
          <strong>No winner.</strong> No store had it in stock when the clock ran out.
        </p>
      ) : null}
      {close && winner && close.saved_pct == null ? (
        <p className="arena-story-close">
          <strong>{winner} wins</strong>, {savedText(close)}. Winning offer in after {durationWords(close.won_at)}.
        </p>
      ) : null}
      {close && winner && close.saved_pct != null ? (
        <p className="arena-story-close">
          <strong>{winner} wins</strong>, {close.saved_pct}% under the best public price, in {durationWords(close.won_at)}.
          {perspective === "shopper" ? ` Your agent saved you ${close.saved_pct}%.` : ""}
        </p>
      ) : null}
    </div>
  );
}
