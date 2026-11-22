import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Arena } from "../components/arena/arena";
import { AgentBadges, AgentScorecard, BiggestSaves } from "../components/arena/gamification";
import { ResultCard } from "../components/arena/result-card";
import { HowItWorks, MoneyDiagram } from "../components/home/how-it-works";
import {
  MONEY_PATTERN,
  PRIVATE_FIELD_NAMES,
  arenaStateAt,
  rankBidders,
  toBand,
  toPublicArenaEvent,
  toPublicArenaEvents,
} from "../lib/arena";
import { DEMO_BADGES, DEMO_BIGGEST_SAVES, DEMO_SCORECARD, DEMO_STORES, FULL_SCRIPT, HERO_SCRIPT } from "../lib/arena-demo";

const DEMO_LABEL = /data-demo-label/;

function renderArena(script = HERO_SCRIPT, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(Arena, {
      request: script.request,
      durationSec: script.durationSec,
      bidders: script.bidders,
      events: script.events,
      demo: true,
      ...extra,
    }),
  );
}

const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

describe("demo is labelled wherever it renders", () => {
  it("arena (hero and full)", () => {
    expect(renderArena(HERO_SCRIPT, { variant: "hero" })).toMatch(DEMO_LABEL);
    expect(renderArena(FULL_SCRIPT, { variant: "full", controls: true })).toMatch(DEMO_LABEL);
    expect(visibleText(renderArena())).toMatch(/Demo · made-up stores and numbers/);
  });

  it("result card, scorecard, badges and biggest saves", () => {
    const pieces = [
      h(ResultCard, { request: "x", winner: "Ten Toes", savedPct: 14, wonAtSec: 112, demo: true }),
      h(AgentScorecard, { ...DEMO_SCORECARD, demo: true }),
      h(AgentBadges, { badges: DEMO_BADGES, demo: true }),
      h(BiggestSaves, { items: DEMO_BIGGEST_SAVES, demo: true }),
    ];
    for (const piece of pieces) expect(renderToStaticMarkup(piece)).toMatch(DEMO_LABEL);
  });

  it("homepage and /arena/demo only render demo data with demo={true}", () => {
    for (const file of ["app/page.tsx", "app/arena/demo/page.tsx", "app/arena/demo/demo-stage.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      // Every component fed from lib/arena-demo is given the demo flag.
      const tags = src.match(/<(Arena|ResultCard|AgentScorecard|AgentBadges|BiggestSaves)\b[\s\S]*?\/>/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/\bdemo\b(?!=\{false\})/);
    }
    const og = fs.readFileSync(path.join(process.cwd(), "app/arena/demo/opengraph-image.tsx"), "utf8");
    expect(og).toMatch(/DEMO · made-up stores/);
  });

  it("demo stores are made up: no real store domains or brands", () => {
    const names = DEMO_STORES.map((s) => s.name.toLowerCase());
    const real = JSON.parse(fs.readFileSync(path.join(process.cwd(), "feeds/seeds/stores.json"), "utf8")) as unknown;
    const text = JSON.stringify(real).toLowerCase();
    for (const name of names) expect(text).not.toContain(name);
    for (const brand of ["nike", "brooks", "hoka", "asics", "saucony", "adidas", "amazon", "ebay"]) {
      expect(names.join(" ")).not.toContain(brand);
      expect(HERO_SCRIPT.request.toLowerCase()).not.toContain(brand);
    }
  });
});

describe("public arena markup carries no private fields or amounts", () => {
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
    expect(events[2]).toEqual({ kind: "lead", at: 30, bidder: "b", band: 10 });
    // A price only survives when the store chose to reveal it.
    expect(events[3]).toEqual({ kind: "close", at: 120, winner: "b", saved_pct: 12, won_at: 30 });
    expect(toPublicArenaEvent({ ...raw[4], store_chose_to_reveal: true })).toMatchObject({ revealed_price: "$114.00" });
  });

  it("bands are coarse", () => {
    expect([toBand(0), toBand(2), toBand(7.4), toBand(8), toBand(12.4), toBand(99)]).toEqual([0, 5, 5, 10, 10, 40]);
  });

  it("rendered arenas, strips and cards contain no private field names or amounts", () => {
    const bidders = [
      { id: "a", name: "Puddlejump", tone: "clay" as const },
      { id: "b", name: "Grumpy Heron", tone: "plum" as const },
    ];
    const html = [
      renderToStaticMarkup(h(Arena, { request: "Trail shoes", durationSec: 120, bidders, events: toPublicArenaEvents(raw), demo: false, startStatic: true })),
      renderArena(HERO_SCRIPT),
      renderArena(FULL_SCRIPT, { variant: "full", controls: true }),
      renderToStaticMarkup(h(BiggestSaves, { items: DEMO_BIGGEST_SAVES, demo: true })),
      renderToStaticMarkup(h(ResultCard, { request: "Trail shoes", winner: "Grumpy Heron", savedPct: 18, wonAtSec: 118, demo: true })),
    ].join("\n");
    for (const field of PRIVATE_FIELD_NAMES) expect(html).not.toContain(field);
    expect(visibleText(html)).not.toMatch(MONEY_PATTERN);
    expect(html).not.toMatch(/u_123|ord_9|x@y\.z|11900|9900/);
  });

  it("demo scripts are already public events", () => {
    for (const script of [HERO_SCRIPT, FULL_SCRIPT]) {
      expect(toPublicArenaEvents(script.events)).toEqual(script.events);
    }
  });
});

