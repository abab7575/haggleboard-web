import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFixture } from "../lib/catalog";
import { openSqlite, type Store } from "../lib/db";
import { requestEvents, type EventContext } from "../lib/events";
import { RING_STORES } from "../lib/ring/cast";
import { drawFloors, readLine, scoreRound, simulate, type HagglerMessage, type RoundSetup } from "../lib/ring/engine";
import { league, practiceTotals, roundState, say, startRound } from "../lib/ring/service";
import { sayPrice } from "../lib/ring/words";
import { boardRows, postRequest, type Deps } from "../lib/service";
import { sitemapEntries } from "../lib/sitemap";
import { publicStats } from "../lib/stats";
import { storesWithPages } from "../lib/store-page";
import { listStoreNotifications } from "../watcher/notify";
import { createHaggleboardServer } from "../mcp/http";
import { handleMcpRequest } from "../mcp/http";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const variants = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;

function outside(agentClass = "claude-user"): EventContext {
  return {
    agent: { agent_class: agentClass, kind: "assistant", signature_agent: null, signature_verified: false },
    internal: false,
    caller_hash: "d".repeat(64),
    channel: "mcp",
  };
}

const T0 = Date.parse("2026-11-23T12:00:00.000Z");

function setup(seed = 42, window_seconds = 120): RoundSetup {
  const ticket_cents = 10_000;
  return { round_id: "r", opened_at: T0, window_seconds, ticket_cents, floors: drawFloors(seed, ticket_cents), seed };
}

describe("practice ring engine", () => {
  it("draws a secret floor per store inside its range, and different rounds draw differently", () => {
    const a = drawFloors(1, 10_000);
    const b = drawFloors(2, 10_000);
    for (const store of RING_STORES) {
      expect(a[store.id]).toBeGreaterThanOrEqual(store.floor_range[0] * 10_000 - 50);
      expect(a[store.id]).toBeLessThanOrEqual(store.floor_range[1] * 10_000 + 50);
    }
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("is deterministic and never goes under a floor, whatever the haggler says", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const s = setup(seed);
      const messages: HagglerMessage[] = [];
      for (let i = 0; i < 30; i += 1) {
        const to = (["heron", "puddle", "toes", "fox", "all"] as const)[i % 5];
        messages.push({ id: `m${i}`, at: T0 + 2_000 + i * 3_500, to, amount_cents: 1_000 + i * 100, text: null });
      }
      const one = simulate(s, messages, T0 + 200_000);
      const two = simulate(s, messages, T0 + 200_000);
      expect(JSON.stringify(one)).toBe(JSON.stringify(two));
      for (const move of one.moves) {
        if (move.ask_cents != null) expect(move.ask_cents).toBeGreaterThanOrEqual(s.floors[move.store]);
        expect(move.at).toBeLessThanOrEqual(T0 + 120_000);
      }
    }
  });

  it("each store keeps its temper", () => {
    const s = setup(7);
    const quiet = simulate(s, [], T0 + 120_000);
    // Puddlejump jumps first, drops, then folds a bit past halfway.
    const puddle = quiet.moves.filter((m) => m.store === "puddle");
    expect(puddle[0]!.kind).toBe("join");
    expect(quiet.moves[0]!.store).toBe("puddle");
    expect(puddle.some((m) => m.kind === "fold")).toBe(true);
    const fold = puddle.find((m) => m.kind === "fold")!;
    expect((fold.at - T0) / 120_000).toBeGreaterThan(0.5);
    // Ten Toes only ever goes exactly one euro under someone else's lead.
    const toesDrops = quiet.moves.filter((m) => m.store === "toes" && m.kind === "drop");
    expect(toesDrops.length).toBeGreaterThan(0);
    for (const drop of toesDrops) {
      const before = simulate(s, [], drop.at - 1);
      const leader = before.leader!;
      expect(leader).not.toBe("toes");
      expect(drop.ask_cents).toBe(before.states[leader].ask! - 100);
    }
    // Wobbly Fox says nothing until the last part of the clock.
    const fox = quiet.moves.filter((m) => m.store === "fox");
    expect(fox.length).toBeGreaterThan(0);
    expect((fox[0]!.at - T0) / 120_000).toBeGreaterThan(0.85);
    // Grumpy Heron ignores a question to the whole room, but answers when asked directly.
    const shout = simulate(s, [{ id: "all1", at: T0 + 30_000, to: "all", amount_cents: 8_000, text: null }], T0 + 40_000);
    const heronToAll = shout.moves.find((m) => m.store === "heron" && m.reply_to === "all1")!;
    expect(heronToAll.kind).toBe("pass");
    const direct = simulate(s, [{ id: "d1", at: T0 + 30_000, to: "heron", amount_cents: 8_000, text: null }], T0 + 40_000);
    const heronDirect = direct.moves.find((m) => m.store === "heron" && m.reply_to === "d1")!;
    expect(["drop", "refuse", "accept"]).toContain(heronDirect.kind);
  });

  it("pushing gets a better score than sitting still", () => {
    let better = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const s = setup(seed);
      const idle = scoreRound(s, simulate(s, [], T0 + 120_000));
      const msgs: HagglerMessage[] = [];
      let i = 0;
      for (const [at, to, share] of [
        [8, "puddle", 0.8], [20, "puddle", 0.8], [35, "heron", 0.7], [50, "heron", 0.72], [60, "heron", 0.74], [70, "heron", 0.76],
        [30, "fox", 0.7], [40, "fox", 0.7], [108, "fox", 0.74], [112, "heron", 0.78], [114, "fox", 0.76],
      ] as Array<[number, HagglerMessage["to"], number]>) {
        msgs.push({ id: `p${i++}`, at: T0 + at * 1000, to, amount_cents: Math.round(s.ticket_cents * share), text: null });
      }
      const pushed = scoreRound(s, simulate(s, msgs, T0 + 120_000));
      if (pushed.score_pct < idle.score_pct) better += 1;
    }
    expect(better).toBeGreaterThanOrEqual(16);
  });

  it("reads free lines and says prices like a stallholder", () => {
    expect(readLine("Heron, 78?", 10_000)).toEqual({ to: "heron", amount_cents: 7_800 });
    expect(readLine("Ten Toes, one under? 81.50", 10_000)).toEqual({ to: "toes", amount_cents: 8_150 });
    expect(readLine("Anyone at 75?", 10_000)).toEqual({ to: "all", amount_cents: 7_500 });
    expect(sayPrice(9_600)).toBe("Ninety-six");
    expect(sayPrice(7_750)).toBe("Seventy-seven fifty");
  });
});

