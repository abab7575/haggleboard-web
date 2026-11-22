# Morning notes: HaggleBoard v1

The server is running on your Mac at http://localhost:4600 (log: `/tmp/haggleboard-4600.log`). Nothing was deployed and main was not touched.

## Click these first

1. http://localhost:4600/ : type something into "What are you looking for?" and press "Start the clock". Try `womens Saucony Endorphin Speed 6 size 8`; three stores have it in the snapshot. You land on your own auction.
2. Your auction page (`/r/...`): the dark arena runs a real two-minute clock. On the right you see "Only you see this": the prices, then at 0:00 the winner and a green "Buy at <store>" button that opens the store's own page.
3. http://localhost:4600/board : every request, live or closed, with the winner. Your local posts carry a "test post" tag.
4. http://localhost:4600/arena/demo : the scripted demo, clearly labelled.
5. http://localhost:4600/agents and http://localhost:4600/stores : the two audience pages.
6. Open http://localhost:4600/find?q=mens+trail+shoes+size+10 : the one-address posting page agents use.

Screenshots of all of these, at phone and desktop size, are in `docs/screens/v1/`.

## Real or demo

Real:
- The auction on `/r/{id}`: real clock, real stores, real public list prices, real winner and band, real buy link.
- The "Real, not demo" strip on the homepage. It counts outside traffic only, so on your Mac it says "No real requests yet. Be the first." Your own posts from localhost never count.
- The board, store pages (`/s/{domain}`) and agent scorecards (`/agents/{handle}`).

Demo (and labelled so):
- The hero auction on the homepage, "Biggest saves today", and everything on `/arena/demo`. Made-up stores, made-up numbers.

Worth knowing: today stores only take part through their public price, so the winner is simply the cheapest public price and the card says "Lowest price ... No store went under it this time." The "X% under" story only becomes real once stores make private offers (store rules, below).

## Switched off, and what each needs

- **Store rules** (private offers from stores): set `STORE_RULES_ENABLED=1` and `BID_KEYS_ENABLED=1`, plus `BID_TOKEN_SIGNING_KEY`. Each store also needs its own key from `npm run issue-key -- --domain <store>`. Until then no store can go under its public price.
- **Store emails** (`NOTIFY_STORES_ENABLED`): turning it on only fills a queue. There is no code that sends anything and no email provider. Needs: a sender, a provider, and your decision on wording.
- **IndexNow** (tells search engines about new request pages): `INDEXNOW_ENABLED=1` and `INDEXNOW_KEY` (8 to 128 letters, digits or dashes). Only for the real public site.
- **Inline watcher** (`WATCHER_INLINE=1`): on for your local server, off by default in production. It reads up to five stores' public feeds right after each post, politely (5+ seconds between requests, robots.txt, 10 fetches max per request). On Vercel you either turn this on or run `npm run watch -- work` on a worker. Without it, only snapshot prices join the auction.
- Production also needs `DATABASE_URL` (Postgres). Without a database nothing is stored and there are no auctions at all; the homepage input then offers a price comparison instead.

## Open questions

1. The snapshot of store prices is from 18 Oct 2026. In my run the live watcher could not find the item at two of the three stores, but their old snapshot price still won. Should old snapshot prices be allowed to win, or only prices read today?
2. README has two License sections (MIT and Apache-2.0). Which one is right?
3. Do you want the board to hide test posts entirely in production, or keep the "test post" tag?
4. Watcher in production: inline on Vercel, or a separate worker?
5. When should store rules go on, and who are the first stores to invite?
