"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * THE ROOM. One presentational component for every haggle on the site: the practice ring, its
 * replays, and real haggles on /r/{id}. It draws what it is given and holds no data of its own:
 * the lot line, the auctioneer's call, a split-flap clock, the gavel in a white glove, stores
 * holding numbered paddles in front of a crowd, the clerk's sheet, and the sold stamp.
 *
 * The one orchestrated moment: "Going once" (gavel up), "Going twice" (higher), then it strikes,
 * the stamp slams, the room jolts. Everything else is small and answers a change.
 */

export type Sleeve = "heron" | "mac" | "stripe" | "fox";
export type Costume = { skin: string; skinDark: string; sleeve: Sleeve };

export const COSTUMES: Costume[] = [
  { skin: "#E9B896", skinDark: "#C99474", sleeve: "heron" },
  { skin: "#8D5A3B", skinDark: "#6E4329", sleeve: "mac" },
  { skin: "#C68A5E", skinDark: "#A46D45", sleeve: "stripe" },
  { skin: "#000000", skinDark: "#2B2B2B", sleeve: "fox" },
];

export type PaddleState = "down" | "up" | "lead" | "won" | "folded" | "out";
export type GavelState = "rest" | "up1" | "up2" | "down";

export type PaddleView = {
  id: string;
  no: number | string;
  name: string;
  /** What is written on the paddle: "96", "?", "Out", "$119.95", "Private". */
  amount: string;
  state: PaddleState;
  tag: string;
  costume: Costume;
};

export type LogRow = {
  key: string;
  time: string;
  who: string;
  whoKind: "agent" | "store" | "clerk";
  to?: string | null;
  amount?: string | null;
  lead?: boolean;
  quiet?: boolean;
  text: string;
  raw: unknown;
  sold?: boolean;
};

export type RoomView = {
  lotNo: string;
  lotText: string;
  tag: ReactNode;
  say: string;
  leading: ReactNode;
  seconds: number;
  tense: boolean;
  done: boolean;
  gavel: GavelState;
  hit: boolean;
  paddles: PaddleView[];
  log: LogRow[];
  /** One paragraph for screen readers: the whole story so far. */
  srSummary: string;
  clockLabel?: string;
  /** Motion off: no flips, no jabs, no slam. */
  still?: boolean;
};

const SLEEVES: Record<Sleeve, (id: string) => ReactNode> = {
  heron: (id) => (
    <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse">
      <rect width="14" height="14" fill="#3B3E86" />
      <path d="M0 7 L7 0 M7 14 L14 7 M0 7 L7 14 M7 0 L14 7" stroke="#5B5EA8" strokeWidth="2.2" />
    </pattern>
  ),
  mac: (id) => (
    <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
      <rect width="20" height="20" fill="#FFD23F" />
    </pattern>
  ),
  stripe: (id) => (
    <pattern id={id} width="20" height="22" patternUnits="userSpaceOnUse">
      <rect width="20" height="22" fill="#FFFFFF" />
      <rect y="11" width="20" height="11" fill="#12136B" />
    </pattern>
  ),
  fox: (id) => (
    <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse">
      <rect width="12" height="12" fill="#0E0E2E" />
      <path d="M6 0 V12" stroke="#3A3B7A" strokeWidth="1.4" />
    </pattern>
  ),
};

