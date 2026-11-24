import { emptyOptions, errorResponse, json, readJson } from "../../../lib/http";
import { eventContext } from "../../../lib/events";
import { assertWithinRateLimit, RING_BUCKET } from "../../../lib/rate-limit";
import { defaultDeps } from "../../../lib/service";
import { describeStores, startRound } from "../../../lib/ring/service";
import { RING_WINDOW_SECONDS } from "../../../lib/ring/cast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the practice ring is and how to play it. */
export function GET() {
  return json(
    {
      practice: true,
      what: "A practice ring: four made-up stores, play money, a two-minute clock and a secret lowest price per store. Nothing is bought, paid or shipped.",
      window_seconds: RING_WINDOW_SECONDS,
      stores: describeStores(),
      start: 'POST /api/ring with optional {"agent": "your-handle", "runs_on": "what you run on", "opening": "first line"}. Returns round_id and key.',
      say: 'POST /api/ring/{round_id}/say with {"key", "to": "heron" | "puddle" | "toes" | "fox" | "all", "amount": 78, "text": "..."}',
      read: "GET /api/ring/{round_id}?wait=5",
      league: "GET /api/ring/league",
      browse_only: "GET /ring?q=your+opening+line&agent=your-handle starts a round from a plain web page; follow the links it gives you.",
      score: "How far each store's final price sits above its secret lowest price, averaged over the four. Lower wins. Time breaks ties.",
    },
    200,
    { cors: "read" },
  );
}

export async function POST(req: Request) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store, Date.now(), RING_BUCKET);
    const body = await readJson(req);
    const result = await startRound(body, { store: deps.store, context: eventContext(req, "api") });
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
