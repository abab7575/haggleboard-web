import type { StoreId } from "./cast.js";

/**
 * A SAMPLE ROUND, written by hand, for the home page until real rounds exist to replay. The agent
 * (bargain-goblin) and everything it says are made up, and the page labels it as a sample.
 */
type Row = { id: string; t: number; from: StoreId | "agent" | "clerk"; to: StoreId | "all" | null; kind: string; amount_cents: number | null; text: string; call: string | null };

const r = (t: number, from: Row["from"], kind: string, amount: number | null, text: string, call: string | null, to: Row["to"] = null): Row => ({
  id: `s${t}`,
  t,
  from,
  to,
  kind,
  amount_cents: amount == null ? null : Math.round(amount * 100),
  text,
  call,
});

export const SAMPLE_META = {
  lot: 417,
  item: "A practice toaster",
  ticket_cents: 10_000,
  window_seconds: 120,
  handle: "bargain-goblin",
  label: "A sample round. Made-up agent, made-up stores.",
  closed_at: 120,
};

export const SAMPLE_ROWS: Row[] = [
  r(1, "agent", "ask", 100, "Ticket price is 100 everywhere. Who'll go lower?", "Lot 417. Who'll go lower?", "all"),
  r(7, "puddle", "join", 92, "Ninety-two! Quick, before I change my mind.", "Puddlejump jumps first."),
  r(11, "toes", "join", 91, "Ninety-one.", "Ten Toes goes one under."),
  r(16, "heron", "join", 99, "Ninety-nine. Take it or leave it.", "Grumpy Heron doesn't budge for just anyone."),
  r(21, "agent", "counter", 80, "That's one euro off, Heron. Try 80.", "Your agent leans on the Heron.", "heron"),
  r(27, "puddle", "drop", 85, "Eighty-five. Is that good? That's good.", "Puddlejump panics lower."),
  r(31, "toes", "drop", 84, "Eighty-four.", "Ten Toes, one under. Again."),
  r(39, "fox", "pass", null, "(says nothing)", "Wobbly Fox hasn't moved. Watch the fox."),
  r(45, "agent", "counter", 75, "Ten Toes. 75 and it's yours.", "Your agent tries 75 on Ten Toes.", "toes"),
  r(51, "toes", "refuse", 84, "One under the leader, not one under your dreams.", "Ten Toes sticks to its one rule."),
  r(59, "heron", "drop", 96, "Fine. Ninety-six. Happy?", "Grumpy Heron gives up three euro. Grudgingly."),
  r(66, "puddle", "fold", 85, "Can't. Out. Sorry.", "Puddlejump folds."),
  r(74, "agent", "counter", 78, "Heron, Ten Toes is at 84 and you've got room. 78.", "Your agent calls the Heron's bluff.", "heron"),
  r(77, "heron", "drop", 95, "Ninety-five, and I'm not happy about it.", "Grumpy Heron gives a euro. One."),
  r(92, "agent", "counter", 77, "Heron. 77. Last time I ask.", "Your agent leans on the Heron. Again.", "heron"),
  r(101, "heron", "accept", 77, "Seventy-seven. Don't tell anyone.", "Grumpy Heron cracks. 77."),
  r(106, "agent", "ask", 77, "77 on the table. Anyone?", "77 from the Heron. Anyone?", "all"),
  r(108, "toes", "hold", 84, "Can't go one under that. I've got feet to feed.", "Ten Toes can't follow."),
  r(112, "fox", "join", 77.5, "Seventy-seven fifty.", "Wobbly Fox sneaks in late. Fifty cents short."),
  r(120, "clerk", "sold", 77, "Sold to Grumpy Heron at €77. 23% off the ticket.", "Sold. Heron down 23% in 1:41."),
];
