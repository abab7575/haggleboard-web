"use client";

import { useEffect, useRef, useState } from "react";
import { Room } from "../brand/room";
import { replayTiming, ringFrame, type RingMeta, type RingRow } from "./frame";

/**
 * Plays a finished round back in the room, on a loop, with the last ten seconds slowed down so
 * the gavel gets its moment. Pauses off screen and in a hidden tab. With reduced motion it shows
 * the whole round at once, still. `?t=<seconds>` (and `&hit`) freezes a frame, for screenshots.
 */
export function RingReplay({ meta, rows, id }: { meta: RingMeta; rows: RingRow[]; id?: string }) {
  const timing = replayTiming(meta.window_seconds);
  const [real, setReal] = useState(0);
  const [mode, setMode] = useState<"play" | "still" | "frozen">("play");
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (params.has("t")) {
      setFrozenAt(Number(params.get("t")) || 0);
      setMode("frozen");
      return;
    }
    if (reduce.matches || params.has("still")) {
      setMode("still");
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMode("still");
    };
    reduce.addEventListener?.("change", onChange);
    return () => reduce.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (mode !== "play" || !playing) return;
    let visible = true;
    let raf = 0;
    let last = performance.now();
    let acc = real;
    const tick = (now: number) => {
      if (visible && !document.hidden) acc = (acc + (now - last) / 1000) % timing.loop;
      last = now;
      // Ten frames a second is plenty: the clock moves per second, and the motion itself runs in CSS and WAAPI.
      setReal((prev) => (Math.floor(prev * 10) === Math.floor(acc * 10) ? prev : acc));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const io =
      "IntersectionObserver" in window && id && document.getElementById(id)
        ? new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true;
          })
        : null;
    if (io && id) io.observe(document.getElementById(id)!);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, playing, timing.loop]);

  const t = mode === "still" ? meta.window_seconds + 5 : mode === "frozen" ? (frozenAt ?? 0) : timing.toRound(real);
  const afterSold = mode === "play" ? real - timing.soldReal : t - meta.window_seconds;
  const frame = ringFrame(meta, rows, mode === "still" ? meta.window_seconds : t, { still: mode === "still", hitWindow: mode === "frozen" ? 99 : 1.2 });
  const view = { ...frame, hit: mode === "frozen" ? new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).has("hit") && frame.done : frame.done && afterSold >= 0 && afterSold < 1.2 };
  if (mode === "still") view.gavel = "rest";

  return (
    <div ref={root} className="replay-wrap" style={{ display: "contents" }}>
      <Room
        id={id}
        view={view}
        logNote={mode === "still" ? "Motion's off, so here's the whole round at once." : undefined}
        controls={
          mode === "play" ? (
            <button className="replay" type="button" aria-pressed={!playing} onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
          ) : null
        }
      />
    </div>
  );
}
