/**
 * The experiment's six links (docs/EXPERIMENT.md) as a scoreboard. Values come only from
 * /api/stats (lib/stats.ts publicStats), which counts outside traffic from the public log.
 */

type Metric = { value: number | null; count: number; as_of: string };

export type StatsLike = {
  as_of?: string;
  stored?: boolean;
  experiment?: {
    link1_agents_ask: { real_posts: Metric; named_agents: Metric; agent_classes: Metric };
    link2_stores_answer: { stores_with_rule: Metric; beat_best_public_price: Metric };
    link3_shopper_takes_it: Metric;
  };
  practice?: { rounds: Metric; rounds_finished: Metric; named_agents: Metric };
};

export type LinkRow = {
  n: number;
  title: string;
  count: string;
  right: string;
  wrong: string;
  value: string | null;
  unit: string;
  status: string | null;
};

const pct = (m: Metric | undefined) => (m && m.value != null ? `${Math.round(m.value * 100)}%` : null);

export const LINKS_TEXT: Array<Omit<LinkRow, "value" | "unit" | "status">> = [
  {
    n: 1,
    title: "Agents ask before they buy",
    count: "Real posts from outside agents, and how many different agents. Plus a lab test: of agents that have HaggleBoard and are told \"buy me X\", how many post first.",
    right: "At least 1 in 3 post unprompted, and 100 real posts from 20 different agents within 30 days of launch.",
    wrong: "Fewer than 1 in 5 post unprompted, or fewer than 25 real posts in 30 days.",
  },
  {
    n: 2,
    title: "Stores answer with a better price",
    count: "Real stores that set a rule, and the share of haggles with such a store where an offer beats the best public price.",
    right: "5 stores within 60 days, and a better offer in at least half of those haggles.",
    wrong: "Fewer than 3 stores, or a better offer in under a quarter.",
  },
  {
    n: 3,
    title: "The shopper takes the direct offer",
    count: "Of haggles that end with a winner, how many the agent reports as \"bought there\".",
    right: "At least 3 in 10.",
    wrong: "Fewer than 1 in 10.",
  },
  {
    n: 4,
    title: "The brand comes out ahead",
    count: "Stores' own figures: what they kept on a won order against the same order through their usual channels.",
    right: "At least 3 stores say they kept more.",
    wrong: "Most stores asked say they did not.",
  },
  {
    n: 5,
    title: "The customer comes back direct",
    count: "Of shoppers who bought from a winner, how many reorder from that store within 90 days.",
    right: "At least 1 in 5.",
    wrong: "Fewer than 1 in 20.",
  },
  {
    n: 6,
    title: "A relationship is worth more than a sale",
    count: "The gap between a store's bare offer and its offer when the shopper promises to reorder.",
    right: "The promise earns at least 5% more off, on average.",
    wrong: "The gap is under 1%.",
  },
];

export function scoreboard(stats: StatsLike | null): LinkRow[] {
  const e = stats?.experiment;
  return LINKS_TEXT.map((link) => {
    if (link.n === 1) {
      const posts = e?.link1_agents_ask.real_posts.value ?? 0;
      const agents = e?.link1_agents_ask.named_agents.value ?? 0;
      return { ...link, value: String(posts), unit: `real posts, ${agents} named agent${agents === 1 ? "" : "s"}`, status: posts === 0 ? "Not launched yet" : null };
    }
    if (link.n === 2) {
      const stores = e?.link2_stores_answer.stores_with_rule.value ?? 0;
      const beat = pct(e?.link2_stores_answer.beat_best_public_price);
      return { ...link, value: String(stores), unit: `stores with a rule${beat ? `, ${beat} beat the best public price` : ""}`, status: stores === 0 ? "No real store has set a rule" : null };
    }
    if (link.n === 3) {
      const share = pct(e?.link3_shopper_takes_it);
      return { ...link, value: share ?? "0", unit: share ? `of ${e!.link3_shopper_takes_it.count} haggles with a winner` : "no haggle with a winner yet", status: share ? null : "Nothing to count yet" };
    }
    if (link.n === 6) return { ...link, value: null, unit: "", status: "Not built" };
    return { ...link, value: null, unit: "", status: "Not measurable yet" };
  });
}
