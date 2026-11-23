"use client";

import { useEffect, useState } from "react";
import { LINKS_TEXT, scoreboard, type StatsLike } from "../../lib/experiment";

/**
 * The six links, live. Starts from the numbers the server read from the log, then re-reads
 * /api/stats every 30 seconds while the page is open. Nothing here is estimated.
 */
export function LiveScoreboard({ initial }: { initial: StatsLike | null }) {
  const [stats, setStats] = useState<StatsLike | null>(initial);
  useEffect(() => {
    const read = async () => {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (res.ok) setStats((await res.json()) as StatsLike);
      } catch {
        // keep the last numbers
      }
    };
    const timer = window.setInterval(read, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = scoreboard(stats);
  return (
    <>
      <div className="linkgrid">
        {rows.map((row, i) => (
          <article className="link" key={row.n} aria-labelledby={`link-${row.n}`}>
            <span className="n">{row.n}</span>
            <div>
              <h3 id={`link-${row.n}`}>{row.title}</h3>
              <p>
                <b>We count:</b> {LINKS_TEXT[i]!.count}
              </p>
              <p>
                <b>Right if:</b> {row.right} <b>Wrong if:</b> {row.wrong}
              </p>
            </div>
            <div className="score">
              {row.value != null ? (
                <>
                  <b>{row.value}</b>
                  <span>{row.unit}</span>
                </>
              ) : (
                <span className="off">{row.status}</span>
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="small" style={{ marginTop: 14 }}>
        {stats?.as_of ? `Counted ${stats.as_of.slice(0, 16).replace("T", " ")} UTC from ` : "Counted from "}
        <a href="/api/stats">/api/stats</a>. Outside traffic only. Practice rounds never count here.
      </p>
    </>
  );
}
