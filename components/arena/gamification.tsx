import { durationWords } from "../../lib/arena";
import { DemoLabel } from "./demo-label";

export type ScorecardProps = {
  agentName: string;
  dealsWon: number;
  /** Already formatted for the agent's owner, e.g. "$142". Private to that owner. */
  totalSaved: string;
  fastestWinSec: number;
  streak: number;
  demo: boolean;
};

/** The agent owner's own scorecard. Not a public leaderboard. */
export function AgentScorecard({ agentName, dealsWon, totalSaved, fastestWinSec, streak, demo }: ScorecardProps) {
  return (
    <article className="scorecard" aria-label={`${agentName} scorecard${demo ? " (demo)" : ""}`}>
      <header className="scorecard-head">
        <h3>{agentName}</h3>
        {demo ? <DemoLabel text="Demo scorecard" /> : null}
      </header>
      <dl className="scorecard-stats">
        <div>
          <dt>Deals won</dt>
          <dd>{dealsWon}</dd>
        </div>
        <div>
          <dt>Total saved</dt>
          <dd>{totalSaved}</dd>
        </div>
        <div>
          <dt>Fastest win</dt>
          <dd>
            <span aria-hidden="true">{`${Math.floor(fastestWinSec / 60)}m ${String(Math.round(fastestWinSec % 60)).padStart(2, "0")}s`}</span>
            <span className="sr-only">{durationWords(fastestWinSec)}</span>
          </dd>
        </div>
        <div>
          <dt>Win streak</dt>
          <dd>
            {streak}
            <span className="scorecard-flames" aria-hidden="true">
              {Array.from({ length: Math.min(streak, 5) }, (_, i) => (
                <svg key={i} viewBox="0 0 10 14" width="10" height="14">
                  <path d="M5 1C6 4 9 5 9 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-2-1-4 0-7z" />
                </svg>
              ))}
            </span>
          </dd>
        </div>
      </dl>
    </article>
  );
}

export type Badge = { id: string; label: string; description: string; earned: boolean };

const BADGE_ART: Record<string, string> = {
  "first-win": "M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.2 7 19l1.2-5.6L4 9.6 9.6 9z",
  buzzer: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 3v6l4 2",
  "three-peat": "M5 17l3-10 4 6 4-6 3 10",
  "big-save": "M6 18L18 6M8 7.5a1.5 1.5 0 1 0 0 .01M16 16.5a1.5 1.5 0 1 0 0 .01",
};

export function AgentBadges({ badges, demo }: { badges: Badge[]; demo: boolean }) {
  return (
    <div className="badges">
      {demo ? <DemoLabel text="Demo badges" /> : null}
      <ul className="badge-row">
        {badges.map((badge) => (
          <li key={badge.id} className={`badge${badge.earned ? " is-earned" : ""}`} title={badge.description}>
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <circle cx="12" cy="12" r="11" className="badge-ring" />
              <path d={BADGE_ART[badge.id] ?? BADGE_ART["first-win"]} className="badge-mark" />
            </svg>
            <span className="badge-text">
              <strong>{badge.label}</strong>
              <span>{badge.earned ? badge.description : `Not yet: ${badge.description.toLowerCase()}`}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type SaveItem = { request: string; winner: string; savedPct: number; wonAtSec: number };

/** Public strip: percent and time only, never an amount. */
export function BiggestSaves({ items, demo, title = "Biggest saves today" }: { items: SaveItem[]; demo: boolean; title?: string }) {
  return (
    <section className="saves" aria-label={`${title}${demo ? " (demo)" : ""}`}>
      <header className="saves-head">
        <h3>{title}</h3>
        {demo ? <DemoLabel text="Demo data" /> : null}
      </header>
      <ol className="saves-strip">
        {items.map((item, i) => (
          <li key={`${item.request}-${i}`}>
            <span className="saves-pct">{item.savedPct}%</span>
            <span className="saves-what">{item.request}</span>
            <span className="saves-who">
              {item.winner} · {durationWords(item.wonAtSec)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
