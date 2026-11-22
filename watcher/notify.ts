import { loadRemoved } from "../feeds/seeds.js";
import type { RequestOrigin, Store } from "../lib/db.js";
import { eventStatement, requestIsInternal } from "../lib/events.js";
import { notifyStoresEnabled } from "./constants.js";
import { storeHasClaimed } from "./store-rules.js";

/**
 * NOTIFY-STORE HOOK. Shipped OFF (NOTIFY_STORES_ENABLED), and there is NO sending code anywhere:
 * no email provider, no key, no outbound message. When the flag is on, the watcher only writes a
 * queue row. Turning sending on later means adding a sender that reads this table.
 *
 * Rules:
 *  - only for a real outside request (origin "outside"; see lib/origin.ts for "test" and "internal");
 *  - only for a store whose public feed carried the product;
 *  - never for a store that has claimed its listing (it holds a store key);
 *  - never for a store on the removal list;
 *  - at most one row per store, ever (store_domain is the primary key). A store that claims its
 *    listing stops getting queued at all.
 *  - the row records which request triggered it. It holds no shopper data.
 */
export type NotificationDecision = { store_domain: string; queued: boolean; reason: string };

export async function queueStoreNotifications(
  store: Store,
  input: { requestId: string; origin: RequestOrigin; storesCarrying: string[] },
  env: NodeJS.ProcessEnv = process.env,
  removed: Set<string> = loadRemoved(),
): Promise<NotificationDecision[]> {
  if (!notifyStoresEnabled(env)) {
    return input.storesCarrying.map((domain) => ({ store_domain: domain, queued: false, reason: "notifications are off" }));
  }
  if (input.origin !== "outside") {
    return input.storesCarrying.map((domain) => ({ store_domain: domain, queued: false, reason: `request origin is ${input.origin}` }));
  }
  if (await requestIsInternal(store, input.requestId, false)) {
    return input.storesCarrying.map((domain) => ({ store_domain: domain, queued: false, reason: "request is marked internal" }));
  }
  const out: NotificationDecision[] = [];
  for (const raw of [...new Set(input.storesCarrying.map((d) => d.toLowerCase()))]) {
    if (removed.has(raw)) {
      out.push({ store_domain: raw, queued: false, reason: "store is on the removal list" });
      continue;
    }
    if (await storeHasClaimed(store, raw)) {
      out.push({ store_domain: raw, queued: false, reason: "store has claimed its listing" });
      continue;
    }
    const existing = await store.select("SELECT 1 AS n FROM store_notifications WHERE store_domain = ?", [raw]);
    if (existing.length > 0) {
      out.push({ store_domain: raw, queued: false, reason: "already queued once" });
      continue;
    }
    // The queue row and store.notified in one transaction. Nothing is sent.
    await store.batch([
      [
        `INSERT INTO store_notifications (store_domain, request_id, status, created_at) VALUES (?, ?, 'queued', ?)
       ON CONFLICT(store_domain) DO NOTHING`,
        [raw, input.requestId, new Date().toISOString()],
      ],
      eventStatement(
        {
          id: `${raw}:store.notified`,
          type: "store.notified",
          request_id: input.requestId,
          store_domain: raw,
          internal: false,
          public: { status: "queued", sent: false },
        },
        null,
      ),
    ]);
    out.push({ store_domain: raw, queued: true, reason: "queued" });
  }
  return out;
}

export async function listStoreNotifications(store: Store) {
  return (await store.select("SELECT store_domain, request_id, status, created_at FROM store_notifications ORDER BY created_at ASC")).map(
    (row) => ({
      store_domain: String(row.store_domain),
      request_id: String(row.request_id),
      status: String(row.status),
      created_at: String(row.created_at),
    }),
  );
}
