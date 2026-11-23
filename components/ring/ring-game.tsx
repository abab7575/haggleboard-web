"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RING_STORES, type StoreId } from "../../lib/ring/cast";
import { euro } from "../../lib/ring/words";
import { Room } from "../brand/room";
import { BragCard } from "../brand/brag-card";
import { CopyButton } from "../brand/copy-button";
import { bragTrail, ringFrame, type RingMeta, type RingRow } from "./frame";

/**
 * THE PRACTICE RING, PLAYED BY HAND. A real round on the real engine: this page starts it with
 * POST /api/ring, keeps the round's key in this browser only (localStorage), talks with
 * POST /api/ring/{id}/say, and reads GET /api/ring/{id} about once a second. The stores are bots on
 * the server; nothing here decides what they do.
 */

type StoreView = { id: StoreId; name: string; no: number; ask_cents: number | null; floor_cents?: number; folded: boolean; leading: boolean };
type Result = {
  winner: StoreId | null;
  winner_cents: number | null;
  score_pct: number;
  time_seconds: number | null;
  stores: Array<{ store: StoreId; name: string; floor_cents: number; final_cents: number; above_floor_pct: number; down_pct: number; at_seconds: number | null; folded: boolean }>;
  best_crack: { store: StoreId; name: string; final_cents: number; down_pct: number; at_seconds: number | null };
  brag: string;
  card: string;
  page: string;
  brag_line: string;
};
type State = {
  round_id: string;
  lot: number;
  item: string;
  ticket_cents: number;
  handle: string | null;
  runs_on: string | null;
  opened_at: string;
  deadline: string;
  window_seconds: number;
  now: string;
  status: "open" | "closing" | "closed";
  stores: StoreView[];
  log: RingRow[];
  result: Result | null;
  lab: boolean;
};

const keyName = (id: string) => `hb:ring:${id}`;
const TARGETS: Array<{ id: StoreId | "all"; label: string }> = [{ id: "all", label: "Everyone" }, ...RING_STORES.map((s) => ({ id: s.id, label: s.name }))];

function readHashRound(): string | null {
  const match = window.location.hash.match(/round=([0-9a-f-]{36})/);
  return match ? match[1]! : null;
}

