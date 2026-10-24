# Store offer stub

v0 does not ship a Shopify app or a store dashboard. A store, or a later app, submits an offer with `POST /api/offers`.

Send `X-HaggleBoard-Store-Key` (or `Authorization: Bearer`). v0 only checks that the key is present and stores a hash. Signed tokens come later. The key is never written back.

The body matches `spec/bid.schema.json`. `product_url` must be `https` on `store_domain`. That page is where the shopper checks out. HaggleBoard does not take payment and is not a party to the sale.

`GET /api/offers` returns the schema. It does not list stored bids.

A bid with `request_id` is attached to that posted need. A bid without `request_id` is a standing offer and is ranked with public listings when the brand, model, size, and price match.
