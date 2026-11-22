import { emptyOptions, errorResponse, json, readJson, readStoreKey } from "../../../../lib/http";
import { assertWithinRateLimit } from "../../../../lib/rate-limit";
import { defaultDeps } from "../../../../lib/service";
import { bidsEnabled } from "../../../../lib/keys";
import { storeRulesEnabled } from "../../../../watcher/constants";
import { saveStoreRule } from "../../../../watcher/store-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The shape of a store's standing rule. Off unless STORE_RULES_ENABLED and BID_KEYS_ENABLED are set. */
export function GET() {
  return json(
    {
      enabled: storeRulesEnabled() && bidsEnabled(),
      note: "Off by default. A claimed store (one with a store key) sets one standing rule. The floor is private: it is never returned or shown.",
      shape: {
        store_domain: "<your hostname>",
        rule: {
          beat_by_up_to_percent: "<0 to 50: how far below your public price you will go to beat a held order>",
          floor: { price: "<your private lowest price>", currency: "<ISO code>" },
          eligible: { all: "<true for every product>", brands: ["<brand>"], product_urls: ["<https link on your site>"] },
          offer_ttl_minutes: "<1 to 1440, default 60>",
        },
      },
      auth: "Send the store key in X-HaggleBoard-Store-Key.",
    },
    200,
    { cors: "read" },
  );
}

export async function POST(req: Request) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store);
    const result = await saveStoreRule(await readJson(req), readStoreKey(req.headers), deps.store);
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
