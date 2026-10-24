import { describe, expect, it } from "vitest";
import { purgePlan, RETENTION_DAYS } from "../lib/db";

describe("30-day retention", () => {
  it("targets need text, reports, bids and hashed-IP counters older than 30 days", () => {
    const now = Date.UTC(2026, 9, 24);
    const plan = purgePlan(now);
    expect(RETENTION_DAYS).toBe(30);
    const cutoff = new Date(now - 30 * 86_400_000).toISOString();
    expect(plan.find(([q]) => q.startsWith("DELETE FROM requests"))?.[1]).toEqual([cutoff]);
    expect(plan.some(([q]) => q.includes("rate_hits") && q.includes("'d:%'"))).toBe(true);
    expect(plan.some(([q]) => q.includes("rate_hits") && q.includes("'m:%'"))).toBe(true);
  });
});
