import { getStore } from "../../../../lib/db";
import { cardFor } from "../../../../lib/ring/card-data";
import { cardImage } from "../../../../lib/ring/card-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The brag card as a PNG. ?download=1 sends it as a file. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await cardFor(await getStore(), id);
  if (!card) return new Response("No finished practice round with that id.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const download = new URL(req.url).searchParams.has("download") ? `haggleboard-lot-${card.lot}.png` : undefined;
  return cardImage(card, { download });
}
