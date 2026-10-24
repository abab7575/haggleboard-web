import { describe, expect, it } from "vitest";
import { DISCLAIMER } from "../lib/copy";
import { openStore } from "../lib/db";

describe("disclaimer", () => {
  it("states HaggleBoard is not a party to any sale and never holds money", () => {
    expect(DISCLAIMER).toMatch(/not a party to any sale/i);
    expect(DISCLAIMER).toMatch(/never takes payment/i);
    expect(DISCLAIMER).toMatch(/not affiliated/i);
  });
});

describe("store selection", () => {
  it("refuses pglite:// when VERCEL is set", async () => {
    await expect(openStore({ VERCEL: "1", DATABASE_URL: "pglite://memory" } as unknown as NodeJS.ProcessEnv)).rejects.toThrow(/local dev and tests only/);
  });
  it("uses pglite locally", async () => {
    const s = await openStore({ DATABASE_URL: "pglite://memory" } as unknown as NodeJS.ProcessEnv);
    expect(s.kind).toBe("pglite");
    await s.close();
  });
});
