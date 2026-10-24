import { describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { questions } from "../lib/questions";
import { getOffers } from "../lib/service";

describe("board questions", () => {
  it("each question is answered by the bundled snapshot", async () => {
    const variants = readFixture().variants;
    const deps = { store: { listBids: async () => [] } as never, loadVariants: async () => variants };
    for (const question of questions) {
      const result = await getOffers(question.need, deps);
      expect(result.offers.length, question.slug).toBeGreaterThan(0);
    }
  });
});
