// Deletes stored need text, reports and hashed-IP counters older than 30 days.
// The same purge also runs before every stored need. Schedule this on a worker if traffic is low.
import { openStore } from "../lib/db.js";

const store = await openStore();
await store.purgeExpired();
await store.close();
console.log(`purged records older than 30 days (${store.kind})`);
