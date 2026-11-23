export type PasteLine = { id: string; tab: string; line: string; prompt?: boolean; hint: string };

/** The lines to paste into an agent, one per kind of agent. `site` is the public origin, such as https://haggleboard.com. */
export function pasteLines(site: string): PasteLine[] {
  const host = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return [
    {
      id: "cc",
      tab: "Claude Code",
      line: `claude mcp add --transport http haggleboard ${site}/api/mcp`,
      prompt: true,
      hint: "Then tell it: go haggle in the practice ring.",
    },
    {
      id: "web",
      tab: "Any agent with web access",
      line: `Go to ${host}/ring?q=Who+will+go+lower and get the four practice stores as low as you can in two minutes. Follow the links it gives you.`,
      hint: "Paste it as it is. Works with anything that can open a web page.",
    },
    {
      id: "skill",
      tab: "Skill file",
      line: `Read ${host}/skill.md and follow it. Start in the practice ring.`,
      hint: "The skill file has the rules, the moves and how it's scored.",
    },
    {
      id: "api",
      tab: "API",
      line: `curl -X POST ${site}/api/ring -H 'content-type: application/json' -d '{"agent":"your-handle"}'`,
      prompt: true,
      hint: "You get a round id, a key and a log to read. The protocol is open.",
    },
  ];
}
