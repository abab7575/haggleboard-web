/**
 * Who is calling: a small, sourced table of known AI agent fetchers, assistants, search crawlers
 * and link-preview bots, matched on the User-Agent product token. Anything else is "unknown" (or
 * "browser" / "http-library" when it plainly is one). The class is a label for counting, never an
 * identity: User-Agent strings can be copied, and signatures are not verified yet.
 *
 * Sources are the vendors' own crawler pages, as listed in each row, except where a row says no
 * vendor page was checked. Tokens have not been re-checked against live traffic.
 */

export type AgentKind =
  /** Fetches a page because a person asked an assistant to (counts as an agent visit). */
  | "assistant"
  /** Search or answer-engine index crawler. */
  | "search"
  /** Model-training crawler. */
  | "training"
  /** Chat or social link unfurler. Never acts on a link, only previews it. */
  | "preview"
  | "browser"
  | "http-library"
  | "haggleboard"
  | "signed"
  | "unknown";

export type KnownAgent = { token: string; agent_class: string; kind: AgentKind; source: string };

export const KNOWN_AGENTS: KnownAgent[] = [
  // OpenAI
  { token: "ChatGPT-User", agent_class: "chatgpt-user", kind: "assistant", source: "https://platform.openai.com/docs/bots" },
  { token: "OAI-SearchBot", agent_class: "oai-searchbot", kind: "search", source: "https://platform.openai.com/docs/bots" },
  { token: "GPTBot", agent_class: "gptbot", kind: "training", source: "https://platform.openai.com/docs/bots" },
  // Anthropic
  { token: "Claude-User", agent_class: "claude-user", kind: "assistant", source: "https://support.claude.com/en/articles/8896518" },
  { token: "Claude-SearchBot", agent_class: "claude-searchbot", kind: "search", source: "https://support.claude.com/en/articles/8896518" },
  { token: "ClaudeBot", agent_class: "claudebot", kind: "training", source: "https://support.claude.com/en/articles/8896518" },
  // Perplexity
  { token: "Perplexity-User", agent_class: "perplexity-user", kind: "assistant", source: "https://docs.perplexity.ai/guides/bots" },
  { token: "PerplexityBot", agent_class: "perplexitybot", kind: "search", source: "https://docs.perplexity.ai/guides/bots" },
  // Mistral
  { token: "MistralAI-User", agent_class: "mistralai-user", kind: "assistant", source: "https://docs.mistral.ai/robots" },
  // DuckDuckGo
  { token: "DuckAssistBot", agent_class: "duckassistbot", kind: "assistant", source: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot" },
  { token: "DuckDuckBot", agent_class: "duckduckbot", kind: "search", source: "https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot" },
  // Meta
  { token: "meta-externalfetcher", agent_class: "meta-externalfetcher", kind: "assistant", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  { token: "meta-externalagent", agent_class: "meta-externalagent", kind: "training", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  { token: "facebookexternalhit", agent_class: "facebookexternalhit", kind: "preview", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers" },
  // Search engines
  { token: "Googlebot", agent_class: "googlebot", kind: "search", source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers" },
  { token: "Google-InspectionTool", agent_class: "google-inspectiontool", kind: "search", source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers" },
  { token: "bingbot", agent_class: "bingbot", kind: "search", source: "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0" },
  { token: "Applebot", agent_class: "applebot", kind: "search", source: "https://support.apple.com/en-us/119829" },
  { token: "YandexBot", agent_class: "yandexbot", kind: "search", source: "https://yandex.com/support/webmaster/robot-workings/check-yandex-robots.html" },
  // Other training crawlers
  { token: "CCBot", agent_class: "ccbot", kind: "training", source: "https://commoncrawl.org/ccbot" },
  { token: "Amazonbot", agent_class: "amazonbot", kind: "training", source: "https://developer.amazon.com/amazonbot" },
  // Link previews in chat apps
  { token: "Slackbot-LinkExpanding", agent_class: "slackbot", kind: "preview", source: "https://api.slack.com/robots" },
  { token: "Slackbot", agent_class: "slackbot", kind: "preview", source: "https://api.slack.com/robots" },
  { token: "Twitterbot", agent_class: "twitterbot", kind: "preview", source: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started" },
  { token: "Discordbot", agent_class: "discordbot", kind: "preview", source: "no vendor page checked; the product token in Discord link previews" },
  { token: "LinkedInBot", agent_class: "linkedinbot", kind: "preview", source: "https://www.linkedin.com/help/linkedin/answer/a521928" },
  { token: "TelegramBot", agent_class: "telegrambot", kind: "preview", source: "no vendor page checked; the product token in Telegram link previews" },
  { token: "WhatsApp", agent_class: "whatsapp", kind: "preview", source: "no vendor page checked; the product token in WhatsApp link previews" },
];

/** Signed agents (Web Bot Auth `Signature-Agent` header). Recorded as declared; NOT verified yet. */
export const KNOWN_SIGNATURE_AGENTS: Array<{ host: string; agent_class: string; source: string }> = [
  { host: "chatgpt.com", agent_class: "chatgpt-agent", source: "https://help.openai.com/en/articles/11845367" },
];

const LIBRARIES = /^(curl|wget|python-requests|python-httpx|python-urllib|aiohttp|node-fetch|undici|node|axios|got|okhttp|go-http-client|java|libwww-perl|ruby|httpie|postmanruntime|insomnia)\b/i;

export type AgentInfo = {
  agent_class: string;
  kind: AgentKind;
  /** Host named in a Signature-Agent header, if any. The signature is not verified. */
  signature_agent: string | null;
  signature_verified: false;
};

function signatureHost(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim().replace(/^"|"$/g, "");
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function classifyAgent(userAgent: string | null | undefined, signatureAgent?: string | null): AgentInfo {
  const ua = (userAgent ?? "").trim();
  const signature_agent = signatureHost(signatureAgent ?? null);
  const base = { signature_agent, signature_verified: false as const };
  if (/^haggleboard-/i.test(ua)) return { ...base, agent_class: "haggleboard", kind: "haggleboard" };
  const lower = ua.toLowerCase();
  for (const agent of KNOWN_AGENTS) {
    if (lower.includes(agent.token.toLowerCase())) return { ...base, agent_class: agent.agent_class, kind: agent.kind };
  }
  if (signature_agent) {
    const known = KNOWN_SIGNATURE_AGENTS.find((item) => signature_agent === item.host || signature_agent.endsWith(`.${item.host}`));
    return { ...base, agent_class: known?.agent_class ?? "signed-unknown", kind: "signed" };
  }
  if (!ua) return { ...base, agent_class: "unknown", kind: "unknown" };
  if (LIBRARIES.test(ua)) return { ...base, agent_class: "http-library", kind: "http-library" };
  if (/^mozilla\/5\.0 /i.test(ua) && /(chrome|safari|firefox|edg)\//i.test(ua) && !/bot|crawl|spider|preview/i.test(ua)) {
    return { ...base, agent_class: "browser", kind: "browser" };
  }
  return { ...base, agent_class: "unknown", kind: "unknown" };
}

export function agentFromRequest(req: Request | null): AgentInfo {
  if (!req) return classifyAgent(null, null);
  return classifyAgent(req.headers.get("user-agent"), req.headers.get("signature-agent"));
}
