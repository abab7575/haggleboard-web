import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import robots from "../app/robots";
import { indexingAllowed, robotsDocument, rootMetadata } from "../lib/indexing";
import { deleteTokenKey } from "../lib/keys";
import { openSqlite } from "../lib/db";
import { rateSalt } from "../lib/rate-limit";
import { postRequest, type Deps } from "../lib/service";
import { assertVercelStartup } from "../lib/startup";
import { register } from "../instrumentation";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe("Vercel startup", () => {
  it("fails when VERCEL=1 and MCP_CALL_LOG_SALT is missing", async () => {
    expect(() => assertVercelStartup(env({ VERCEL: "1" }))).toThrow(/MCP_CALL_LOG_SALT is required when VERCEL=1/);
    expect(() => assertVercelStartup(env({ VERCEL: "1", MCP_CALL_LOG_SALT: "   " }))).toThrow(
      /MCP_CALL_LOG_SALT is required when VERCEL=1/,
    );
    expect(() => assertVercelStartup(env({}))).not.toThrow();
    expect(() => assertVercelStartup(env({ VERCEL: "1", MCP_CALL_LOG_SALT: "salt" }))).not.toThrow();
    expect(() => rateSalt(env({ VERCEL: "1" }))).toThrow(/MCP_CALL_LOG_SALT is required when VERCEL=1/);
    expect(rateSalt(env({ VERCEL: "1", MCP_CALL_LOG_SALT: "salt" }))).toBe("salt");

    const previousVercel = process.env.VERCEL;
    const previousSalt = process.env.MCP_CALL_LOG_SALT;
    process.env.VERCEL = "1";
    delete process.env.MCP_CALL_LOG_SALT;
    try {
      await expect(register()).rejects.toThrow(/MCP_CALL_LOG_SALT is required when VERCEL=1/);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
      if (previousSalt === undefined) delete process.env.MCP_CALL_LOG_SALT;
      else process.env.MCP_CALL_LOG_SALT = previousSalt;
    }
  });
});

describe("delete token key", () => {
  it("requires DELETE_TOKEN_KEY and ignores other secrets", async () => {
    expect(
      deleteTokenKey(
        env({
          DELETE_TOKEN_KEY: "only-this",
          BID_TOKEN_SIGNING_KEY: "bid-secret",
          MCP_CALL_LOG_SALT: "ip-salt",
        }),
      ),
    ).toBe("only-this");
    expect(() =>
      deleteTokenKey(env({ BID_TOKEN_SIGNING_KEY: "bid-secret", MCP_CALL_LOG_SALT: "ip-salt" })),
    ).toThrow(/DELETE_TOKEN_KEY/);
    expect(() => deleteTokenKey(env({ DELETE_TOKEN_KEY: "  " }))).toThrow(/DELETE_TOKEN_KEY/);
    expect(readFileSync(new URL("../lib/keys.ts", import.meta.url), "utf8")).not.toContain(
      "haggleboard-dev-delete-token",
    );

    const previous = process.env.DELETE_TOKEN_KEY;
    delete process.env.DELETE_TOKEN_KEY;
    const store = await openSqlite(":memory:");
    const deps: Deps = { store, loadVariants: async () => [] };
    try {
      await expect(postRequest({ text: "women's Brooks Ghost 16, size 8" }, deps)).rejects.toThrow(/DELETE_TOKEN_KEY/);
      expect(await store.listRequests(10)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.DELETE_TOKEN_KEY;
      else process.env.DELETE_TOKEN_KEY = previous;
      await store.close();
    }
  });
});

describe("preview indexing", () => {
  it("sends noindex unless HB_PUBLIC=1 in production", () => {
    expect(indexingAllowed(env({ NODE_ENV: "production" }))).toBe(false);
    expect(indexingAllowed(env({ NODE_ENV: "production", HB_PUBLIC: "0" }))).toBe(false);
    expect(indexingAllowed(env({ NODE_ENV: "development", HB_PUBLIC: "1" }))).toBe(false);
    expect(
      indexingAllowed(env({ NODE_ENV: "production", HB_PUBLIC: "1", VERCEL: "1", VERCEL_ENV: "preview" })),
    ).toBe(false);
    expect(indexingAllowed(env({ NODE_ENV: "production", HB_PUBLIC: "1", VERCEL: "1" }))).toBe(false);
    expect(
      indexingAllowed(env({ NODE_ENV: "production", HB_PUBLIC: "1", VERCEL: "1", VERCEL_ENV: "production" })),
    ).toBe(true);
    expect(indexingAllowed(env({ NODE_ENV: "production", HB_PUBLIC: "1" }))).toBe(true);

    const hidden = env({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview" });
    expect(robotsDocument(hidden)).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect(rootMetadata(hidden).robots).toEqual({ index: false, follow: false });

    const listed = env({ NODE_ENV: "production", HB_PUBLIC: "1", VERCEL: "1", VERCEL_ENV: "production" });
    expect(robotsDocument(listed)).toEqual({ rules: [{ userAgent: "*", allow: "/" }] });
    expect(rootMetadata(listed).robots).toEqual({ index: true, follow: true });

    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect(readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8")).toContain("rootMetadata()");
    expect(readFileSync(new URL("../app/robots.ts", import.meta.url), "utf8")).toContain("robotsDocument()");
  });
});
