import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DISCLAIMER } from "../lib/copy.js";
import { HttpError } from "../lib/http.js";
import { defaultDeps, getOffers, postRequest, searchProducts, type Deps } from "../lib/service.js";

const needShape = {
  text: z.string().describe("Free text, for example: women's Brooks Ghost 16, size 8, under $130").optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
  size: z.string().describe("Shoe size such as 8 or 10.5").optional(),
  max_price: z.number().describe("Inclusive maximum price in major units, such as 130").optional(),
  currency: z.string().describe("ISO currency code such as USD, GBP, EUR, CAD, or SGD").optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

export function createHaggleboardServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "haggleboard", version: "0.1.0" },
    {
      instructions: `${DISCLAIMER} Tools: post_request stores a need and returns ranked offers; get_offers ranks offers for a stored request id or a new query; search_products browses the public snapshot. Every offer includes product_url. Checkout is always on that store page. Rankings are not for sale.`,
    },
  );

  server.registerTool(
    "post_request",
    {
      title: "Post a need",
      description:
        "Post a shopping need and get back ranked offers from public listings and any stored store bids. When the need is stored, the response includes delete_token once. Checkout is on the store's own site.",
      inputSchema: needShape,
    },
    async (args) => callTool(() => postRequest(args, deps)),
  );

  server.registerTool(
    "get_offers",
    {
      title: "Get offers",
      description:
        "Rank matching offers. Pass request_id from post_request, or pass the same fields as a new query against the current snapshot.",
      inputSchema: {
        ...needShape,
        request_id: z.string().describe("Id returned by post_request").optional(),
      },
    },
    async (args) => callTool(() => getOffers(args, deps)),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Search the public running-shoe snapshot. Each hit links to the store's own product page.",
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
