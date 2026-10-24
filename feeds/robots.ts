import { USER_AGENT } from "./constants.js";

export type RobotRule = { allow: boolean; path: string };
export type RobotGroup = { agents: string[]; rules: RobotRule[]; crawlDelaySec: number | null };
export type RobotsFile = { groups: RobotGroup[] };

export function parseRobots(text: string): RobotsFile {
  const groups: RobotGroup[] = [];
  let current: RobotGroup | null = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.replace(/#.*$/, "").trim();
    if (!stripped) continue;
    const splitAt = stripped.indexOf(":");
    if (splitAt < 0) continue;
    const field = stripped.slice(0, splitAt).trim().toLowerCase();
    const value = stripped.slice(splitAt + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0 || current.crawlDelaySec != null) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) {
      current = { agents: ["*"], rules: [], crawlDelaySec: null };
      groups.push(current);
    }
    if (field === "allow" && value) current.rules.push({ allow: true, path: value });
    if (field === "disallow" && value) current.rules.push({ allow: false, path: value });
    if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySec = seconds;
    }
  }
  return { groups };
}

export type PathDecision = { allowed: boolean; crawlDelaySec: number | null };

/**
 * RFC 9309 style: the product token is the first word of our user agent.
 * The longest matching group wins. `*` applies only when nothing else matches.
 * For a path, the longest matching rule wins and Allow beats Disallow on a tie.
 */
export function decidePath(file: RobotsFile, path: string, ua: string = USER_AGENT): PathDecision {
  const product = ua.split(/[\s/]/)[0]?.toLowerCase() ?? "";
  let best: RobotGroup | null = null;
  let bestLen = -1;
  for (const group of file.groups) {
    for (const agent of group.agents) {
      if (agent === "*") continue;
      if (product.startsWith(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  const chosen = best ?? file.groups.find((group) => group.agents.includes("*")) ?? null;
  if (!chosen) return { allowed: true, crawlDelaySec: null };

  let matched: RobotRule | null = null;
  for (const rule of chosen.rules) {
    if (!pathMatches(rule.path, path)) continue;
    if (!matched || rule.path.length > matched.path.length || (rule.path.length === matched.path.length && rule.allow && !matched.allow)) {
      matched = rule;
    }
  }
  return { allowed: matched ? matched.allow : true, crawlDelaySec: chosen.crawlDelaySec };
}

function pathMatches(rulePath: string, requestPath: string): boolean {
  if (!rulePath) return false;
  return compile(rulePath).test(requestPath);
}

function compile(rulePath: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < rulePath.length; i++) {
    const char = rulePath[i];
    if (char === "*") pattern += ".*";
    else if (char === "$" && i === rulePath.length - 1) pattern += "$";
    else pattern += char!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  if (!pattern.endsWith("$")) pattern += ".*";
  // A rule of "/products" should match "/products.json" (prefix). The trailing .* does that.
  // A rule ending in $ is already anchored and should not gain .*.
  return new RegExp(pattern, "i");
}
