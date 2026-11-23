import { currentOffers, offersFromEvents, windowFromEvents, type AuctionWindow } from "../lib/auction.js";
import type { Store } from "../lib/db.js";
import { requestEvents } from "../lib/events.js";
import { recordOffers } from "../lib/service.js";
import { centsToDecimal } from "../referee/money.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import { respondUnderRule } from "./respond.js";
import { storeRuleSchema, type StoreRule } from "./store-rules.js";

/**
 * TEST ARENA (local only). With TEST_STORES=1, three made-up claimed stores answer every new request
 * so the owner can watch the real engine run end to end: the store rules engine, private offers,
 * lead changes, events and the close. Nothing here is a real store:
 *
 *  - names are invented and every domain is under the reserved `.example` TLD;
 *  - every event they cause carries `test: true` and `internal: true`, so it is left out of stats,
 *    the sitemap, JSON-LD, store pages and store notifications, and the arena shows "Test stores";
 *  - their list prices are invented from the auction's own best public price (or a round 120.00).
 *
 * Off unless TEST_STORES is 1/true/yes, and refused outright on the public production site
 * (HB_PUBLIC=1 or VERCEL_ENV=production) even if the flag is set by mistake.
 */

export type TestStore = {
  domain: string;
  name: string;
  /** The store's standing rule, the same shape a claimed store saves with POST /api/stores/rule. */
  rule: StoreRule;
  /** Its invented list price, as a ratio of the auction's best public price. */
  list_ratio: number;
  /** How far under the leader it goes each time it answers. */
  step_percent: number;
  /** When it looks at the auction, as fractions of the window. The first one is when it joins. */
  checks: number[];
  /** One line on its rule, for the docs and the test. */
  style: string;
};

const rule = (beat: number, floorRatio: number): ((base: number, currency: string) => StoreRule) =>
  (base, currency) =>
    storeRuleSchema.parse({
      beat_by_up_to_percent: beat,
      floor: { price: Math.round(base * floorRatio) / 100, currency },
      eligible: { all: true },
      offer_ttl_minutes: 30,
    });

type Spec = Omit<TestStore, "rule"> & { makeRule: (base: number, currency: string) => StoreRule };

const SPECS: Spec[] = [
  {
    domain: "quillfeather-running.example",
    name: "Quillfeather Running",
    list_ratio: 1.0,
    step_percent: 1.5,
    checks: [0.06, 0.28, 0.5, 0.72, 0.95],
    makeRule: rule(9, 0.9),
    style: "fast: answers within seconds and checks often, up to 9% off its list price, private floor at 90%",
  },
  {
    domain: "bramblewick-outfitters.example",
    name: "Bramblewick Outfitters",
    list_ratio: 1.02,
    step_percent: 2,
    checks: [0.3, 0.62, 0.9],
    makeRule: rule(12, 0.87),
    style: "steady: joins a third of the way in and checks twice more, up to 12% off, private floor at 87%",
  },
  {
    domain: "tollgate-shoe-co.example",
    name: "Tollgate Shoe Co.",
    list_ratio: 1.04,
    step_percent: 2.5,
    checks: [0.83, 0.97],
    makeRule: rule(16, 0.84),
    style: "late: only joins in the last part of the clock, up to 16% off, private floor at 84%",
  },
];

export const TEST_STORE_DOMAINS = SPECS.map((spec) => spec.domain);

function flag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function testStoresEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!flag(env.TEST_STORES)) return false;
  if (flag(env.HB_PUBLIC) || env.VERCEL_ENV === "production") return false;
  return true;
}

/** The base the invented prices start from: the auction's best public price now, or 120.00 USD. */
function basePrice(window: AuctionWindow, events: Awaited<ReturnType<typeof requestEvents>>): { cents: number; currency: string } {
  const publics = currentOffers(offersFromEvents(events)).filter((offer) => offer.source === "public_price" && offer.available && !offer.test);
  const best = publics.sort((a, b) => a.price_cents - b.price_cents)[0];
  void window;
  return best ? { cents: best.price_cents, currency: best.currency } : { cents: 12_000, currency: "USD" };
}

