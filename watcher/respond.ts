import { currentOffers, leaderOf, offersFromEvents, windowFromEvents } from "../lib/auction.js";
import type { Store } from "../lib/db.js";
import { requestEvents } from "../lib/events.js";
import { recordOffers } from "../lib/service.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import { applyStoreRule, privateOfferStatement, type RuleDecision, type StoreRule } from "./store-rules.js";

/** How far under the current leader a rule goes when the request has no held order. */
export const DEFAULT_STEP_PERCENT = 2;

/**
 * ONE PATH for a claimed store's standing rule to answer a request (the watcher uses it for real
 * claimed stores behind STORE_RULES_ENABLED; the local test arena uses it for its made-up stores).
 *
 * With a held order: beat it, as watcher/store-rules.ts describes. Without one: look at the
 * auction's current leader and go under it by `step_percent`, never below the rule's floor or
 * maximum discount. The private offer is written with recordOffers, so offer.made, any
 * lead.changed, the private_offers row and the close all come from the same engine.
 */
export async function respondUnderRule(
  store: Store,
  request: { id: string; need: ResolvedNeed },
  rule: StoreRule,
  listing: CatalogVariant,
  opts: { now?: number; stepPercent?: number; test?: boolean } = {},
): Promise<RuleDecision> {
  const now = opts.now ?? Date.now();
  const events = await requestEvents(store, request.id);
  const window = windowFromEvents(events);
  if (!window) return { offer: null, reason: "no auction" };
  if (new Date(now).toISOString() > window.deadline) return { offer: null, reason: "the auction has closed" };
  const leader = leaderOf(currentOffers(offersFromEvents(events)), window.opened_at);
  const competition =
    request.need.holding || !leader
      ? null
      : {
          leader_cents: leader.price_cents,
          leader_store: leader.store_domain,
          currency: leader.currency,
          step_percent: opts.stepPercent ?? DEFAULT_STEP_PERCENT,
        };
  if (!request.need.holding && !leader) return { offer: null, reason: "nothing to beat yet" };
  const decision = applyStoreRule(rule, listing, request.need, request.id, now, competition);
  if (!decision.offer) return decision;
  const offer = decision.offer;
  await recordOffers(
    store,
    request.id,
    [
      {
        store_domain: offer.store_domain,
        source: "private_offer",
        via: "store_rule",
        price_cents: offer.price_cents,
        currency: offer.currency,
        available: true,
        product_url: offer.product_url,
        title: offer.title,
        expires_at: offer.expires_at,
        discount_cap_percent: rule.beat_by_up_to_percent,
        held_based: request.need.holding != null,
        ...(opts.test ? { test: true } : {}),
      },
    ],
    { now, also: [privateOfferStatement(offer)], ...(opts.test ? { agent_class: "test-store" } : {}) },
  );
  return decision;
}
