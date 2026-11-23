import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { hostMatchesDomain } from "../feeds/host.js";
import type { Statement, Store } from "../lib/db.js";
import { eventStatement, type EventContext } from "../lib/events.js";
import { HttpError } from "../lib/http.js";
import { bidsEnabled, hmacEqual, storeKeyHmac } from "../lib/keys.js";
import { brandKey } from "../referee/brands.js";
import { centsToDecimal } from "../referee/money.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import { DEFAULT_OFFER_TTL_MINUTES, MAX_OFFER_TTL_MINUTES, storeRulesEnabled } from "./constants.js";
import { HELD_UNDERCUT_RATIO } from "../lib/auction.js";

/**
 * STORE SIDE. Shipped OFF (STORE_RULES_ENABLED). A store that has claimed its listing (it holds a
 * store key from `npm run issue-key`) sets one standing rule:
 *
 *   "Beat a held order by going up to X percent below my public price, never below my floor,
 *    for these products."
 *
 * The watcher applies the rule when a request carries a holding and the store's public price does
 * not already beat it. The result is a private offer with an expiry. Only the posting agent sees it.
 * The floor never leaves the store_rules table: it is not returned by any endpoint, not echoed when
 * the rule is saved, and not put in the offer.
 */
export const storeRuleSchema = z
  .object({
    beat_by_up_to_percent: z.number().min(0).max(50),
    floor: z
      .object({
        price: z.number().positive().max(1_000_000),
        currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
      })
      .strict(),
    eligible: z
      .object({
        all: z.boolean().optional(),
        brands: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
        product_urls: z.array(z.string().trim().url()).max(200).optional(),
      })
      .strict(),
    offer_ttl_minutes: z.number().int().min(1).max(MAX_OFFER_TTL_MINUTES).optional(),
  })
  .strict();

export type StoreRule = z.infer<typeof storeRuleSchema>;

