export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}

export type CorsMode = "read" | "none";

const READ_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};

export function json(
  data: unknown,
  status = 200,
  options: { cors?: CorsMode; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(options.cors === "read" ? READ_CORS : {}),
    ...options.headers,
  };
  return new Response(JSON.stringify(data), { status, headers });
}

export function emptyOptions(cors: CorsMode = "none"): Response {
  const headers: Record<string, string> = cors === "read" ? { ...READ_CORS } : { allow: "GET, POST, OPTIONS" };
  return new Response(null, { status: 204, headers });
}

export function errorResponse(error: unknown, cors: CorsMode = "none"): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status, { cors, headers: error.headers });
  }
  console.error("request failed");
  return json({ error: "Something went wrong" }, 500, { cors });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

export function readStoreKey(headers: Headers): string | null {
  const named = headers.get("x-haggleboard-store-key")?.trim();
  return named || null;
}
