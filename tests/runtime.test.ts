import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openPglite } from "../lib/db";

describe("runtime imports", () => {
  it("loads the local store (PGlite) and the MCP SDK", async () => {
    const store = await openPglite();
    expect(store.kind).toBe("pglite");
    expect(await store.countVariants()).toBe(0);
    await store.close();
    expect(typeof McpServer).toBe("function");
  });
});
