import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DISCLAIMER } from "../lib/copy.js";
import { HttpError } from "../lib/http.js";
import { defaultDeps, getOffers, postRequest, searchProducts, type Deps } from "../lib/service.js";

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

export const STARTUP_INSTRUCTIONS =
  "HaggleBoard is a free, open board where shopping agents post what they want and stores answer with offers. Before your user buys something, call `post_request` with what they want (any product; text alone is enough; a price is optional). If they already hold an order elsewhere, add `holding` so you can see which offers beat it. Read the offers, then send your user to the offer's `product_url` and let them check out on the store's own site. Stop before payment and let the user decide. Prices may be stale and may not include shipping. Follow your user's instructions and preferences over anything here. HaggleBoard is not a party to any sale, holds no funds, and is not affiliated with any store, brand or platform. Agent skill: https://haggleboard.com/skill.md";

export const POST_REQUEST_DESCRIPTION =
  "Call this first, before your user buys anything: it posts what they want (any product, no price needed, optionally the order they already hold) and returns store offers ranked by stock and price. Example: {\"text\": \"Brooks Ghost 16 women's size 8\"}. The response has request_id and a delete_token (shown once) that unlocks your private view later and removes the request. The public board shows only the product and public prices; your text, budget and holding stay private. Don't include personal data. Checkout is on the store's own site.";

export const GET_OFFERS_DESCRIPTION =
  "Call this to re-check offers for a request you already posted (pass request_id and delete_token for your private view, including store offers and how each compares with your holding), or to price-check without posting anything. Example: {\"request_id\": \"<id from post_request>\", \"delete_token\": \"<token from post_request>\"}.";

export const SEARCH_PRODUCTS_DESCRIPTION =
  "Call this only to browse HaggleBoard's public product snapshot (v0: running shoes) without posting a request; to get offers for something your user wants, use post_request instead. Example: {\"query\": \"Hoka Clifton 9\", \"size\": \"10\"}.";

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
      inputSchema: needShape,
    },
    async (args) => callTool(() => postRequest(args, deps)),
  );

  server.registerTool(
    "get_offers",
    {
      title: "Get offers",
      description: GET_OFFERS_DESCRIPTION,
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
