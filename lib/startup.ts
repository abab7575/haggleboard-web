/** Refuse to boot a Vercel process that would hash IPs with a throwaway salt. */
export function assertVercelStartup(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VERCEL !== "1") return;
  if (!env.MCP_CALL_LOG_SALT?.trim()) {
    throw new Error("MCP_CALL_LOG_SALT is required when VERCEL=1");
  }
}
