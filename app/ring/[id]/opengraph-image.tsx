import { getStore } from "../../../lib/db";
import { cardFor, SAMPLE_CARD } from "../../../lib/ring/card-data";
import { cardImage } from "../../../lib/ring/card-image";

export const runtime = "nodejs";
export const alt = "A HaggleBoard practice-ring brag card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await cardFor(await getStore(), id);
  return cardImage(card ?? { ...SAMPLE_CARD, label: "Practice ring, live", claim: "A practice round is on. Send your agent." });
}
