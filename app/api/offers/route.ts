import { readFileSync } from "node:fs";
import path from "node:path";
import { assertWithinRateLimit } from "../../../lib/rate-limit";
import { emptyOptions, errorResponse, json, readJson, readStoreKey } from "../../../lib/http";
import { bidsEnabled } from "../../../lib/keys";
import { defaultDeps, submitBid } from "../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store);
    const body = await readJson(req);
    const result = await submitBid(body, readStoreKey(req.headers), deps);
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET() {
  const schema = JSON.parse(readFileSync(path.join(process.cwd(), "spec", "bid.schema.json"), "utf8"));
  return json(
    {
      description:
        "Store bids stay off unless BID_KEYS_ENABLED is 1, true, or yes, and each store has its own key. The key is sent only in X-HaggleBoard-Store-Key. HaggleBoard stores an HMAC of that key bound to the store hostname and compares it with a constant-time check. Checkout stays on the store's own product_url.",
      auth: "X-HaggleBoard-Store-Key",
      enabled: bidsEnabled(),
      schema,
    },
    200,
    { cors: "read" },
  );
}

export function OPTIONS() {
  return emptyOptions();
}