export async function saveStoreRule(
  input: unknown,
  key: string | null,
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
  ctx?: EventContext,
): Promise<{ saved: true; store_domain: string }> {
  if (!storeRulesEnabled(env) || !bidsEnabled(env)) {
    throw new HttpError(503, "Store rules are off. They need STORE_RULES_ENABLED and BID_KEYS_ENABLED.");
  }
  const signing = env.BID_TOKEN_SIGNING_KEY?.trim();
  if (!signing) throw new HttpError(503, "Store rules need BID_TOKEN_SIGNING_KEY.");
  const parsed = z
    .object({
      store_domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
      rule: storeRuleSchema,
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) throw new HttpError(400, "The rule is not valid");
  if (!key || key.length < 32 || key.length > 200 || /\s/.test(key)) {
    throw new HttpError(401, "Send the store key in X-HaggleBoard-Store-Key.");
  }
  if (store.kind === "unavailable") throw new HttpError(503, "Store rules need DATABASE_URL.");
  const { store_domain, rule } = parsed.data;
  for (const url of rule.eligible.product_urls ?? []) {
    const host = new URL(url).hostname;
    if (!hostMatchesDomain(host, store_domain)) throw new HttpError(400, "product_urls must be on the store's own site");
  }
  const actual = storeKeyHmac(signing, store_domain, key);
  const expected = (await store.getStoreKey(store_domain)) ?? "0".repeat(actual.length);
  if (!hmacEqual(expected, actual)) throw new HttpError(401, "That store key does not match the key issued for this store.");
  // The rule and store.rule_set in one transaction. The floor goes only into the private JSON.
  await store.batch([
    [
      `INSERT INTO store_rules (store_domain, rule_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(store_domain) DO UPDATE SET rule_json = excluded.rule_json, created_at = excluded.created_at`,
      [store_domain, JSON.stringify(rule), new Date().toISOString()],
    ],
    eventStatement(
      {
        type: "store.rule_set",
        store_domain,
        public: {
          covers: rule.eligible.all === true ? "all" : "some",
          brands: rule.eligible.brands?.length ?? 0,
          product_urls: rule.eligible.product_urls?.length ?? 0,
          max_discount_band: discountBand(rule.beat_by_up_to_percent),
          offer_ttl_minutes: rule.offer_ttl_minutes ?? DEFAULT_OFFER_TTL_MINUTES,
        },
        private: { floor_price: rule.floor.price, floor_currency: rule.floor.currency, beat_by_up_to_percent: rule.beat_by_up_to_percent },
      },
      ctx ?? null,
    ),
  ]);
  return { saved: true, store_domain };
}

export async function getStoreRule(store: Store, domain: string): Promise<StoreRule | null> {
  if (store.kind === "unavailable") return null;
  const row = (await store.select("SELECT rule_json FROM store_rules WHERE store_domain = ?", [domain]))[0];
  if (!row) return null;
  const parsed = storeRuleSchema.safeParse(JSON.parse(String(row.rule_json)));
  return parsed.success ? parsed.data : null;
}

/** A store has claimed its listing when it holds an issued store key. */
export async function storeHasClaimed(store: Store, domain: string): Promise<boolean> {
  return (await store.getStoreKey(domain)) != null;
}

/**
 * The private offer. Its fields follow the HaggleBoard Protocol (HBP v0.1) Offer message so a later
 * version can sign it, but today it is NOT a valid HBP message:
 *  - signature is null: HaggleBoard has no store key pairs (no Ed25519 key management is built);
 *  - "retail" is not a category in HBP v0.1 (hotel, electronics, b2b), so terms.category would need
 *    a new ext-retail.json;
 *  - no deal token is issued, so there is no accept step and nothing to take to a UCP or ACP checkout.
 * The buyer still checks out on the store's own site at product_url.
 */
export type PrivateOffer = {
  id: string;
  request_id: string;
  store_domain: string;
  product_url: string;
  title: string;
  price: string;
  price_cents: number;
  currency: string;
  /** The store's own public price for the same listing, for comparison. */
  public_price: string;
  expires_at: string;
  created_at: string;
  hbp: {
    hbp: "0.1";
    type: "offer";
    thread_id: string;
    message_id: string;
    in_reply_to: string;
    sent_at: string;
    from: { agent_id: string; role: "seller" };
    nonce: string;
    round: 1;
    expires_at: string;
    terms: {
      category: string;
      item: { product_url: string; title: string; gtin: string | null; size: string | null; color: string | null; quantity: number };
      price: { amount: string; currency: string };
    };
    signature: null;
    relayed_by: "haggleboard.com";
    note: string;
  };
};

export type RuleDecision = { offer: PrivateOffer } | { offer: null; reason: string };

function eligible(rule: StoreRule, variant: CatalogVariant): boolean {
  if (rule.eligible.all === true) return true;
  if ((rule.eligible.brands ?? []).some((brand) => brandKey(brand) === brandKey(variant.brand))) return true;
  const base = variant.product_url.split("?")[0];
  return (rule.eligible.product_urls ?? []).some((url) => url.split("?")[0] === base);
}

/**
 * What a rule competes against when the request has no held order: the offer leading the auction
 * right now (its amount, in the same currency). The store goes under it by `step_percent`.
 */
export type Competition = { leader_cents: number; leader_store: string; currency: string; step_percent: number };

export function applyStoreRule(
  rule: StoreRule,
  variant: CatalogVariant,
  need: ResolvedNeed,
  requestId: string,
  now = Date.now(),
  competition: Competition | null = null,
): RuleDecision {
  const holding = need.holding;
  if (!holding && !competition) return { offer: null, reason: "no held order to beat" };
  if (!eligible(rule, variant)) return { offer: null, reason: "product not in the store's rule" };
  const currency = variant.currency.toUpperCase();
  const targetCurrency = holding ? holding.currency : competition!.currency.toUpperCase();
  if (targetCurrency !== currency || rule.floor.currency.toUpperCase() !== currency) {
    return { offer: null, reason: "different currency" };
  }
  const quantity = Math.max(1, need.quantity);
  const publicPrice = variant.price_cents;
  const floorCents = Math.round(rule.floor.price * 100);
  const lowest = Math.max(floorCents, Math.ceil(publicPrice * (1 - rule.beat_by_up_to_percent / 100)));
  let price: number;
  let toBeat: number;
  if (holding) {
    toBeat = Math.floor(holding.price_cents / quantity);
    if (publicPrice < toBeat) return { offer: null, reason: "the public price already beats the held order" };
    // Beat the held price by about 1 percent (HELD_UNDERCUT_RATIO), at least 1 cent.
    const target = Math.min(toBeat - 1, Math.floor(toBeat * HELD_UNDERCUT_RATIO));
    price = Math.max(lowest, target);
    if (price >= toBeat) return { offer: null, reason: "cannot beat the held order within the store's rule" };
  } else {
    if (competition!.leader_store === variant.store_domain) return { offer: null, reason: "already leading" };
    toBeat = competition!.leader_cents;
    // Go under the leader by step_percent, rounded down to a whole currency unit minus a cent (x.99).
    const raw = Math.floor(toBeat * (1 - competition!.step_percent / 100));
    const tidy = Math.max(1, Math.floor(raw / 100) * 100 - 1);
    price = Math.max(lowest, tidy);
    if (price >= toBeat) return { offer: null, reason: "cannot beat the leader within the store's rule" };
  }

  const ttl = rule.offer_ttl_minutes ?? DEFAULT_OFFER_TTL_MINUTES;
  const sentAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttl * 60_000).toISOString();
  const id = randomUUID();
  const amount = centsToDecimal(price);
  return {
    offer: {
      id,
      request_id: requestId,
      store_domain: variant.store_domain,
      product_url: variant.product_url,
      title: variant.title,
      price: amount,
      price_cents: price,
      currency,
      public_price: variant.price,
      expires_at: expiresAt,
      created_at: sentAt,
      hbp: {
        hbp: "0.1",
        type: "offer",
        thread_id: `hb_${requestId}`,
        message_id: id,
        in_reply_to: `hb_req_${requestId}`,
        sent_at: sentAt,
        from: { agent_id: `https://${variant.store_domain}`, role: "seller" },
        nonce: randomBytes(16).toString("hex"),
        round: 1,
        expires_at: expiresAt,
        terms: {
          category: "retail",
          item: {
            product_url: variant.product_url,
            title: variant.title,
            gtin: need.gtin,
            size: variant.size,
            color: variant.color,
            quantity,
          },
          price: { amount, currency },
        },
        signature: null,
        relayed_by: "haggleboard.com",
        note: "Unsigned. Made by HaggleBoard under the store's standing rule. Check out on the store's own site.",
      },
    },
  };
}

export function privateOfferStatement(offer: PrivateOffer): Statement {
  return [
    "INSERT INTO private_offers (id, request_id, store_domain, offer_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [offer.id, offer.request_id, offer.store_domain, JSON.stringify(offer), offer.created_at, offer.expires_at],
  ];
}

export async function savePrivateOffer(store: Store, offer: PrivateOffer): Promise<void> {
  await store.batch([privateOfferStatement(offer)]);
}

/** A coarse band for a rule's maximum discount. The floor itself is never in a public field. */
function discountBand(percent: number): string {
  if (percent <= 5) return "0_5";
  if (percent <= 10) return "5_10";
  if (percent <= 20) return "10_20";
  return "20_plus";
}

/** Live (not expired) private offers for one request. Callers must only show these to the poster. */
export async function listPrivateOffers(store: Store, requestId: string, now = Date.now()): Promise<PrivateOffer[]> {
  if (store.kind === "unavailable") return [];
  const rows = await store.select("SELECT offer_json FROM private_offers WHERE request_id = ? AND expires_at > ?", [
    requestId,
    new Date(now).toISOString(),
  ]);
  return rows.map((row) => JSON.parse(String(row.offer_json)) as PrivateOffer);
}