/** A hand holding the paddle's handle, in its sleeve. */
function LimbImpl({ costume, uid, className = "limb", short = false }: { costume: Costume; uid: string; className?: string; short?: boolean }) {
  const pid = `sl-${uid}`;
  const cuff = costume.sleeve === "fox" ? "#FF6AB0" : costume.sleeve === "mac" ? "#E8B92A" : "#FFFFFF";
  const height = short ? 300 : 560;
  return (
    <svg className={className} viewBox={`0 0 120 ${height}`} aria-hidden="true">
      <defs>{SLEEVES[costume.sleeve](pid)}</defs>
      <rect x="54" y="0" width="12" height="96" rx="3" fill="#12136B" />
      <polygon points={`34,150 86,150 ${short ? 98 : 104},${height} ${short ? 22 : 16},${height}`} fill={`url(#${pid})`} />
      {costume.sleeve === "mac" ? <path d={`M60 150 V${height}`} stroke="#E8B92A" strokeWidth="3" /> : null}
      <rect x="32" y="138" width="56" height="20" rx="4" fill={cuff} />
      <rect x="36" y="72" width="52" height="70" rx="20" fill={costume.skin} />
      <rect x="78" y="76" width="18" height="15" rx="7.5" fill={costume.skin} />
      <rect x="78" y="92" width="17" height="15" rx="7.5" fill={costume.skin} />
      <rect x="78" y="108" width="17" height="15" rx="7.5" fill={costume.skin} />
      <rect x="76" y="124" width="15" height="13" rx="6.5" fill={costume.skin} />
      <path d="M80 91.5 h10 M80 107.5 h10 M79 123.5 h9" stroke={costume.skinDark} strokeWidth="2.2" strokeLinecap="round" />
      <rect x="30" y="70" width="40" height="17" rx="8.5" fill={costume.skin} transform="rotate(-18 50 78)" />
      <path d="M44 74 q10 -4 20 -2" stroke={costume.skinDark} strokeWidth="2" fill="none" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

/** The gavel, in the agent's white auctioneer's glove. */
function GavelImpl() {
  return (
    <svg className="gavel" viewBox="0 0 260 200" aria-hidden="true">
      <ellipse cx="72" cy="190" rx="70" ry="9" fill="#0C0D52" opacity=".5" />
      <rect x="8" y="164" width="128" height="26" rx="6" fill="#12136B" />
      <rect x="8" y="158" width="128" height="12" rx="6" fill="#3638C9" />
      <g className="shock" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" fill="none">
        <path d="M14 140 L-6 124" />
        <path d="M28 128 L18 104" />
        <path d="M118 132 L140 114" />
        <path d="M128 146 L154 140" />
      </g>
      <g className="swing">
        <rect x="84" y="114" width="156" height="15" rx="7.5" fill="#12136B" />
        <rect x="38" y="86" width="66" height="72" rx="10" fill="#FFFFFF" />
        <rect x="32" y="86" width="78" height="13" rx="5" fill="#FF6AB0" />
        <rect x="32" y="145" width="78" height="13" rx="5" fill="#FF6AB0" />
        <rect x="50" y="104" width="8" height="36" rx="4" fill="#E3E4FF" />
        <g>
          <rect x="236" y="104" width="40" height="38" rx="6" fill="#12136B" />
          <rect x="228" y="106" width="16" height="34" rx="5" fill="#FFFFFF" />
          <rect x="194" y="100" width="44" height="44" rx="16" fill="#FFFFFF" />
          <rect x="186" y="104" width="22" height="10" rx="5" fill="#FFFFFF" />
          <rect x="186" y="114" width="20" height="10" rx="5" fill="#FFFFFF" />
          <rect x="186" y="124" width="20" height="10" rx="5" fill="#FFFFFF" />
          <rect x="188" y="134" width="18" height="9" rx="4.5" fill="#FFFFFF" />
          <path d="M197 114 h10 M196 124 h10 M197 134 h9" stroke="#C9CBF5" strokeWidth="2" strokeLinecap="round" />
          <rect x="196" y="96" width="32" height="12" rx="6" fill="#FFFFFF" transform="rotate(-14 212 102)" />
        </g>
      </g>
    </svg>
  );
}

/** A crowd behind the bidders: three rows of heads, a few holding paddles of their own. Same every time. */
function CrowdImpl() {
  const shapes: ReactNode[] = [];
  const row = (y: number, r: number, fill: string, count: number, seed: number, paddles: number[]) => {
    const step = 1000 / count;
    for (let i = 0; i < count; i += 1) {
      // Whole numbers only: a drawing should never print a long decimal that could look like a price.
      const x = Math.round(step * (i + 0.5) + (((i * 37 + seed) % 23) - 11));
      const rr = Math.round(r * (0.9 + ((i * 13 + seed) % 7) / 30));
      const hy = y + ((i * 29 + seed) % 9) - 4;
      if (paddles.includes(i)) {
        shapes.push(<rect key={`p${seed}-${i}`} x={Math.round(x + rr * 0.9)} y={Math.round(hy - rr * 3.1)} width={Math.round(rr * 0.22)} height={Math.round(rr * 2.3)} fill={fill} />);
        shapes.push(<ellipse key={`e${seed}-${i}`} cx={Math.round(x + rr * 1.01)} cy={Math.round(hy - rr * 3.3)} rx={Math.round(rr * 0.78)} ry={Math.round(rr * 0.86)} fill="#4D50EC" />);
      }
      shapes.push(<rect key={`b${seed}-${i}`} x={Math.round(x - rr * 1.9)} y={Math.round(hy + rr * 0.9)} width={Math.round(rr * 3.8)} height={Math.round(rr * 4)} rx={Math.round(rr * 1.2)} fill={fill} />);
      shapes.push(<circle key={`h${seed}-${i}`} cx={Math.round(x)} cy={Math.round(hy)} r={Math.round(rr)} fill={fill} />);
    }
  };
  row(118, 17, "#2526CC", 17, 3, [4, 13]);
  row(168, 24, "#1E1FB6", 12, 11, [2, 9]);
  row(222, 30, "#1B1CA6", 9, 5, []);
  return (
    <svg className="crowd" viewBox="0 0 1000 260" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      {shapes}
    </svg>
  );
}

export const Limb = memo(LimbImpl);
export const Gavel = memo(GavelImpl);
export const Crowd = memo(CrowdImpl);

type FlapRefs = { st: HTMLSpanElement | null; sb: HTMLSpanElement | null; lt: HTMLSpanElement | null; lts: HTMLSpanElement | null; lb: HTMLSpanElement | null; lbs: HTMLSpanElement | null };

function Flap({ value, still }: { value: string; still: boolean }) {
  const refs = useRef<FlapRefs>({ st: null, sb: null, lt: null, lts: null, lb: null, lbs: null });
  const last = useRef<{ v: string; at: number }>({ v: value, at: 0 });
  useLayoutEffect(() => {
    const r = refs.current;
    if (!r.st || !r.sb || !r.lt || !r.lb || !r.lts || !r.lbs) return;
    const old = last.current.v;
    if (old === value) return;
    const now = performance.now();
    const plain = still || typeof r.lt.animate !== "function" || now - last.current.at < 230;
    last.current = { v: value, at: now };
    if (plain) {
      r.st.textContent = value;
      r.sb.textContent = value;
      r.lts.textContent = value;
      r.lbs.textContent = value;
      return;
    }
    r.st.textContent = value; // the new top waits behind
    r.sb.textContent = old; // the old bottom stays until the leaf lands
    r.lts.textContent = old; // the old top falls
    r.lbs.textContent = value; // the new bottom lands
    r.lt.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], { duration: 120, easing: "cubic-bezier(0.55,0,1,0.45)", fill: "forwards" });
    const landing = r.lb.animate([{ transform: "rotateX(90deg)" }, { transform: "rotateX(0deg)" }], { duration: 150, delay: 120, easing: "cubic-bezier(0.23,1,0.32,1)", fill: "forwards" });
    landing.onfinish = () => {
      if (last.current.v === value && r.sb) r.sb.textContent = value;
    };
  }, [value, still]);
  return (
    <span className="flap">
      <span className="h t">
        <span ref={(el) => void (refs.current.st = el)}>{value}</span>
      </span>
      <span className="h b">
        <span ref={(el) => void (refs.current.sb = el)}>{value}</span>
      </span>
      <span className="h t lt" ref={(el) => void (refs.current.lt = el)}>
        <span ref={(el) => void (refs.current.lts = el)}>{value}</span>
      </span>
      <span className="h b lb" ref={(el) => void (refs.current.lb = el)}>
        <span ref={(el) => void (refs.current.lbs = el)}>{value}</span>
      </span>
    </span>
  );
}

