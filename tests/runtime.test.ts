import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("runtime imports", () => {
  it("loads sqlite and the MCP SDK instead of skipping those files", () => {
    const db = new Database(":memory:");
    expect(db.prepare("select 1 as n").get()).toEqual({ n: 1 });
    db.close();
    expect(typeof McpServer).toBe("function");
  });
});
