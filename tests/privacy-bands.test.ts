import { describe, expect, it } from "vitest";
import {
  BAND_LABELS,
  offerEvents,
  privateBandDisclosure,
  type AuctionOffer,
  type AuctionWindow,
  type IncomingOffer,
} from "../lib/auction";
import { toPublicEvents } from "../lib/stream";
import type { EventRow } from "../lib/events";
import type { CatalogVariant, ResolvedNeed } from "../referee/types";
import { applyStoreRule, type StoreRule } from "../watcher/store-rules";

/**
 * THE ATTACK. An observer reads the public feed of an auction in which a claimed store answered a
 * held order with a private offer. The observer is strong: it knows every public price, the
 * store's own public price, the pricing formula the rules engine uses, the rule's published
 * maximum-discount band (store.rule_set publishes it), and searches over every floor. It tries
 * every held price on a fine grid and keeps the ones that would have produced exactly the public
 * feed it saw. If the spread of those held prices is ever narrower than the band width (5% of the
 * best public price, the finest band), the band leaked the held price and the test fails.
 */

const OPENED = "2026-11-22T12:00:00.000Z";
const WINDOW: AuctionWindow = { opened_at: OPENED, deadline: "2026-11-22T12:02:00.000Z", window_seconds: 120 };
const T0 = Date.parse(OPENED);

const need = (heldCents: number): ResolvedNeed =>
  ({
    text: null,
    brand: "Fictional",
    model: "Glider 3",
    gtin: null,
    gender: "women",
    size: "8",
    color: null,
    category: null,
    attributes: {},
    quantity: 1,
    max_price_cents: null,
    currency: null,
    country: null,
    region: null,
    holding: { seller: null, price_cents: heldCents, currency: "USD", delivered: true, delivery_by: null },
  }) as unknown as ResolvedNeed;

function listing(domain: string, cents: number): CatalogVariant {
  return {
    id: `${domain}:1`,
    store_domain: domain,
    shop_origin: `https://${domain}`,
    country: null,
    region: null,
    brand: "Fictional",
    model: "Glider 3",
    title: "Fictional Glider 3",
    gender: "women",
    size: "8",
    size_raw: "8",
    size_system: null,
    size_men: null,
    size_women: "8",
    width: null,
    color: null,
    available: true,
    price: (cents / 100).toFixed(2),
    price_cents: cents,
    compare_at_price: null,
    compare_at_cents: null,
    currency: "USD",
    product_url: `https://${domain}/products/glider-3`,
    handle: "glider-3",
    external_product_id: "1",
    external_variant_id: "1",
    category: "shoe",
    observed_at: OPENED,
  };
}

const publicOffer = (domain: string, cents: number): IncomingOffer => ({
  store_domain: domain,
  source: "public_price",
  via: "watcher",
  price_cents: cents,
  currency: "USD",
  available: true,
  product_url: `https://${domain}/p`,
  title: null,
  expires_at: null,
});

type Scenario = { name: string; others: number[]; own: number; beat: number; floor: number };

/**
 * What the public sees, as text. `made` says whether a private offer was made at all: when none was
 * (the held price is above the store's public price, or the rule cannot beat it), the public feed is
 * just the public prices, which the attacker cannot tell apart from an offer that never led.
 */
function publicFeed(scenario: Scenario, heldCents: number, rule: StoreRule, oldPlainBands = false): { feed: string; made: boolean } {
  const own = listing("claimed-shop.test", scenario.own);
  const decision = applyStoreRule(rule, own, need(heldCents), "r", T0 + 5_000);
  const incoming: IncomingOffer[] = [
    ...scenario.others.map((cents, i) => publicOffer(`other-${i}.test`, cents)),
    publicOffer("claimed-shop.test", scenario.own),
  ];
  if (decision.offer) {
    incoming.push({
      store_domain: "claimed-shop.test",
      source: "private_offer",
      via: "store_rule",
      price_cents: decision.offer.price_cents,
      currency: "USD",
      available: true,
      product_url: own.product_url,
      title: null,
      expires_at: decision.offer.expires_at,
      discount_cap_percent: rule.beat_by_up_to_percent,
    });
  }
  const { events } = offerEvents("r", WINDOW, [] as AuctionOffer[], incoming, T0 + 1_000);
  const rows: EventRow[] = [
    { id: "p", at: OPENED, type: "request.posted", request_id: "r", store_domain: null, agent_class: "x", internal: false, public: { deadline: WINDOW.deadline, window_seconds: 120 }, private: {} },
    ...events.map((event, i) => ({
      id: `e${String(i).padStart(3, "0")}`,
      at: event.at!,
      type: event.type,
      request_id: "r",
      store_domain: event.store_domain ?? null,
      agent_class: "x",
      internal: false,
      // oldPlainBands: what the feed showed before this fix (the plain band against the best public price).
      public: oldPlainBands && event.type === "lead.changed" ? { ...event.public, band: event.private?.plain_band } : (event.public ?? {}),
      private: event.private ?? {},
    })),
  ];
  const feed = toPublicEvents(rows).map((event) => {
    const { seq: _seq, at: _at, ...rest } = event as { seq: number; at: string };
    return rest;
  });
  return { feed: JSON.stringify(feed), made: decision.offer != null };
}

const rule = (beat: number, floorCents: number): StoreRule => ({
  beat_by_up_to_percent: beat,
  floor: { price: floorCents / 100, currency: "USD" },
  eligible: { all: true },
});