describe("reduced motion and no-JS render the whole story", () => {
  it("hero arena, static: request, every store, the lead changes and the winner", () => {
    const text = visibleText(renderArena(HERO_SCRIPT, { variant: "hero" }));
    expect(text).toContain(HERO_SCRIPT.request);
    for (const b of HERO_SCRIPT.bidders) expect(text).toContain(b.name);
    expect(text).toMatch(/3 stores joined/);
    expect(text).toMatch(/lead changed hands 4 times: Puddlejump, then Grumpy Heron, then Puddlejump, then Grumpy Heron, then Ten Toes/);
    expect(text).toMatch(/Ten Toes wins/);
    expect(text).toMatch(/14% under the best public price, in 1 minute 52 seconds/);
    expect(text).toMatch(/Your agent saved you 14%/);
    expect(text).toMatch(/Two-minute clock, finished/);
  });

  it("full arena, static: every commentary line in order", () => {
    const text = visibleText(renderArena(FULL_SCRIPT, { variant: "full" }));
    const state = arenaStateAt(FULL_SCRIPT.events, FULL_SCRIPT.bidders, FULL_SCRIPT.durationSec, FULL_SCRIPT.durationSec);
    let from = 0;
    for (const line of state.commentary.filter((l) => l.tone !== "close")) {
      const at = text.indexOf(line.text, from);
      expect(at, line.text).toBeGreaterThan(-1);
      from = at;
    }
    expect(text).toMatch(/snatches it with 2 seconds left/);
    expect(text).toMatch(/Grumpy Heron wins/);
  });

  it("playback only starts when the visitor has not asked for reduced motion", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/arena/arena.tsx"), "utf8");
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
    expect(src).toMatch(/if \(!query\.matches\) restart\(\)/);
    const css = fs.readFileSync(path.join(process.cwd(), "app/arena.css"), "utf8");
    // Every keyframe animation is applied inside a no-preference block.
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/animation:\s*(hb|d|m)-/);
  });

  it("how-it-works diagrams and the money diagram are complete without motion", () => {
    const steps = visibleText(renderToStaticMarkup(h(HowItWorks)));
    for (const title of ["You ask your agent", "Your agent posts it", "Stores compete on the clock", "You buy direct"]) {
      expect(steps).toContain(title);
    }
    const money = visibleText(renderToStaticMarkup(h(MoneyDiagram)));
    expect(money).toMatch(/Illustrative numbers/);
    expect(money).toMatch(/You pay \$100/);
    expect(money).toMatch(/You pay \$88/);
  });
});

describe("arena state", () => {
  it("counts lead changes and closes on the winner", () => {
    const s = arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 120);
    expect(s.phase).toBe("closed");
    expect(s.leaderId).toBe("c");
    expect(s.leadChanges).toBe(4);
    const mid = arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 45);
    expect(mid.leaderId).toBe("b");
    expect(mid.leaderBand).toBe(10);
    expect(mid.bidders.find((b) => b.bidder.id === "c")?.joined).toBe(false);
    expect(arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 115).phase).toBe("final");
    expect(arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 106).phase).toBe("final");
  });

  it("ranks the leader on top and lets an overtaking store pass", () => {
    const before = rankBidders(arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 100).bidders);
    const after = rankBidders(arenaStateAt(HERO_SCRIPT.events, HERO_SCRIPT.bidders, 120, 113).bidders);
    expect(before.map((b) => b.bidder.id)).toEqual(["a", "b", "c"]);
    expect(after.map((b) => b.bidder.id)).toEqual(["c", "a", "b"]);
  });

  it("speeds up in the last 15 seconds of the demo scripts", () => {
    for (const script of [HERO_SCRIPT, FULL_SCRIPT]) {
      const late = script.events.filter((e) => e.kind === "lead" && e.at >= script.durationSec - 15);
      expect(late.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("homepage copy", () => {
  const files = [
    "app/page.tsx",
    "app/arena/demo/page.tsx",
    "app/arena/demo/demo-stage.tsx",
    "components/arena/arena.tsx",
    "components/arena/result-card.tsx",
    "components/arena/gamification.tsx",
    "components/home/how-it-works.tsx",
    "lib/arena.ts",
    "lib/arena-demo.ts",
  ];
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it("leads with the promise, one input, and what agents need", () => {
    const src = read("app/page.tsx");
    expect(src).toContain("Tell your AI agent what you want.");
    expect(src).toContain("Stores compete to give it the best deal.");
    expect(src).toContain("What are you looking for?");
    expect(src).toMatch(/action="\/results"/);
    expect(src).toContain("/api/mcp");
    expect(src).toContain('href="/llms.txt"');
    expect(src).toContain('href="/skill.md"');
    expect(src).toContain("post_request");
    // Says what is live and what is not yet.
    expect(src).toMatch(/Live now:/);
    expect(src).toMatch(/Coming:/);
    // Keeps the standing promises.
    expect(src).toContain("Never touches your money");
    expect(src).toContain("Not a party to the sale");
    expect(src).toContain("Rankings are not for sale");
    // Existing features stay reachable.
    expect(src).toContain("/q/${question.slug}");
    expect(src).toContain("/r/${item.id}");
    expect(src).toContain("<NeedForm />");
    expect(src).toContain('id="mcp"');
  });

  it("has no em dashes or banned words", () => {
    for (const file of files) {
      const src = read(file);
      expect(src, file).not.toContain("—");
      expect(src, file).not.toMatch(/seamless|robust|unlock|revolutionary/i);
    }
  });
});
