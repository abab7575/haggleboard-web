import { brandPage, esc } from "../brand-html.js";
import { eventContext } from "../events.js";
import { FIND_HEADERS, nonCreatingReason } from "../find.js";
import { HttpError } from "../http.js";
import { assertWithinRateLimit, RING_BUCKET } from "../rate-limit.js";
import type { Store } from "../db.js";
import { ringStore } from "./cast.js";
import { say, startRound, waitForRound, type RingState } from "./service.js";
import { clock, euro } from "./words.js";

/**
 * THE RING FROM ONE ADDRESS, for agents that can only open web pages.
 *
 *   /ring?q=<opening line>[&agent=<handle>&runs_on=<what you run on>]   starts a round
 *   /ring?round=<id>&key=<key>&q=<what you say>                         says something
 *   /ring?round=<id>                                                    reads it
 *
 * The middleware sends these to this handler; /ring without q or round is the page people play on.
 * Practice only: the key lives in these links, and all it does is let someone talk in this one
 * play-money round. Prefetchers, crawlers and link previews never start or change a round.
 */
export async function ringOneAddress(req: Request, store: Store): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim().slice(0, 200) ?? "";
  const round = url.searchParams.get("round")?.trim() ?? "";
  const key = url.searchParams.get("key")?.trim() ?? "";
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json") && !(req.headers.get("accept") ?? "").includes("text/html");
  const headers = { ...FIND_HEADERS, "content-type": wantsJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8" };
  const reply = (status: number, title: string, html: string, data: unknown) =>
    new Response(wantsJson ? JSON.stringify(data) : brandPage(title, html), { status, headers });
  try {
    const ring = { store, context: eventContext(req, "find") };
    const blocked = nonCreatingReason(req);
    if (round && /^[0-9a-f-]{36}$/.test(round)) {
      if (q && key && !blocked) {
        await assertWithinRateLimit(req, store, Date.now(), RING_BUCKET);
        await say(round, { key, text: q }, ring);
        const state = await waitForRound(round, ring, 4);
        return reply(200, "Practice ring", page(state, key, site(req)), state);
      }
      const state = await waitForRound(round, ring, 0);
      return reply(200, "Practice ring", page(state, key || null, site(req)), state);
    }
    if (!q || blocked) {
      return reply(
        200,
        "Practice ring",
        `<h1>Send your agent to haggle.</h1><p>${blocked ? `Nothing was started: this looked like ${esc(blocked)}.` : "Nothing was started yet."} To start a practice round, open <code>${esc(site(req))}/ring?q=your+opening+line&amp;agent=your-handle</code>.</p><p class="pale">Four made-up stores, play money, two minutes, a secret lowest price each. Nobody pays, nothing ships.</p>`,
        { started: false, reason: blocked ?? "no q", how: `${site(req)}/ring?q=your+opening+line&agent=your-handle` },
      );
    }
    await assertWithinRateLimit(req, store, Date.now(), RING_BUCKET);
    const agent = url.searchParams.get("agent")?.trim() || undefined;
    const runsOn = url.searchParams.get("runs_on")?.trim() || undefined;
    const started = await startRound({ agent, runs_on: runsOn, opening: q, mode: "agent" }, ring);
    const state = await waitForRound(started.round_id, ring, 4);
    return reply(201, "Practice ring", page(state, started.key, site(req)), { ...state, key: started.key });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Something went wrong";
    if (status === 500) console.error("ring one-address failed");
    return new Response(wantsJson ? JSON.stringify({ error: message }) : brandPage("Practice ring", `<h1>Hold on.</h1><p>${esc(message)}</p>`), {
      status,
      headers: { ...headers, ...(error instanceof HttpError ? error.headers : {}) },
    });
  }
}

function site(req: Request): string {
  const configured = process.env.SITE_URL?.trim();
  return (configured || new URL(req.url).origin).replace(/\/$/, "");
}

function page(state: RingState, key: string | null, base: string): string {
  const link = (text: string) => `${base}/ring?round=${state.round_id}&key=${encodeURIComponent(key ?? "")}&q=${encodeURIComponent(text)}`;
  const paddles = state.stores
    .map((s) => {
      const cls = s.folded ? "out" : s.leading ? "on" : "";
      const amount = s.folded ? "Out" : s.ask_cents == null ? "?" : euro(s.ask_cents);
      return `<li class="${cls}"><small>No. ${s.no}</small><b>${esc(amount)}</b><small>${esc(s.name)}</small></li>`;
    })
    .join("");
  const rows = state.log
    .map((row) => {
      const who = row.from === "agent" ? `<b>${esc(state.handle ?? "you")}</b> to ${esc(row.to === "all" ? "everyone" : ringStore(row.to as never).name)}` : row.from === "clerk" ? "<b>the clerk</b>" : `<b>${esc(ringStore(row.from).name)}</b>`;
      const amount = row.amount_cents == null ? "" : row.from === "agent" ? `asks ${euro(row.amount_cents)}` : euro(row.amount_cents);
      return `<li><time>${clock(row.t)}</time><span class="w">${who}</span><span class="w">${esc(amount)}</span><span class="q">${esc(row.text)}</span></li>`;
    })
    .join("");
  const leader = state.leader ? state.stores.find((s) => s.id === state.leader) : null;
  const head =
    state.status === "closed" && state.result
      ? `<h1>${state.result.winner ? `Sold. ${esc(state.result.brag.replace(" Beat that.", ""))}` : "No sale."}</h1><p>Score: <b>${state.result.score_pct}% above the floors</b>, on average. Lower is better. The secret lowest prices: ${state.stores.map((s) => `${esc(s.name)} ${euro(s.floor_cents ?? 0)}`).join(", ")}.</p><p><a href="${base}${state.result.card}">The brag card</a>, <a href="${base}/ring/${state.round_id}">the round's page</a>.</p>`
      : `<h1>Lot ${state.lot}. ${esc(state.item)}.</h1><p>Ticket price ${euro(state.ticket_cents)}. <b>${clock(state.seconds_left)}</b> on the clock. ${leader ? `Leading: ${esc(leader.name)} at ${euro(leader.ask_cents!)}.` : "Nobody has moved yet."}</p>`;
  const next =
    state.status !== "closed" && key
      ? `<h2>Say the next thing</h2><div class="next"><p>Open one of these, or write your own after <code>q=</code>. Name a store and a price.</p><ul><li><a href="${esc(link("Heron, 80?"))}">Heron, 80?</a></li><li><a href="${esc(link("Puddlejump, 82 and it's yours"))}">Puddlejump, 82 and it's yours</a></li><li><a href="${esc(link("Ten Toes, one under? Go on"))}">Ten Toes, one under?</a></li><li><a href="${esc(link("Fox, I see you. 79"))}">Fox, I see you. 79</a></li></ul><p>Then read it again: <a href="${base}/ring?round=${state.round_id}">${base}/ring?round=${state.round_id}</a></p></div>`
      : state.status !== "closed"
        ? `<p class="pale">Watching. Only the player with the key can talk in this round.</p>`
        : `<p><a href="${base}/ring?q=${encodeURIComponent("Ticket price everywhere. Who'll go lower?")}">Start another round</a></p>`;
  return `<p><span class="tag">Practice ring. Made-up stores, play money.</span></p>${head}<ul class="paddles">${paddles}</ul>${next}<h2>The clerk's sheet</h2><ol class="sheet">${rows}</ol><p class="pale">The same round as JSON: <code>${base}/api/ring/${state.round_id}</code></p>`;
}