/** The published max-discount band for a rule (store.rule_set): the attacker knows only this. */
function discountBand(percent: number): [number, number] {
  if (percent <= 5) return [0.5, 5];
  if (percent <= 10) return [5.5, 10];
  if (percent <= 20) return [10.5, 20];
  return [20.5, 50];
}

const SCENARIOS: Scenario[] = [
  { name: "store's own price is the best public price", others: [12_000, 12_900], own: 11_995, beat: 10, floor: 9_000 },
  { name: "own price just over the best", others: [12_000], own: 12_050, beat: 8, floor: 9_500 },
  { name: "own price well over the best", others: [10_000, 10_400], own: 13_000, beat: 25, floor: 8_000 },
  { name: "small discount room", others: [11_000, 11_500], own: 11_800, beat: 3, floor: 11_000 },
  { name: "deep discount room", others: [9_000, 9_900], own: 12_500, beat: 40, floor: 6_000 },
  { name: "only one other public price", others: [10_000], own: 10_500, beat: 10, floor: 8_000 },
  { name: "no other public price", others: [], own: 10_000, beat: 15, floor: 7_000 },
  { name: "two close public prices", others: [15_000, 15_050], own: 15_100, beat: 12, floor: 12_000 },
];

describe("private offer bands cannot be used to recover the held price", () => {
  for (const scenario of SCENARIOS) {
    it(`attack fails: ${scenario.name}`, () => {
      const truthRule = rule(scenario.beat, scenario.floor);
      const R = Math.min(...scenario.others, scenario.own);
      const bandWidth = 0.05 * R;
      const [minBeat, maxBeat] = discountBand(scenario.beat);
      // Every held price the attacker will consider, on a fine grid (0.5% of R or finer).
      const step = Math.max(10, Math.floor(R / 250));
      const grid: number[] = [];
      for (let h = Math.round(R * 0.6); h <= Math.round(scenario.own * 1.1); h += step) grid.push(h);
      // Rules the attacker cannot tell apart: any max discount in the published band, any floor.
      const rules: StoreRule[] = [];
      for (let beat = minBeat; beat <= maxBeat; beat += Math.max(0.5, (maxBeat - minBeat) / 8)) {
        for (const floorRatio of [0.5, 0.75, 0.85, 0.92]) rules.push(rule(beat, Math.round(scenario.own * floorRatio)));
      }
      // What each (held price, rule) pair would show the public.
      const byFeed = new Map<string, Set<number>>();
      for (const candidate of grid) {
        for (const r of rules) {
          const { feed } = publicFeed(scenario, candidate, r);
          const set = byFeed.get(feed) ?? new Set<number>();
          set.add(candidate);
          byFeed.set(feed, set);
        }
      }
      let attacked = 0;
      for (const held of grid) {
        const { feed: seen, made } = publicFeed(scenario, held, truthRule);
        // Only held orders a store actually answered are under attack here.
        if (!made) continue;
        attacked += 1;
        const consistent = [...(byFeed.get(seen) ?? new Set<number>([held]))];
        expect(consistent).toContain(held);
        const spread = Math.max(...consistent) - Math.min(...consistent);
        if (spread < bandWidth) {
          throw new Error(
            `${scenario.name}: held ${held} narrowed to [${Math.min(...consistent)}, ${Math.max(...consistent)}], ` +
              `spread ${spread} < band width ${bandWidth.toFixed(0)}; feed ${seen}`,
          );
        }
      }
      expect(attacked).toBeGreaterThan(0);
    }, 120_000);
  }

  it("the same attack does recover the held price from the old plain bands (so the test has teeth)", () => {
    const scenario = SCENARIOS[0]!;
    const truthRule = rule(scenario.beat, scenario.floor);
    const R = Math.min(...scenario.others, scenario.own);
    const grid: number[] = [];
    for (let h = Math.round(R * 0.6); h <= Math.round(scenario.own * 1.1); h += 25) grid.push(h);
    const byFeed = new Map<string, Set<number>>();
    for (const candidate of grid) {
      const { feed } = publicFeed(scenario, candidate, truthRule, true);
      byFeed.set(feed, (byFeed.get(feed) ?? new Set<number>()).add(candidate));
    }
    let narrowest = Infinity;
    for (const held of grid) {
      const { feed, made } = publicFeed(scenario, held, truthRule, true);
      if (!made) continue;
      const set = [...byFeed.get(feed)!];
      narrowest = Math.min(narrowest, Math.max(...set) - Math.min(...set));
    }
    expect(narrowest).toBeLessThan(0.05 * R);
  });

  it("withholds the band with fewer than two public prices, and when the store's own price sits at the best", () => {
    expect(privateBandDisclosure({ publicPrices: [10_000], ownPublic: 10_000 })).toMatchObject({ show: false });
    expect(privateBandDisclosure({ publicPrices: [], ownPublic: 10_000 })).toMatchObject({ show: false });
    expect(privateBandDisclosure({ publicPrices: [10_000, 10_500], ownPublic: 10_000 })).toMatchObject({ show: false });
    expect(privateBandDisclosure({ publicPrices: [10_000, 10_500], ownPublic: 10_050 })).toMatchObject({ show: false });
    expect(privateBandDisclosure({ publicPrices: [10_000, 12_000], ownPublic: 12_000 })).toMatchObject({ show: true });
    expect(BAND_LABELS.withheld).toBe("private offer");
  });

  it("decides on public information only: the same context gives the same answer for any offer amount", () => {
    const context = { publicPrices: [10_000, 11_000], ownPublic: 11_000 };
    const first = privateBandDisclosure(context);
    for (let i = 0; i < 5; i++) expect(privateBandDisclosure(context)).toEqual(first);
  });
});