describe("practice rounds, stored", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openSqlite(":memory:");
  });
  afterEach(async () => {
    await store.close();
    vi.restoreAllMocks();
  });

  it("plays a full round: keyed messages, lazy store moves, a close with the floors revealed only then", async () => {
    const started = await startRound({ agent: "bargain-goblin", runs_on: "Test rig", opening: "Ticket price everywhere. Who'll go lower?" }, { store, context: outside() }, T0);
    expect(started.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.stores.every((s) => !("floor_cents" in s))).toBe(true);
    expect(JSON.stringify(started)).not.toMatch(/floor/);
    await expect(say(started.round_id, { key: "x".repeat(43), to: "heron", amount: 70 }, { store }, T0 + 20_000)).rejects.toThrow(/key/);
    await say(started.round_id, { key: started.key, to: "heron", amount: 75 }, { store, context: outside() }, T0 + 40_000);
    await say(started.round_id, { key: started.key, text: "Puddlejump, 80 and it's yours" }, { store, context: outside() }, T0 + 41_000);
    const mid = await roundState(started.round_id, { store }, T0 + 60_000);
    expect(mid.status).toBe("open");
    expect(mid.log.some((row) => row.from === "puddle")).toBe(true);
    expect(JSON.stringify(mid)).not.toMatch(/floor/);
    await expect(say(started.round_id, { key: started.key, amount: 1 }, { store }, T0 + 121_000)).rejects.toThrow(/hammer/);
    const done = await roundState(started.round_id, { store }, T0 + 125_000);
    expect(done.status).toBe("closed");
    expect(done.result!.score_pct).toBeGreaterThanOrEqual(0);
    expect(done.stores.every((s) => typeof s.floor_cents === "number")).toBe(true);
    expect(done.log.at(-1)!.kind).toBe("sold");
    expect(done.result!.brag).toMatch(/^My agent got .+ down \d+% in \d:\d\d\. Beat that\.$/);
    // Every row of the round is in the one log, marked practice; reading twice writes nothing new.
    const events = await requestEvents(store, started.round_id);
    expect(events.every((event) => event.public.practice === true)).toBe(true);
    await roundState(started.round_id, { store }, T0 + 130_000);
    expect((await requestEvents(store, started.round_id)).length).toBe(events.length);
    // Real outside round with a handle: it's in the league, and lab runs stay out by default.
    const table = await league(store);
    expect(table.rows.map((row) => row.handle)).toEqual(["bargain-goblin"]);
    expect(table.rows[0]!.lab).toBe(false);
  });

  it("our own lab runs are flagged and left out of the league unless asked for", async () => {
    const lab = await startRound({ agent: "lab-runner" }, { store }, T0);
    await roundState(lab.round_id, { store }, T0 + 125_000);
    expect((await league(store)).rows).toEqual([]);
    const withLab = await league(store, { includeLab: true });
    expect(withLab.rows[0]).toMatchObject({ handle: "lab-runner", lab: true });
  });

  it("never makes an outside request", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("the practice ring must not fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const started = await startRound({ agent: "no-network" }, { store, context: outside() }, T0);
    await say(started.round_id, { key: started.key, to: "all", amount: 80 }, { store, context: outside() }, T0 + 10_000);
    await roundState(started.round_id, { store }, T0 + 125_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stays out of every real-shopping number, the board, the sitemap, store pages and notifications", async () => {
    const deps: Deps = { store, loadVariants: async () => variants, context: outside(), origin: "outside" };
    const before = await publicStats(store, T0 + 200_000);
    const started = await startRound({ agent: "outside-agent", allowed: { kind: "under_limit", limit: 50, currency: "EUR" } }, { store, context: outside() }, T0);
    await say(started.round_id, { key: started.key, to: "fox", amount: 70 }, { store, context: outside() }, T0 + 5_000);
    await roundState(started.round_id, { store }, T0 + 125_000);
    const after = await publicStats(store, T0 + 200_000);
    for (const key of ["requests", "stores_answering", "auctions_closed", "auctions_last_seen_only", "agent_classes"] as const) {
      expect(after[key].value).toBe(before[key].value);
    }
    expect(after.allowed.told.value).toBe(0);
    expect(after.practice.rounds.value).toBe(1);
    expect(await practiceTotals(store)).toMatchObject({ rounds: 1, closed: 1, handles: 1 });
    expect(await boardRows(deps)).toEqual([]);
    const sitemap = await sitemapEntries(store, variants, "https://haggleboard.com", T0 + 200_000, new Set());
    expect(JSON.stringify(sitemap)).not.toContain(started.round_id);
    expect(JSON.stringify(sitemap)).not.toMatch(/ring\//);
    const pages = await storesWithPages(store, variants, T0 + 200_000, new Set());
    expect(pages.join(" ")).not.toMatch(/heron|puddle|toes|fox/i);
    expect(await listStoreNotifications(store)).toEqual([]);
    const ringRows = await store.select("SELECT store_domain FROM events WHERE type LIKE 'ring.%'");
    expect(ringRows.every((row) => row.store_domain == null)).toBe(true);
  });

  it("counts what users allowed as totals only, from real posts", async () => {
    const deps: Deps = { store, loadVariants: async () => variants, context: outside(), origin: "outside" };
    await postRequest({ text: "Brooks Ghost 16 women's size 8", allowed: "ask_first" }, deps);
    await postRequest({ text: "Hoka Clifton 9 mens 10", allowed: { kind: "under_limit", limit: 150, currency: "usd" } }, deps);
    const stats = await publicStats(store);
    expect(stats.allowed.told.value).toBe(2);
    expect(stats.allowed.ask_first.value).toBe(1);
    expect(stats.allowed.under_limit.value).toBe(1);
    // One limit is not enough to publish a median: it would be that one person's limit.
    expect(stats.allowed.median_limit).toEqual([]);
    expect(JSON.stringify(stats)).not.toContain("150");
  });
});

