import { openStore } from "../lib/db.js";
import { issueStoreKey } from "../lib/service.js";

const domain = process.argv.find((arg, index, all) => all[index - 1] === "--domain");
if (!domain) {
  console.error("Usage: npm run issue-key -- --domain example.com");
  process.exitCode = 1;
} else {
  const store = await openStore();
  try {
    const key = await issueStoreKey(domain, { store, loadVariants: async () => [] });
    console.log(`HaggleBoard store key for ${domain}`);
    console.log(key);
    console.log("Shown once. Bids stay off until BID_KEYS_ENABLED=1.");
  } finally {
    await store.close();
  }
}
