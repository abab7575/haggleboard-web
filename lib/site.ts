/** The public origin, such as https://haggleboard.com. Paste lines and share links use it. */
export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SITE_URL?.trim() || "https://haggleboard.com").replace(/\/$/, "");
}
