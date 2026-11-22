import { AUCTION_DEFAULT_SECONDS, AUCTION_MAX_SECONDS, AUCTION_MIN_SECONDS } from "./auction.js";
import { DISCLAIMER } from "./copy.js";

/**
 * /.well-known/haggleboard: this board's endpoints, following the discovery idea in the HaggleBoard
 * Protocol (github.com/abab7575/haggleboard-spec, SPEC.md). SPEC.md names the path but does not yet
 * define the document's fields, so this shape is ours, and it says plainly which protocol messages
 * this board does and does not implement.
 */
export function discoveryDocument(site: string) {
  const base = site.replace(/\/$/, "");
  return {
    name: "HaggleBoard",
    url: base,
    protocol: {
      name: "HaggleBoard Protocol",
      spec: "https://github.com/abab7575/haggleboard-spec/blob/main/SPEC.md",
      version: "0.1",
      document_fields: "SPEC.md does not define this document's fields yet; this shape is this board's own.",
    },
    role: "relay",
    money: "HaggleBoard never takes payment, holds funds or places orders. Checkout is on the store's own site.",
    messages: {
      request: {
        implemented: "partly",
        note: "Agents post a need as plain JSON (POST /api/requests, MCP post_request, or GET /find). It is not wrapped in an HBP envelope and is not signed.",
      },
      offer: {
        implemented: "partly",
        note: "Public prices are plain offers. Private offers made under a claimed store's rule carry an HBP-shaped offer object, unsigned (signature null), with terms.category \"retail\", which HBP v0.1 does not define. Store rules are off by default.",
      },
      counter: { implemented: false },
      accept: { implemented: false, note: "No deal token is issued. The buyer checks out on the store's site." },
      decline: { implemented: false },
      expire: {
        implemented: "partly",
        note: `Each request has a window (${AUCTION_MIN_SECONDS} to ${AUCTION_MAX_SECONDS} seconds, default ${AUCTION_DEFAULT_SECONDS}); its close is recorded as an auction.closed event, not as an HBP expire message.`,
      },
      signatures: { implemented: false, note: "No message is signed or verified. A Signature-Agent header is recorded but not verified." },
    },
    endpoints: {
      mcp: `${base}/api/mcp`,
      post_request: { method: "POST", url: `${base}/api/requests` },
      one_address: { method: "GET", url: `${base}/find?q={what}`, json: `${base}/find.json?q={what}` },
      offers: { method: "GET", url: `${base}/api/requests/{id}/offers` },
      result: { method: "GET", url: `${base}/api/requests/{id}/result`, auth: "X-HaggleBoard-Delete-Token" },
      outcome: { method: "POST", url: `${base}/api/requests/{id}/outcome`, auth: "X-HaggleBoard-Delete-Token" },
      public_stream: { method: "GET", url: `${base}/api/requests/{id}/stream`, format: "text/event-stream" },
      public_events: { method: "GET", url: `${base}/api/requests/{id}/events` },
      board: `${base}/board.json`,
      stats: `${base}/api/stats`,
      store_bids: { method: "POST", url: `${base}/api/offers`, auth: "X-HaggleBoard-Store-Key", note: "Off unless enabled." },
      store_rule: { method: "POST", url: `${base}/api/stores/rule`, auth: "X-HaggleBoard-Store-Key", note: "Off unless enabled." },
      skill: `${base}/skill.md`,
      llms_txt: `${base}/llms.txt`,
      sitemap: `${base}/sitemap.xml`,
    },
    rankings: "In stock, then currency, then lowest price. Rankings are not for sale.",
    disclaimer: DISCLAIMER,
  };
}