function listing(spec: Spec, need: ResolvedNeed, base: { cents: number; currency: string }, now: number): CatalogVariant {
  const cents = Math.max(100, Math.round((base.cents * spec.list_ratio) / 100) * 100 - 1);
  const handle = "test-listing";
  return {
    id: `${spec.domain}:${handle}`,
    store_domain: spec.domain,
    shop_origin: `https://${spec.domain}`,
    country: null,
    region: null,
    brand: need.brand ?? "Test",
    model: need.model ?? "listing",
    title: `${need.brand ?? ""} ${need.model ?? "Test listing"}`.trim(),
    gender: need.gender ?? "unknown",
    size: need.size,
    size_raw: need.size,
    size_system: null,
    size_men: null,
    size_women: null,
    width: null,
    color: null,
    available: true,
    price: centsToDecimal(cents),
    price_cents: cents,
    compare_at_price: null,
    compare_at_cents: null,
    currency: base.currency,
    product_url: `https://${spec.domain}/products/${handle}`,
    handle,
    external_product_id: handle,
    external_variant_id: handle,
    category: "other",
    observed_at: new Date(now).toISOString(),
  };
}

export type TestStep = { store: string; at_fraction: number; action: "join" | "check" };

/** The planned schedule for a window: who looks at the auction when. Pure, for the docs and tests. */
export function testSchedule(): TestStep[] {
  return SPECS.flatMap((spec) => spec.checks.map((at, index) => ({ store: spec.domain, at_fraction: at, action: index === 0 ? ("join" as const) : ("check" as const) }))).sort(
    (a, b) => a.at_fraction - b.at_fraction,
  );
}

/**
 * One test store looks at the auction: on its first look it puts in its public list price (a test
 * price), then, if it is not leading, it answers under its rule through respondUnderRule.
 */
export async function testStoreStep(
  store: Store,
  request: { id: string; need: ResolvedNeed },
  domain: string,
  joining: boolean,
  now = Date.now(),
): Promise<"joined" | "bid" | "held" | "closed"> {
  const spec = SPECS.find((item) => item.domain === domain);
  if (!spec) return "held";
  const events = await requestEvents(store, request.id);
  const window = windowFromEvents(events);
  if (!window || new Date(now).toISOString() > window.deadline) return "closed";
  const base = basePrice(window, events);
  const list = listing(spec, request.need, base, now);
  const storeRule = spec.makeRule(list.price_cents, base.currency);
  let joined = false;
  if (joining) {
    await recordOffers(
      store,
      request.id,
      [
        {
          store_domain: spec.domain,
          source: "public_price",
          via: "test_store",
          price_cents: list.price_cents,
          currency: list.currency,
          available: true,
          product_url: list.product_url,
          title: list.title,
          expires_at: null,
          confirmed: true,
          test: true,
        },
      ],
      { now, agent_class: "test-store" },
    );
    joined = true;
  }
  const decision = await respondUnderRule(store, request, storeRule, list, { now: now + 1, stepPercent: spec.step_percent, test: true });
  if (decision.offer) return "bid";
  return joined ? "joined" : "held";
}

/**
 * Schedules the three test stores across the request's window, in this process (the local server).
 * Returns the timers so a caller (or a test) can cancel them.
 */
export function scheduleTestStores(
  store: Store,
  request: { id: string; need: ResolvedNeed },
  window: { opened_at: string; window_seconds: number },
  opts: { setTimer?: (fn: () => void, ms: number) => unknown; now?: () => number } = {},
): unknown[] {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  const opened = Date.parse(window.opened_at);
  return testSchedule().map((step) => {
    const due = opened + step.at_fraction * window.window_seconds * 1000;
    return setTimer(() => {
      testStoreStep(store, request, step.store, step.action === "join", now()).catch(() => console.error("test store step failed"));
    }, Math.max(0, due - now()));
  });
}

export const TEST_STORE_STYLES = SPECS.map((spec) => ({ domain: spec.domain, name: spec.name, style: spec.style }));