/** The split-flap clock. Minutes and seconds left. */
export function FlapClock({ seconds, still = false, label = "on the clock" }: { seconds: number; still?: boolean; label?: string }) {
  const s = Math.max(0, Math.ceil(seconds - 0.001));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return (
    <div className="clockwrap" aria-hidden="true">
      <div className="flaps">
        <Flap value={String(Math.min(9, m))} still={still} />
        <span className="colon">:</span>
        <Flap value={String(Math.floor(ss / 10))} still={still} />
        <Flap value={String(ss % 10)} still={still} />
      </div>
      <span className="clocklabel">{label}</span>
    </div>
  );
}

/** One store with its numbered paddle. A raise dips, thrusts up, then settles. */
export function Paddle({ paddle, still }: { paddle: PaddleView; still?: boolean }) {
  const jab = useRef<HTMLDivElement | null>(null);
  const was = useRef<PaddleState>(paddle.state);
  const shown = useRef(paddle.amount);
  useEffect(() => {
    const before = was.current;
    const changed = shown.current !== paddle.amount;
    was.current = paddle.state;
    shown.current = paddle.amount;
    const raise = (paddle.state === "up" && before !== "up") || (paddle.state === "lead" && (before !== "lead" || changed));
    if (!raise || still || !jab.current?.animate) return;
    jab.current.animate(
      [
        { transform: "translateY(0)" },
        { transform: "translateY(9px) scaleY(.98)", offset: 0.16 },
        { transform: "translateY(-30px)", offset: 0.55 },
        { transform: "translateY(0)" },
      ],
      { duration: 540, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
  }, [paddle.state, paddle.amount, still]);
  const amountClass = /^[A-Za-z]{5,}$/.test(paddle.amount) ? "amt word" : paddle.amount.length > 5 ? "amt longer" : paddle.amount.length > 3 ? "amt long" : "amt";
  return (
    <div className="bidder" data-s={paddle.state}>
      <div className="arm">
        <div className="jab" ref={jab}>
          <div className="head">
            <span className="no">No. {paddle.no}</span>
            <span className={amountClass}>{paddle.amount}</span>
            <span className={paddle.name.length > 14 ? "who long" : "who"}>{paddle.name}</span>
          </div>
          <Limb costume={paddle.costume} uid={paddle.id} />
          <span className="tag">{paddle.tag}</span>
        </div>
      </div>
    </div>
  );
}

/** The clerk's sheet: every message as it happened. Readable for people, raw for tinkerers. */
export function ClerkSheet({ rows, still, note, flat = false, empty }: { rows: LogRow[]; still?: boolean; note?: string; flat?: boolean; empty?: string }) {
  const [raw, setRaw] = useState(false);
  const list = useRef<HTMLOListElement | null>(null);
  const seen = useRef<Set<string>>(new Set(rows.map((row) => row.key)));
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const added = rows.filter((row) => !seen.current.has(row.key)).map((row) => row.key);
    for (const key of added) seen.current.add(key);
    if (added.length && !still) setFresh(new Set(added));
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [rows, still]);
  return (
    <aside className={`clerk${flat ? " clerk--flat" : ""}`} aria-label="The clerk's sheet">
      <header>
        <h2>
          The clerk&apos;s sheet<small>Every message, as it happened</small>
        </h2>
        <div className="seg" role="group" aria-label="Log format">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
            Readable
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </header>
      {note ? <p className="stillnote" style={{ display: "block" }}>{note}</p> : null}
      {rows.length === 0 && empty ? <p className="log-empty">{empty}</p> : null}
      <ol className={`log${raw ? " raw" : ""}`} ref={list} aria-live="off">
        {rows.map((row) => {
          const cls = [
            row.sold ? "k-sold" : "",
            row.whoKind === "agent" ? "k-agent" : "",
            row.lead ? "lead" : "",
            row.quiet ? "k-quiet" : "",
            fresh.has(row.key) ? "new" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return raw ? (
            <li key={row.key} className={cls}>
              {JSON.stringify(row.raw)}
            </li>
          ) : (
            <li key={row.key} className={cls}>
              <time>{row.time}</time>
              <span className="who">
                {row.who}
                {row.to ? <i> to {row.to}</i> : null}
              </span>
              <span className="amt">{row.amount ?? ""}</span>
              <span className="q">{row.text}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/** The whole room. `controls` sit in the lot line (pause, and so on); `desk` sits under the board. */
export function Room({ view, controls, desk, id, className = "", children, logEmpty, logNote }: {
  view: RoomView;
  controls?: ReactNode;
  desk?: ReactNode;
  id?: string;
  className?: string;
  children?: ReactNode;
  logEmpty?: string;
  logNote?: string;
}) {
  const sayRef = useRef<HTMLParagraphElement | null>(null);
  const lastSay = useRef(view.say);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (lastSay.current === view.say || view.still) {
      lastSay.current = view.say;
      return;
    }
    lastSay.current = view.say;
    const el = sayRef.current;
    if (!el) return;
    el.classList.add("swap");
    void el.offsetWidth;
    const t = window.setTimeout(() => el.classList.remove("swap"), 40);
    return () => window.clearTimeout(t);
  }, [view.say, view.still]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!view.hit || view.still) {
      el.classList.remove("hit");
      return;
    }
    // Restart the strike: the stamp slams, the board jolts, the floor punches.
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
  }, [view.hit, view.still]);
  const classes = ["room", className, view.tense ? "tense" : "", view.done ? "done" : ""].filter(Boolean).join(" ");
  const style = { "--n": view.paddles.length } as CSSProperties;
  return (
    <div className={classes} id={id} data-gavel={view.gavel} ref={rootRef}>
      <p className="sr">{view.srSummary}</p>
      <div className="board">
        <div className="boardtext">
          <div className="lot">
            <span className="lotno">{view.lotNo}</span>
            <span>{view.lotText}</span>
            {view.tag}
            {controls}
          </div>
          <p className="say" ref={sayRef} aria-hidden="true">
            {view.say}
          </p>
          <p className="leading" aria-hidden="true">
            {view.leading}
          </p>
          {desk}
        </div>
        <FlapClock seconds={view.seconds} still={view.still} label={view.clockLabel} />
        <Gavel />
      </div>
      <div className="sold" aria-hidden="true">
        Sold.
      </div>
      <div className="floor">
        <Crowd />
        <div className="bidders" aria-hidden="true" style={style}>
          {view.paddles.map((paddle) => (
            <Paddle key={paddle.id} paddle={paddle} still={view.still} />
          ))}
        </div>
        <ClerkSheet rows={view.log} still={view.still} empty={logEmpty} note={logNote} />
      </div>
      {children}
    </div>
  );
}
