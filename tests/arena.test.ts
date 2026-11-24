import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BragCard } from "../components/brand/brag-card";
import { LeagueTable } from "../components/brand/league-table";
import { Room } from "../components/brand/room";
import { ExperimentBand, HouseRules, RealThing, StoresStrip, WhyLower } from "../components/home/sections";
import { liveView } from "../components/live/live-room";
import { ringFrame } from "../components/ring/frame";
import { MONEY_PATTERN, PRIVATE_FIELD_NAMES, toBand, toPublicArenaEvent, toPublicArenaEvents } from "../lib/arena";
import { scoreboard } from "../lib/experiment";
import { pasteLines } from "../lib/paste-lines";
import { RING_STORES } from "../lib/ring/cast";
import { SAMPLE_META, SAMPLE_ROWS } from "../lib/ring/sample";
import type { PublicStream } from "../lib/stream";

const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(tsx?|md|txt|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Everything a visitor or an agent reads: pages, components, the brand HTML, the skill, llms.txt. */
const PUBLIC_COPY = [
  ...walk("app").filter((f) => !f.startsWith(path.join("app", "api")) || f.endsWith("route.ts")),
  ...walk("components"),
  "lib/brand-html.ts",
  "lib/find.ts",
  "lib/experiment.ts",
  "lib/paste-lines.ts",
  "lib/ring/engine.ts",
  "lib/ring/cast.ts",
  "lib/ring/sample.ts",
  "lib/ring/one-address.ts",
  "lib/ring/service.ts",
  "mcp/http.ts",
  "skill/haggleboard/SKILL.md",
  "llms.txt",
];

describe("public arena events carry no private fields or amounts", () => {
  const raw = [
    { kind: "join", at: 3, bidder: "a", amount_cents: 11900, store_floor: 9900, shopper_id: "u_123" },
    { kind: "lead", at: 9, bidder: "a", pct_under: 7.4, price_cents: 11900, max_price: 130, held_order: "ord_9" },
    { kind: "lead", at: 30, bidder: "b", pct_under: 12.2, offer_amount: "$114.00", floor_cents: 10000 },
    { kind: "bid", at: 31, bidder: "b", amount_cents: 11000 },
    { kind: "close", at: 120, winner: "b", saved_pct: 12.2, won_at: 30, revealed_price: "$114.00", shopper_email: "x@y.z" },
  ];

  it("toPublicArenaEvent keeps only whitelisted fields and rounds to a band", () => {
    const events = toPublicArenaEvents(raw);
    expect(events).toHaveLength(4);
    const json = JSON.stringify(events);
    for (const field of PRIVATE_FIELD_NAMES) expect(json).not.toContain(field);
    expect(json).not.toMatch(MONEY_PATTERN);
    expect(events[1]).toEqual({ kind: "lead", at: 9, bidder: "a", band: 5 });
    expect(toPublicArenaEvent({ ...raw[4], store_chose_to_reveal: true })).toMatchObject({ revealed_price: "$114.00" });
  });

  it("bands are coarse", () => {
    expect([toBand(0), toBand(2), toBand(7.4), toBand(8), toBand(12.4), toBand(99)]).toEqual([0, 5, 5, 10, 10, 40]);
  });

  it("a real room built from a leaky feed shows no private field or amount", () => {
    const leaky = {
      request_id: "x",
      requestLabel: "Trail shoes",
      deadline: "2026-11-22T14:22:00.000Z",
      window_seconds: 120,
      seconds_left: 0,
      status: "closed",
      now: "2026-11-22T14:22:05.000Z",
      test_stores: false,
      events: [
        { seq: 1, type: "store.joined", at: "2026-11-22T14:20:10.000Z", store: "road.com", source: "private_offer", public_price: null, currency: null, observed_at: null, confirmed: true, stale: false, test: false, amount_cents: 11437, max_price: 777 },
        { seq: 2, type: "lead.changed", at: "2026-11-22T14:20:10.000Z", store: "road.com", source: "private_offer", band: "under_5_10", band_label: "5 to 10% under the best public price", price_cents: 11437 },
      ],
    } as unknown as PublicStream;
    const html = renderToStaticMarkup(h(Room, { view: liveView(leaky, Date.parse("2026-11-22T14:21:00.000Z")) }));
    // The raw log is built from feedToArena's public events and the whitelisted feed fields only.
    for (const field of ["held_order", "max_price", "store_floor", "shopper"]) expect(html).not.toContain(field);
    expect(html).not.toMatch(/11437|114\.37|777/);
  });
});

describe("the practice ring's sample round is labelled and made up", () => {
  it("says it is a sample, with made-up stores and a made-up agent", () => {
    expect(SAMPLE_META.label).toMatch(/sample/i);
    expect(SAMPLE_META.label).toMatch(/made-up/i);
    const html = renderToStaticMarkup(h(Room, { view: ringFrame(SAMPLE_META, SAMPLE_ROWS, 60) }));
    expect(visibleText(html)).toContain("A sample round. Made-up agent, made-up stores.");
  });

  it("only uses the four made-up stores", () => {
    expect(RING_STORES.map((s) => s.name)).toEqual(["Grumpy Heron", "Puddlejump", "Ten Toes", "Wobbly Fox"]);
    for (const row of SAMPLE_ROWS) expect(["agent", "clerk", ...RING_STORES.map((s) => s.id)]).toContain(row.from);
  });

  it("with motion off, one still frame tells the whole round", () => {
    const view = ringFrame(SAMPLE_META, SAMPLE_ROWS, 120, { still: true });
    const text = visibleText(renderToStaticMarkup(h(Room, { view })));
    for (const row of SAMPLE_ROWS) expect(text).toContain(row.text.replace(/'/g, "'"));
    expect(text).toContain("Sold to Grumpy Heron at €77.");
    expect(view.srSummary).toContain("Sold to Grumpy Heron");
  });

  it("the gavel rises at going once, higher at going twice, and strikes at the close", () => {
    expect(ringFrame(SAMPLE_META, SAMPLE_ROWS, 117.5).gavel).toBe("up1");
    expect(ringFrame(SAMPLE_META, SAMPLE_ROWS, 118.8).say).toBe("Going twice.");
    expect(ringFrame(SAMPLE_META, SAMPLE_ROWS, 118.8).gavel).toBe("up2");
    const sold = ringFrame(SAMPLE_META, SAMPLE_ROWS, 120.2);
    expect(sold).toMatchObject({ gavel: "down", done: true, hit: true });
    expect(ringFrame(SAMPLE_META, SAMPLE_ROWS, 110).tense).toBe(true);
  });
});

describe("the league and the scoreboard never invent anything", () => {
  it("an empty league says so and shows no rows", () => {
    const text = visibleText(renderToStaticMarkup(h(LeagueTable, { rows: [], lab: false, rounds: 0, labRounds: 3, labHref: "/ring?lab=1" })));
    expect(text).toContain("Nobody's on the board yet.");
    expect(text).toContain("lab runs");
    expect(text).not.toMatch(/bargain-goblin|sir-hagglesworth/);
  });

  it("the experiment scoreboard reads zeros as zeros and unbuilt links as unbuilt", () => {
    const rows = scoreboard(null);
    expect(rows.map((r) => r.value)).toEqual(["0", "0", "0", null, null, null]);
    expect(rows[3]!.status).toBe("Not measurable yet");
    expect(rows[5]!.status).toBe("Not built");
    const text = visibleText(renderToStaticMarkup(h(ExperimentBand, { links: rows, practiceRounds: 0 })));
    expect(text).toContain("This is an experiment.");
  });

  it("the sample brag card says it is a sample", () => {
    const src = read("app/page.tsx");
    expect(src).toContain('label="Sample card"');
    expect(src).toContain("a made-up agent");
    const html = renderToStaticMarkup(h(BragCard, { lot: 1, label: "Sample card", claim: "x", store: "Grumpy Heron", finalCents: 7700, trail: [10000], foot: ["a"] }));
    expect(html).toContain("Sample card");
  });
});

describe("copy", () => {
  it("home: the headline, send your agent first, have a go yourself second", () => {
    const src = read("app/page.tsx");
    expect(src).toContain("Going, going,");
    expect(src).toContain("cheaper.");
    expect(src.indexOf("<PasteSwitcher")).toBeLessThan(src.indexOf("No agent handy? Have a go yourself."));
    expect(src).toContain('action="/ring"');
    expect(src).toContain("<RingReplay");
    expect(src).toContain("<ExperimentBand");
    expect(src).toContain("<LeagueTable");
    expect(src).toContain("<RealThing");
    expect(src).toContain("<StoresStrip");
    expect(src).toContain("<HouseRules");
  });

  it("the paste lines say what the agent should do, and the Claude Code line is the real command", () => {
    const lines = pasteLines("https://haggleboard.com");
    expect(lines.map((l) => l.tab)).toEqual(["Claude Code", "Any agent with web access", "Skill file", "API"]);
    expect(lines[0]!.line).toBe("claude mcp add --transport http haggleboard https://haggleboard.com/api/mcp");
    expect(lines[1]!.line).toContain("haggleboard.com/ring?q=");
  });

  it("the real thing is stated honestly: works today, being switched on", () => {
    const text = visibleText(renderToStaticMarkup(h(RealThing, { site: "https://haggleboard.com" })));
    expect(text).toContain("Works today");
    expect(text).toContain("Being switched on");
    expect(text).toContain("No real store has signed up yet.");
    expect(visibleText(renderToStaticMarkup(h(StoresStrip)))).toContain("Agents are out shopping.");
    expect(visibleText(renderToStaticMarkup(h(HouseRules)))).toContain("Nobody can pay to win.");
  });

  it("never names a big company as the middleman", () => {
    const why = visibleText(renderToStaticMarkup(h(WhyLower)));
    expect(why).toContain("On a big shopping site");
    for (const file of PUBLIC_COPY) {
      const src = read(file);
      expect(src, file).not.toMatch(/\b(Amazon|Google|Meta|eBay|Walmart)\b/);
    }
  });

  it("has no em dashes or corporate words", () => {
    for (const file of PUBLIC_COPY) {
      const src = read(file);
      expect(src, file).not.toContain("—");
      expect(src, file).not.toMatch(/\b(seamless|robust|unlock|empower|revolutionary|leverage)\b/i);
    }
  });

  it("one stylesheet: the old cream look is gone", () => {
    expect(fs.existsSync(path.join(process.cwd(), "app/globals.css"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "app/arena.css"))).toBe(false);
    const css = read("app/brand.css");
    expect(css).toContain("--blue: #2a2be0");
    expect(css).not.toMatch(/#f3eadc|Fraunces|Outfit/i);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(":focus-visible");
  });
});
