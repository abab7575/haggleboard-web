/**
 * THE PRACTICE RING'S CAST. Four made-up stores, each a bot with its own temper and, per round, a
 * secret lowest price ("floor") drawn from its range. Play money only. Nothing here is a real store,
 * a real product or a real price, and nothing in the ring ever makes an outside request.
 */

export type StoreId = "heron" | "puddle" | "toes" | "fox";

export type RingStore = {
  id: StoreId;
  name: string;
  /** The number on its paddle. */
  no: number;
  /** The short word on its paddle's tag while it is just standing there. */
  temper: string;
  /** One line on how it haggles, for the rules and the skill. */
  style: string;
  /** Its secret lowest price, as a share of the ticket price, drawn fresh each round. */
  floor_range: [number, number];
  /** How long it takes to answer a message, in milliseconds. */
  reply_ms: number;
  /** Costume: the paddle hand and sleeve. */
  skin: string;
  skin_dark: string;
  sleeve: "heron" | "mac" | "stripe" | "fox";
};

export const RING_STORES: RingStore[] = [
  {
    id: "heron",
    name: "Grumpy Heron",
    no: 12,
    temper: "Small steps",
    style: "Moves a euro or two at a time and ignores questions shouted at everyone. Lean on it directly, more than once, and it cracks.",
    floor_range: [0.74, 0.82],
    reply_ms: 2600,
    skin: "#E9B896",
    skin_dark: "#C99474",
    sleeve: "heron",
  },
  {
    id: "puddle",
    name: "Puddlejump",
    no: 33,
    temper: "Jumpy",
    style: "Jumps in first and drops fast, faster when you push. Then it panics and folds, usually a bit past halfway.",
    floor_range: [0.8, 0.88],
    reply_ms: 1200,
    skin: "#8D5A3B",
    skin_dark: "#6E4329",
    sleeve: "mac",
  },
  {
    id: "toes",
    name: "Ten Toes",
    no: 10,
    temper: "One under",
    style: "Always goes one euro under whoever is leading, and never under that, whatever you say to it. Drag the others down and Ten Toes follows.",
    floor_range: [0.76, 0.84],
    reply_ms: 1800,
    skin: "#C68A5E",
    skin_dark: "#A46D45",
    sleeve: "stripe",
  },
  {
    id: "fox",
    name: "Wobbly Fox",
    no: 27,
    temper: "Watch it",
    style: "Says nothing until the last fifteen seconds, then sneaks in just under the leader. Nag it early and it sneaks in lower.",
    floor_range: [0.72, 0.8],
    reply_ms: 3400,
    skin: "#000000",
    skin_dark: "#2B2B2B",
    sleeve: "fox",
  },
];

export const STORE_IDS = RING_STORES.map((store) => store.id);

export function ringStore(id: StoreId): RingStore {
  return RING_STORES.find((store) => store.id === id)!;
}

/** Made-up lots. Play money, euro ticket prices. */
export const LOTS: Array<{ item: string; ticket_cents: number }> = [
  { item: "A practice toaster", ticket_cents: 10_000 },
  { item: "A kettle that sings slightly flat", ticket_cents: 8_000 },
  { item: "A garden gnome, as new", ticket_cents: 12_000 },
  { item: "A very loud alarm clock", ticket_cents: 6_000 },
  { item: "A bike bell with opinions", ticket_cents: 4_000 },
  { item: "A waffle iron, one careful owner", ticket_cents: 9_000 },
];

export const RING_CURRENCY = "EUR";
export const RING_WINDOW_SECONDS = 120;
export const RING_MIN_SECONDS = 30;
export const RING_MAX_SECONDS = 300;
/** Messages one haggler can send in one round. */
export const RING_MAX_MESSAGES = 80;