describe("practice ring over MCP", () => {
  it("lists the ring tools with honest read and write hints", async () => {
    const store = await openSqlite(":memory:");
    const server = createHaggleboardServer({ store, loadVariants: async () => variants });
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }> })._registeredTools;
    expect(tools.ring_start!.annotations?.readOnlyHint).toBe(false);
    expect(tools.ring_say!.annotations?.readOnlyHint).toBe(false);
    expect(tools.ring_state!.annotations?.readOnlyHint).toBe(true);
    expect(tools.ring_league!.annotations?.readOnlyHint).toBe(true);
    expect(tools.search_products!.annotations?.readOnlyHint).toBe(true);
    expect(tools.post_request!.annotations?.readOnlyHint).toBe(false);
    await store.close();
  });

  it("starts a round and talks in it through the MCP endpoint", async () => {
    const store = await openSqlite(":memory:");
    const deps: Deps = { store, loadVariants: async () => variants };
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await handleMcpRequest(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        deps,
      );
      const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(body.result.isError).not.toBe(true);
      return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
    };
    const started = await call("ring_start", { agent: "mcp-goblin", runs_on: "a test" });
    expect(started.practice).toBe(true);
    const said = await call("ring_say", { round_id: started.round_id, key: started.key, to: "all", amount: 80, wait_seconds: 0 });
    expect((said.log as Array<{ from: string }>).some((row) => row.from === "agent")).toBe(true);
    const state = await call("ring_state", { round_id: started.round_id });
    expect(state.status).toBe("open");
    await store.close();
  });
});
