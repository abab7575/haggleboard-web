import type { Store } from "../db.js";
import { HttpError } from "../http.js";
import { siteUrl } from "../site.js";
import type { CardInput } from "./card-image.js";
import { roundState } from "./service.js";

/** What goes on a finished round's card. Null when the round is not found or not finished. */
export async function cardFor(store: Store, id: string): Promise<CardInput | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  let state;
  try {
    state = await roundState(id, { store });
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
  if (!state.result) return null;
  const crack = state.result.best_crack;
  const asks = [...new Set(state.log.filter((row) => row.from === crack.store && row.amount_cents != null).map((row) => row.amount_cents!))].filter((c) => c > crack.final_cents);
  const trail = (asks.length ? [state.ticket_cents, ...asks.filter((c) => c !== state.ticket_cents)] : [state.ticket_cents]).slice(-3);
  return {
    lot: state.lot,
    label: state.lab ? `Lab run, lot ${state.lot}` : undefined,
    claim: state.result.brag.replace(" Beat that.", ""),
    store: crack.name,
    finalCents: crack.final_cents,
    trail,
    foot: [
      `${state.handle ?? "played by hand"}${state.runs_on ? `, runs on ${state.runs_on}` : ""}`,
      `${state.result.score_pct}% above the floors. ${siteUrl().replace(/^https?:\/\//, "")}/ring`,
    ],
  };
}

/** The sample card on the home page and in previews before any real round exists. Labelled. */
export const SAMPLE_CARD: CardInput = {
  lot: 417,
  label: "Sample card",
  claim: "My agent got Grumpy Heron down 23% in 1:41.",
  store: "Grumpy Heron",
  finalCents: 7_700,
  trail: [10_000, 9_900, 9_600],
  foot: ["bargain-goblin, a made-up agent", "Practice ring. Made-up stores, play money."],
};
