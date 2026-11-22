import type { PublicArenaEvent, PublicBidder } from "./arena";

/**
 * Scripted demo data. Every store here is made up, every number is invented,
 * and every component that renders this data shows a visible "Demo" label.
 * Replace with real public events once stores bid on the clock.
 */

export const DEMO_STORES: PublicBidder[] = [
  { id: "a", name: "Puddlejump", tone: "clay" },
  { id: "b", name: "Grumpy Heron", tone: "plum" },
  { id: "c", name: "Ten Toes", tone: "ochre" },
  { id: "d", name: "Wobbly Fox", tone: "slate" },
];

export type ArenaScript = {
  request: string;
  durationSec: number;
  bidders: PublicBidder[];
  events: PublicArenaEvent[];
};

/** Short and punchy: plays in about five seconds on the homepage. */
export const HERO_SCRIPT: ArenaScript = {
  request: "Trail running shoes, women's size 8",
  durationSec: 120,
  bidders: DEMO_STORES.slice(0, 3),
  events: [
    { kind: "join", at: 6, bidder: "a" },
    { kind: "lead", at: 9, bidder: "a", band: 5 },
    { kind: "join", at: 26, bidder: "b" },
    { kind: "lead", at: 40, bidder: "b", band: 10 },
    { kind: "join", at: 58, bidder: "c" },
    { kind: "lead", at: 80, bidder: "a", band: 10 },
    { kind: "lead", at: 112, bidder: "c", band: 15 },
    { kind: "close", at: 120, winner: "c", saved_pct: 14, won_at: 112 },
  ],
};

/** The longer bout for /arena/demo: four stores and two late snipes. */
export const FULL_SCRIPT: ArenaScript = {
  request: "Trail running shoes, women's size 8",
  durationSec: 120,
  bidders: DEMO_STORES,
  events: [
    { kind: "join", at: 4, bidder: "a" },
    { kind: "lead", at: 6, bidder: "a", band: 5 },
    { kind: "join", at: 14, bidder: "b" },
    { kind: "lead", at: 22, bidder: "b", band: 5 },
    { kind: "join", at: 33, bidder: "c" },
    { kind: "lead", at: 45, bidder: "c", band: 10 },
    { kind: "join", at: 58, bidder: "d" },
    { kind: "lead", at: 70, bidder: "b", band: 10 },
    { kind: "lead", at: 86, bidder: "d", band: 15 },
    { kind: "lead", at: 101, bidder: "c", band: 15 },
    { kind: "lead", at: 114, bidder: "d", band: 15 },
    { kind: "lead", at: 118, bidder: "b", band: 20 },
    { kind: "close", at: 120, winner: "b", saved_pct: 18, won_at: 118 },
  ],
};

export const DEMO_SCORECARD = {
  agentName: "Your agent",
  dealsWon: 7,
  totalSaved: "$142",
  fastestWinSec: 64,
  streak: 3,
};

export const DEMO_BADGES = [
  { id: "first-win", label: "First win", description: "Won its first clock.", earned: true },
  { id: "buzzer", label: "Buzzer beater", description: "Won with a bid in the last 10 seconds.", earned: true },
  { id: "three-peat", label: "Three in a row", description: "Three wins back to back.", earned: true },
  { id: "big-save", label: "Big saver", description: "20% or more under the best public price.", earned: false },
];

export const DEMO_BIGGEST_SAVES = [
  { request: "Trail running shoes, women's 8", winner: "Grumpy Heron", savedPct: 18, wonAtSec: 118 },
  { request: "Road shoes, men's 10", winner: "Wobbly Fox", savedPct: 15, wonAtSec: 97 },
  { request: "Running socks, 3 pack", winner: "Ten Toes", savedPct: 12, wonAtSec: 71 },
  { request: "Kids' trainers, size 1", winner: "Puddlejump", savedPct: 9, wonAtSec: 104 },
];
