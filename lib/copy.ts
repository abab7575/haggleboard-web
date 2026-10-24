export const PUBLIC_NAME = "HaggleBoard";
export const SITE_URL = "https://haggleboard.com";

/** Sent on every crawl request. The product token stays HaggleBoard-bot. */
export const USER_AGENT =
  "HaggleBoard-bot/0.1 (+https://haggleboard.com/bot; contact@haggleboard.com)";

export const REMOVAL_EMAIL = "contact@haggleboard.com";

export const DISCLAIMER =
  "HaggleBoard is a free, independent board. It does not sell products, hold funds, charge fees, or take a commission. It is not affiliated with any store or brand. Checkout always happens on the store's own website.";

export const PRICE_NOTE = "Prices may be out of date; the store's page is authoritative.";

/** The bundled public snapshot (fixtures/sample-crawl.json, crawled_at 2026-10-18). */
export const SNAPSHOT_NOTE = "Listings come from a public snapshot taken on 18 Oct 2026.";

export const REMOVAL_LINE = `Store owner? Ask us to remove your listings: ${REMOVAL_EMAIL}`;
