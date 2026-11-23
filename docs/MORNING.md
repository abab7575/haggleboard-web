# Morning notes: HaggleBoard v1 fixes

The server on your Mac at http://localhost:4600 now runs the `v1-fixes` branch (log: `/tmp/haggleboard-4600.log`), with test stores switched on. Nothing was deployed and main was not touched. The pull request is `v1-fixes` into `integration`.

## Click these first

1. http://localhost:4600/ : type `womens Saucony Endorphin Speed 6 size 8` into "What are you looking for?" and press "Start the clock". You land on your own auction.
2. Watch the two minutes. Three made-up stores (yellow "Test stores" label) join at different times and undercut each other through the real engine. The last lead change comes in the final seconds. On the right, "Only you see this" shows every amount.
3. At 0:00 the result card lands, with the price date of the winner.
4. Scroll under the arena: "Reading the board" explains confirmed today, last seen, no longer listed and private offer.
5. http://localhost:4600/board and http://localhost:4600/arena/demo are unchanged.

Screenshots of a full fight (mid-fight, final seconds, close; desktop 1440x900 and phone 390x844) are in `docs/screens/v1-fight/`.

## How to watch a real fight locally

Start the server with `TEST_STORES=1` (plus `WATCHER_INLINE=1`, `DATABASE_URL=file:./data/local.sqlite`, `DELETE_TOKEN_KEY`). Every new request then gets three fictional claimed stores:

| Store (made up, `.example` domain) | Rule |
| --- | --- |
| Quillfeather Running, `quillfeather-running.example` | fast: answers in seconds and checks often, up to 9% off its list price, private floor at 90% |
| Bramblewick Outfitters, `bramblewick-outfitters.example` | steady: joins a third of the way in, checks twice more, up to 12% off, floor at 87% |
| Tollgate Shoe Co., `tollgate-shoe-co.example` | late: only joins in the last part of the clock, up to 16% off, floor at 84% |

They answer through the same code a claimed store's standing rule uses (`watcher/respond.ts` calls the store rules engine, writes private offers and lead changes, and the auction closes the normal way). A 30-second auction works too: `POST /api/requests` with `{"text": "...", "auction_seconds": 30}`.

The flag is off by default and refused when `HB_PUBLIC=1` or `VERCEL_ENV=production`, so it cannot run on the public site by mistake.

## Real, test, demo

Real:
- The clock, the snapshot and live public prices, the watcher's reads, the event log, and the result rules on `/r/{id}`.
- Every public price now shows its date. A price we read during the auction says "confirmed today". A snapshot price says "last seen 18 Oct, not confirmed" and cannot win while a confirmed price exists. If a live read finds the item gone at a store, that store's old price is struck out as "no longer listed".
- When only old prices exist the result says "Best last-seen price, not confirmed today", never "Won".

Test (only with `TEST_STORES=1`, only on your Mac):
- The three stores above and everything they do. Their prices are invented from the auction's best public price. Every event they cause is marked `test` and `internal`, so it never reaches stats, the sitemap, JSON-LD, store pages or store emails, and the request page is `noindex`. The arena, the lanes and the result card all say "Test stores" / "test store".

Demo (labelled):
- The homepage hero auction, "Biggest saves today" and `/arena/demo`. Made-up stores, made-up numbers.

## Finding the product: what ARC and the stores really offer, and the hit rate

What I found tonight (live, polite, with the HaggleBoard bot user agent):
- ARC's `find_stores` (MCP at `/api/ask`) only takes a category or shopper words. A product name such as "Saucony Endorphin Speed 6" gets `bad_request`, which is why the old watcher got no ARC stores at all. For "running shoes" it returns general footwear brands with a saved checkout (none of them sell the running brands we were asked for).
- ARC's precheck (`POST /api/precheck/bulk`, `GET /api/precheck?url=`) lists per store the routes an agent can use: `ucp_mcp` with endpoint `/api/ucp/mcp` and `catalog_tool: search_catalog`, `storefront_mcp`, `ucp`, `cart_link`. The 48 seed running shops are unknown to ARC. hoka.com, saucony.com, nike.com, brooksrunning.com, newbalance.com have no working agent route on ARC's record, so the brand's own site still cannot be asked.
- A store's UCP catalog search really works: `tools/call search_catalog` with `{meta: {"ucp-agent": {profile}}, catalog: {query, pagination, context}}` returns products with variants, prices in minor units, sizes and availability, in the store's own currency. The older storefront MCP at `/api/mcp` now only offers a policies tool. HaggleBoard has no UCP agent profile of its own yet, so it sends Shopify's public example profile (`UCP_AGENT_PROFILE_URL` overrides it once haggleboard.com serves one).

Hit rate on 10 fixed products (all internal posts; `scripts/hit-rate.ts`):

| Run | Products found at one store or more | Stores asked | Asks that found it |
| --- | --- | --- | --- |
| Before (old watcher) | 1 of 10 | 8 | 1 (12.5%) |
| After, first pass (new watcher, empty learned index) | 2 of 10 | 47 | 2 (4.3%) |
| After, second pass (learned index from the first pass, cache only) | 2 of 10 | 16 | 2 (12.5%) |

Honest reading: one more product found (the brand store's own catalog search found its shoe; that answer was replayed from the one live search I had already made, to stay within the per-store limit). Most running brands are still not findable: their own sites publish no working agent route, and the seed shops' first feed page is a lottery. The first pass wasted many asks on footwear stores from ARC that do not carry running brands; the learned index and the new cap (2 untried category stores per request, stores with 3 misses and no hit are dropped) cut that from 47 asks to 16 on the second pass.

## Switched off, and what each needs

- **Store rules** (private offers from claimed stores): `STORE_RULES_ENABLED=1`, `BID_KEYS_ENABLED=1`, `BID_TOKEN_SIGNING_KEY`, and a key per store from `npm run issue-key`. A claimed store's rule now also answers requests with no held order, by going under the current leader (never below its floor).
- **Store emails** (`NOTIFY_STORES_ENABLED`): fills a queue only. No sending code, no provider.
- **IndexNow**: `INDEXNOW_ENABLED=1` and `INDEXNOW_KEY`, public site only.
- **Inline watcher** (`WATCHER_INLINE=1`): on for your local server.
- **Test stores** (`TEST_STORES=1`): local only, see above.

## Open questions

1. The README has two License sections: "Code is MIT. The files in `spec/` are CC-BY-4.0." and "Code and schemas: Apache-2.0. Spec text: CC-BY-4.0." (`package.json` says Apache-2.0). Which one is right? I left both as they are.
2. Private-offer bands are now often withheld ("private offer", no band), on purpose: with fewer than two public prices, or when the store's own public price sits close to the best one, any band would hint at what the shopper holds. Fine to keep it this strict?
3. Should HaggleBoard publish its own UCP agent profile at `haggleboard.com/.well-known/ucp` before launch, instead of sending Shopify's example profile?
4. Do you want the board to hide test posts entirely in production, or keep the "test post" tag?
5. Watcher in production: inline on Vercel, or a separate worker?
6. `npm test` ends with the secret scan, which flags your first name in `docs/DATA.md` and `docs/MARKETING.md` (both came in with the integration merge, before this branch). All 174 unit tests pass; the scan step still exits 1. Reword those docs, or relax the name rule for `docs/`?