export function RingGame({ site, roundId }: { site: string; roundId?: string }) {
  const [state, setState] = useState<State | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState<StoreId | "all">("all");
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [handle, setHandle] = useState("");
  const [runsOn, setRunsOn] = useState("");
  const [still, setStill] = useState(false);
  const [hitUntil, setHitUntil] = useState(0);
  const wasClosed = useRef(false);

  const absorb = useCallback((next: State) => {
    setSkew(Date.parse(next.now) - Date.now());
    setState(next);
  }, []);

  const load = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/ring/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "That round isn't here.");
      absorb((await res.json()) as State);
    },
    [absorb],
  );

  const start = useCallback(
    async (opening?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/ring", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "hand",
            ...(handle.trim() ? { agent: handle.trim() } : {}),
            ...(runsOn.trim() ? { runs_on: runsOn.trim() } : {}),
            ...(opening ? { opening } : {}),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as State & { key?: string; error?: string };
        if (!res.ok || !body.key) throw new Error(res.status === 429 ? "That's a lot of rounds in a minute. Breathe, then go again." : (body.error ?? "The ring didn't open. Try again."));
        try {
          window.localStorage.setItem(keyName(body.round_id), body.key);
        } catch {
          // Storage blocked: the key still works for this visit.
        }
        setKey(body.key);
        absorb(body);
        wasClosed.current = false;
        window.history.replaceState(null, "", roundId ? `/ring#round=${body.round_id}` : `${window.location.pathname}#round=${body.round_id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The ring didn't open. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [absorb, handle, runsOn],
  );

  // On load: a round in the address (#round=...), or an opening line from the home page (?say=...).
  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const params = new URLSearchParams(window.location.search);
    const said = params.get("say")?.trim();
    const id = roundId ?? readHashRound();
    if (id) {
      try {
        setKey(window.localStorage.getItem(keyName(id)));
      } catch {
        setKey(null);
      }
      load(id).catch((err) => setError(err instanceof Error ? err.message : "That round isn't here."));
    } else if (said) {
      window.history.replaceState(null, "", "/ring");
      void start(said.slice(0, 200));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The clock ticks here; the round is read from the server about once a second while it's open.
  useEffect(() => {
    if (!state || state.status === "closed") return;
    const tick = window.setInterval(() => setNow(Date.now()), 200);
    const poll = window.setInterval(() => {
      load(state.round_id).catch(() => undefined);
    }, 900);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [state?.round_id, state?.status, load, state]);

  useEffect(() => {
    if (state?.status === "closed" && !wasClosed.current) {
      wasClosed.current = true;
      setHitUntil(Date.now() + 1200);
      const t = window.setTimeout(() => setHitUntil(0), 1250);
      return () => window.clearTimeout(t);
    }
  }, [state?.status]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!state || !key) return;
    const value = amount.trim() ? Number(amount.replace(",", ".")) : undefined;
    if (value != null && !(value > 0)) {
      setError("A price is a number, like 78 or 77.50.");
      return;
    }
    if (value == null && !text.trim()) {
      setError("Say something, or name a price.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ring/${state.round_id}/say`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, to, ...(value != null ? { amount: value } : {}), ...(text.trim() ? { text: text.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as State & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "That didn't land. Try again.");
      absorb(body);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't land. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const meta: RingMeta | null = useMemo(
    () =>
      state
        ? {
            lot: state.lot,
            item: state.item,
            ticket_cents: state.ticket_cents,
            window_seconds: state.window_seconds,
            handle: state.handle,
            label: "Practice ring. Made-up stores, play money.",
            closed_at: state.status === "closed" ? state.window_seconds : null,
          }
        : null,
    [state],
  );

  const t = state ? Math.min(state.window_seconds + 5, (now + skew - Date.parse(state.opened_at)) / 1000) : 0;
  const waiting = !state;
  const frame = meta && state
    ? ringFrame(meta, state.log, state.status === "closed" ? Math.max(t, state.window_seconds) : Math.min(t, state.window_seconds - 0.01), { still })
    : ringFrame(
        { lot: 0, item: "The stores are waiting", ticket_cents: 10_000, window_seconds: 120, handle: handle.trim() || null, label: "Practice ring. Made-up stores, play money.", closed_at: null },
        [],
        0,
        { still },
      );
  const view = {
    ...frame,
    lotNo: waiting ? "Next lot" : frame.lotNo,
    lotText: waiting ? "Four stores, two minutes, a secret lowest price each." : frame.lotText,
    say: waiting ? "Your turn. Open the bidding." : frame.say,
    hit: Date.now() < hitUntil && frame.done,
    gavel: frame.done ? (Date.now() < hitUntil ? ("down" as const) : ("rest" as const)) : frame.gavel,
    seconds: waiting ? 120 : frame.seconds,
  };
  const canTalk = Boolean(state && key && state.status === "open" && t < state.window_seconds);

  const desk = waiting ? (
    <form
      className="desk"
      onSubmit={(event) => {
        event.preventDefault();
        void start(text.trim() || undefined);
      }}
    >
      <div className="desk-row">
        <span className="field" style={{ maxWidth: 260 }}>
          <label className="sr" htmlFor="ring-handle">Your handle for the league (optional)</label>
          <input id="ring-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Handle for the league (optional)" autoComplete="off" maxLength={32} />
        </span>
        <span className="field" style={{ maxWidth: 260 }}>
          <label className="sr" htmlFor="ring-runs">What you run on (optional)</label>
          <input id="ring-runs" value={runsOn} onChange={(e) => setRunsOn(e.target.value)} placeholder="Runs on (optional)" autoComplete="off" maxLength={40} />
        </span>
      </div>
      <div className="desk-row">
        <span className="field">
          <label className="sr" htmlFor="ring-open">Your opening line</label>
          <input id="ring-open" value={text} onChange={(e) => setText(e.target.value)} placeholder="Your opening line, like: Ticket's 100 everywhere. Who'll go lower?" autoComplete="off" maxLength={200} />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Opening..." : "Start the clock"}
          </button>
        </span>
      </div>
      <p className="desk-note" role="status">{error ?? "Handles go on the league. No names, no emails."}</p>
    </form>
  ) : canTalk ? (
    <form className="desk" onSubmit={send}>
      <div className="desk-row" role="group" aria-label="Who you're talking to">
        {TARGETS.map((target) => (
          <button key={target.id} type="button" className="chip" aria-pressed={to === target.id} onClick={() => setTo(target.id)}>
            {target.label}
          </button>
        ))}
      </div>
      <div className="desk-row">
        <span className="field">
          <label className="sr" htmlFor="ring-amount">Your price, in play euro</label>
          <span className="amount" style={{ display: "flex" }}>
            <input id="ring-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="€ price" autoComplete="off" maxLength={8} />
          </span>
          <label className="sr" htmlFor="ring-line">What you say</label>
          <input id="ring-line" value={text} onChange={(e) => setText(e.target.value)} placeholder={to === "all" ? "Anyone lower?" : `Go on, ${TARGETS.find((x) => x.id === to)!.label}...`} autoComplete="off" maxLength={200} />
          <button className="btn" type="submit" disabled={busy}>
            Say it
          </button>
        </span>
      </div>
      <p className="desk-note" role="status">{error ?? "They answer in a second or two. Nobody goes under their secret lowest price."}</p>
    </form>
  ) : state && state.status !== "closed" && !key ? (
    <div className="desk">
      <p className="desk-note">You're watching. Only whoever started this round can talk in it.</p>
    </div>
  ) : null;

  return (
    <>
      <Room id="ring-room" className="room--page" view={view} desk={desk} logEmpty={waiting ? "Nothing yet. Start the clock and every word lands here." : undefined} />
      {state?.status === "closed" && state.result ? <RingResult state={state} site={site} onAgain={() => void start()} busy={busy} /> : null}
    </>
  );
}

function RingResult({ state, site, onAgain, busy }: { state: State; site: string; onAgain: () => void; busy: boolean }) {
  const result = state.result!;
  const page = `${site}${result.page}`;
  return (
    <section className="result" aria-labelledby="result-h">
      <div>
        <h2 className="h2" id="result-h">
          {result.winner ? "Bang. Now post it." : "No sale. It happens."}
        </h2>
        <p className="body">
          Your score: <b>{result.score_pct}% above the secret lowest prices</b>, on average across the four. Lower is better.
          {result.time_seconds != null ? ` The winning price landed at ${Math.floor(result.time_seconds / 60)}:${String(Math.round(result.time_seconds % 60)).padStart(2, "0")}.` : ""}
          {state.lab ? " This one ran from our own machine, so it counts as a lab run." : ""}
        </p>
        <table className="scores" style={{ marginTop: 18 }}>
          <caption className="sr">Each store: where it ended, its secret lowest price, and how far above it you finished</caption>
          <thead>
            <tr>
              <th scope="col">Store</th>
              <th scope="col" className="right">Ended at</th>
              <th scope="col" className="right">Secret lowest</th>
              <th scope="col" className="right">Above it</th>
            </tr>
          </thead>
          <tbody>
            {result.stores.map((s) => (
              <tr key={s.store}>
                <td>{s.name}{s.folded ? " (folded)" : ""}</td>
                <td className="right">{euro(s.final_cents)}</td>
                <td className="right">{euro(s.floor_cents)}</td>
                <td className="right"><b>{s.above_floor_pct}%</b></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="brag-acts">
          <CopyButton className="btn" text={`${result.brag} ${page}`} label="Copy the brag" done="Copied. Go on." />
          <a className="btn btn--line" href={`${result.card}?download=1`} download>
            Download the card
          </a>
          <CopyButton className="btn btn--line" text={page} label="Copy the round's link" />
          <button className="btn btn--paper" type="button" onClick={onAgain} disabled={busy}>
            Another round
          </button>
        </div>
      </div>
      <BragCard
        lot={state.lot}
        claim={result.brag.replace(" Beat that.", "")}
        store={result.best_crack.name}
        finalCents={result.best_crack.final_cents}
        trail={bragTrail(state.log, result.best_crack.store, result.best_crack.final_cents, state.ticket_cents)}
        foot={[`${state.handle ?? "played by hand"}${state.runs_on ? `, runs on ${state.runs_on}` : ""}`, `${result.score_pct}% above the floors. ${site.replace(/^https?:\/\//, "")}/ring`]}
      />
    </section>
  );
}
