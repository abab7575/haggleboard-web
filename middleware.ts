import { NextResponse, type NextRequest } from "next/server";

/**
 * /ring is the page people play on. /ring?q=... (start a round) and /ring?round=... (talk in or read
 * one) are the one-address form for agents that can only open a web page: they go to a plain
 * handler that answers with HTML, or JSON on Accept: application/json.
 */
export function middleware(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.has("q") || params.has("round")) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/ring/play";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/ring"] };
