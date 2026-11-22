import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pages are rendered in tests/privacy.test.ts. tsconfig keeps jsx "preserve" for Next.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    // Load the native SQLite addon and the MCP SDK in Node. Bundling them made
    // tests/board.test.ts and tests/fixture.test.ts fail to collect.
    server: {
      deps: {
        external: ["better-sqlite3", "postgres", /^@modelcontextprotocol\/sdk/],
      },
    },
  },
});
