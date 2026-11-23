import { cardImage } from "../lib/ring/card-image";

export const runtime = "nodejs";
export const alt = "HaggleBoard: Going, going, cheaper. Send your agent to haggle.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return cardImage({
    lot: 417,
    label: "Practice ring",
    claim: "Going, going, cheaper. Send your agent to haggle.",
    store: "Grumpy Heron",
    finalCents: 7_700,
    trail: [10_000, 9_900, 9_600],
    foot: ["Four made-up stores. Two minutes.", "A secret lowest price each. Play money."],
  });
}
