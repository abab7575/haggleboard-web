import { emptyOptions, errorResponse, json } from "../../../lib/http";
import { defaultDeps, searchProducts } from "../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const number = (key: string) => {
      const raw = url.searchParams.get(key);
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const result = await searchProducts(
      {
        query: url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined,
        brand: url.searchParams.get("brand") ?? undefined,
        model: url.searchParams.get("model") ?? undefined,
        gender: url.searchParams.get("gender") ?? undefined,
        size: url.searchParams.get("size") ?? undefined,
        limit: number("limit"),
      },
      await defaultDeps(),
    );
    return json(result, 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
