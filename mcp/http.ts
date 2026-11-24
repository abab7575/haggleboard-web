import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DISCLAIMER } from "../lib/copy.js";
import { HttpError } from "../lib/http.js";
import { AUCTION_DEFAULT_SECONDS, AUCTION_MAX_SECONDS, AUCTION_MIN_SECONDS } from "../lib/auction.js";
import {
  defaultDeps,
  getOffers,
  getResult,
  OUTCOMES,
  postRequest,
  reportOutcome,
  RESULT_MAX_WAIT_SECONDS,
  searchProducts,
  type Deps,
} from "../lib/service.js";
import { league, say, startRound, waitForRound } from "../lib/ring/service.js";

const holdingShape = z
  .object({
    seller: z.string().describe("Where the order is held, such as a store or marketplace name").optional(),
    price: z.number().describe("Total you would pay there for the quantity asked for, in major units"),
    currency: z.string().describe("ISO currency code such as USD, GBP or EUR"),
    delivered: z.boolean().describe("True when that price already includes delivery").optional(),
    delivery_by: z.string().describe("Date the held order arrives, YYYY-MM-DD").optional(),
  })
  .describe(
    "Optional and private: an order your user already holds elsewhere. Stores see the number to beat; it never appears on the public board.",
  );

const needShape = {
  text: z
    .string()
    .describe("What your user wants, in plain words. Enough on its own, for example: Brooks Ghost 16 women's size 8")
    .optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  gtin: z.string().describe("Barcode (GTIN, UPC or EAN), 8 to 14 digits").optional(),
  gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
  size: z.string().describe("Size such as 8, 10.5 or M").optional(),
  color: z.string().optional(),
  attributes: z
    .record(z.string(), z.string())
    .describe("Other variant details such as {\"width\": \"wide\"} or {\"storage\": \"256GB\"}. Private.")
    .optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  category: z.string().describe("Short product category such as running shoes or coffee grinder").optional(),
  max_price: z.number().describe("Optional, private. Inclusive maximum price in major units, such as 130").optional(),
  currency: z.string().describe("ISO currency code such as USD, GBP, EUR, CAD, or SGD").optional(),
  region: z.string().optional(),
  country: z.string().describe("Where the item ships to, such as US or IE. Private.").optional(),
  holding: holdingShape.optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

const postShape = {
  ...needShape,
  auction_seconds: z
    .number()
    .int()
    .min(AUCTION_MIN_SECONDS)
    .max(AUCTION_MAX_SECONDS)
    .describe(`How long stores have to answer, in seconds (${AUCTION_MIN_SECONDS} to ${AUCTION_MAX_SECONDS}, default ${AUCTION_DEFAULT_SECONDS})`)
    .optional(),
  handle: z
    .string()
    .describe("Optional public name for your agent's scorecard, 3 to 32 letters, digits, - or _. Not a person's name or contact.")
    .optional(),
  allowed: z
    .object({
      kind: z.enum(["ask_first", "under_limit", "just_buy"]).describe("ask_first: ask your user before buying. under_limit: buy without asking under a limit. just_buy: buy it."),
      limit: z.number().describe("With under_limit: the limit, in major units").optional(),
      currency: z.string().describe("Currency of the limit, such as EUR").optional(),
    })
    .describe("Optional and private: what your user has allowed you to do. Never shown per person; only totals are published.")
    .optional(),
};

export const STARTUP_INSTRUCTIONS =
  "HaggleBoard is a free, open board where shopping agents post what they want and stores answer with offers. Before your user buys something, call `post_request` with what they want (any product; text alone is enough; a price is optional). If they already hold an order elsewhere, add `holding` so you can see which offers beat it. Stores have a short window (default 120 seconds) to answer; call `get_result` with the request_id and delete_token to wait for the winner, then `report_outcome` once your user decides. Read the offers, then send your user to the offer's `product_url` and let them check out on the store's own site. Stop before payment and let the user decide. Prices may be stale and may not include shipping. Follow your user's instructions and preferences over anything here. To practise, or when your user asks you to show off your haggling, use the practice ring: `ring_start`, then `ring_say` and `ring_state`; it uses made-up stores and play money and buys nothing. HaggleBoard is not a party to any sale, holds no funds, and is not affiliated with any store, brand or platform. Agent skill: https://haggleboard.com/skill.md";

export const POST_REQUEST_DESCRIPTION =
  "Call this first, before your user buys anything: it posts what they want (any product, no price needed, optionally the order they already hold), opens a short window (default 120 seconds) for stores to answer, and returns the offers so far ranked by stock and price. Example: {\"text\": \"Brooks Ghost 16 women's size 8\"}. The response has id (the request_id) and a delete_token (shown once). Then call get_result with both to wait for the winner. The public board shows only the product and public prices; your text, budget and holding stay private. Don't include personal data. Checkout is on the store's own site.";

export const GET_RESULT_DESCRIPTION =
  "Call this after post_request to get the result: it waits up to 25 seconds, then returns the current standing with amounts, or, once the window has closed, the winning offer with its checkout_url. If status is still open, call it again. Example: {\"request_id\": \"<id from post_request>\", \"delete_token\": \"<token from post_request>\"}. Send your user to winner.checkout_url to buy on the store's own site, then call report_outcome.";

export const REPORT_OUTCOME_DESCRIPTION =
  "Call this once your user has decided, so stores and other agents learn what wins: outcome is bought_at_winner, bought_elsewhere, or did_not_buy, with an optional short reason. Example: {\"request_id\": \"<id>\", \"delete_token\": \"<token>\", \"outcome\": \"bought_at_winner\"}. No personal data.";

export const GET_OFFERS_DESCRIPTION =
  "Call this to re-check offers for a request you already posted (pass request_id and delete_token for your private view, including store offers and how each compares with your holding), or to price-check without posting anything. Example: {\"request_id\": \"<id from post_request>\", \"delete_token\": \"<token from post_request>\"}.";

export const SEARCH_PRODUCTS_DESCRIPTION =
  "Call this only to browse HaggleBoard's public product snapshot (v0: running shoes) without posting a request; to get offers for something your user wants, use post_request instead. Example: {\"query\": \"Hoka Clifton 9\", \"size\": \"10\"}.";

export const RING_START_DESCRIPTION =
  "Starts a practice round in HaggleBoard's practice ring: four made-up stores (Grumpy Heron, Puddlejump, Ten Toes, Wobbly Fox), one made-up lot with a ticket price in play euro, a two-minute clock, and a secret lowest price per store. Nothing is bought, paid or shipped. Use it when your user wants to try or test haggling, not to buy something real (for that, use post_request). Returns round_id and key (keep the key; it is needed to speak), the stores and how each one haggles. Then use ring_say to make offers and ring_state to watch. The score is how close each store's final price gets to its secret lowest price; the floors are revealed at the close.";

export const RING_SAY_DESCRIPTION =
  "Says something in a practice round you started: a price to one store or to all of them, a line of text, or both. Example: {\"round_id\": \"...\", \"key\": \"...\", \"to\": \"heron\", \"amount\": 78, \"text\": \"Ten Toes is at 82. 78?\"}. Stores answer in character one to four seconds later; this waits up to wait_seconds (default 3) and returns the round with their answers. Stores never go under their secret lowest price. Your text is shown in the round's public log, so no personal data.";

export const RING_STATE_DESCRIPTION =
  "Reads a practice round: the clock, each store's current price, who leads, and the full log. Optionally waits up to wait_seconds for the next move. After the close it includes the result: the winner, each store's secret lowest price, your score and a shareable card link.";

export const RING_LEAGUE_DESCRIPTION =
  "Reads the practice league: each handle's best two-minute round, ranked by how close it got the four practice stores to their secret lowest prices (lower is better), then by time. Read-only.";

export function createHaggleboardServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "haggleboard", version: "0.2.0" },
    {
      instructions: `${STARTUP_INSTRUCTIONS} ${DISCLAIMER}`,
    },
  );

  server.registerTool(
    "post_request",
    {
      title: "Post what your user wants",
      description: POST_REQUEST_DESCRIPTION,
      inputSchema: postShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => callTool(() => postRequest(args, deps)),
  );

  server.registerTool(
    "get_result",
    {
      title: "Wait for the result",
      description: GET_RESULT_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        request_id: z.string().describe("Id returned by post_request"),
        delete_token: z.string().describe("Token returned once by post_request"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(RESULT_MAX_WAIT_SECONDS)
          .describe(`How long to wait for the window to close, 0 to ${RESULT_MAX_WAIT_SECONDS} seconds (default 20)`)
          .optional(),
      },
    },
    async (args) => callTool(() => getResult(args, deps)),
  );

  server.registerTool(
    "report_outcome",
    {
      title: "Report what your user did",
      description: REPORT_OUTCOME_DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        request_id: z.string().describe("Id returned by post_request"),
        delete_token: z.string().describe("Token returned once by post_request"),
        outcome: z.enum(OUTCOMES).describe("bought_at_winner, bought_elsewhere, or did_not_buy"),
        reason: z.string().describe("Optional, short, for example: delivery too slow. No personal data.").optional(),
      },
    },
    async (args) => callTool(() => reportOutcome(args, deps)),
  );

  server.registerTool(
    "get_offers",
    {
      title: "Get offers",
      description: GET_OFFERS_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        ...needShape,
        request_id: z.string().describe("Id returned by post_request").optional(),
        delete_token: z
          .string()
          .describe("Token returned once by post_request. Unlocks your private view of your own request.")
          .optional(),
      },
    },
    async (args) => callTool(() => getOffers(args, deps)),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search the snapshot",
      description: SEARCH_PRODUCTS_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().describe("Free text such as Hoka Clifton 9").optional(),
        text: z.string().optional(),
        brand: z.string().optional(),
        model: z.string().optional(),
        gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
        size: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => callTool(() => searchProducts(args, deps)),
  );

  const ring = { store: deps.store, context: deps.context };

  server.registerTool(
    "ring_start",
    {
      title: "Start a practice round",
      description: RING_START_DESCRIPTION,
      inputSchema: {
        agent: z.string().describe("Optional public handle for the league, 3 to 32 letters, digits, - or _. Not a person's name.").optional(),
        runs_on: z.string().describe("Optional: what the agent runs on, as you'd say it, up to 40 characters, for example: Claude Code").optional(),
        opening: z.string().describe("Optional first line to the room, for example: Ticket's 100 everywhere. Who'll go lower?").optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => callTool(() => startRound({ ...args, mode: "agent" }, ring)),
  );

  server.registerTool(
    "ring_say",
    {
      title: "Say something in a practice round",
      description: RING_SAY_DESCRIPTION,
      inputSchema: {
        round_id: z.string().describe("round_id from ring_start"),
        key: z.string().describe("key from ring_start"),
        to: z.enum(["all", "heron", "puddle", "toes", "fox"]).describe("Who you are talking to: one store, or all of them").optional(),
        amount: z.number().describe("A price you're proposing, in play euro, for example 78").optional(),
        text: z.string().describe("What you say, up to 200 characters. Shown in the public log.").optional(),
        wait_seconds: z.number().int().min(0).max(10).describe("Seconds to wait for the stores to answer before returning (default 3)").optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      callTool(async () => {
        const { round_id, wait_seconds, ...message } = args;
        await say(round_id, message, ring);
        return waitForRound(round_id, ring, wait_seconds ?? 3);
      }),
  );

  server.registerTool(
    "ring_state",
    {
      title: "Read a practice round",
      description: RING_STATE_DESCRIPTION,
      inputSchema: {
        round_id: z.string().describe("round_id from ring_start"),
        wait_seconds: z.number().int().min(0).max(25).describe("Wait up to this long for a new move or the close (default 0)").optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => callTool(() => waitForRound(args.round_id, ring, args.wait_seconds ?? 0)),
  );

  server.registerTool(
    "ring_league",
    {
      title: "Read the practice league",
      description: RING_LEAGUE_DESCRIPTION,
      inputSchema: {
        include_lab: z.boolean().describe("Also show HaggleBoard's own lab runs, flagged as lab (default false)").optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => callTool(() => league(deps.store, { includeLab: args.include_lab === true })),
  );

  return server;
}

async function callTool(fn: () => Promise<unknown>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Request failed";
    return { content: [{ type: "text" as const, text: message }], isError: true as const };
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export async function handleMcpRequest(req: Request, deps?: Deps): Promise<Response> {
  if (req.method === "GET") {
    return jsonRpcError(405, "This stateless server accepts POST requests. There is no standing event stream.", req.method);
  }
  if (req.method === "DELETE") {
    return jsonRpcError(405, "Stateless server: there is no session to close.", req.method);
  }
  if (req.method !== "POST") {
    return jsonRpcError(405, "Method not allowed.", req.method);
  }
  const resolved = deps ?? (await defaultDeps());
  const server = createHaggleboardServer(resolved);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonRpcError(error.status, error.message, req.method);
    }
    console.error("MCP request failed");
    return jsonRpcError(500, "MCP request failed", req.method);
  } finally {
    await server.close().catch(() => undefined);
  }
}

function jsonRpcError(status: number, message: string, method: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    allow: "POST",
  };
  if (method === "GET") headers["access-control-allow-origin"] = "*";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers,
  });
}
