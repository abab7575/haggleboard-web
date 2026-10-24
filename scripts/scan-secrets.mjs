import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skip = new Set(["node_modules", ".git", ".next", "data", "coverage", "feeds/cache", "feeds/snapshots"]);
const allowEmails = new Set(["contact@haggleboard.com"]);
const allowHelloFiles = new Set([".env.example"]);

const patterns = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "live stripe", re: /sk_live_[0-9A-Za-z]+/ },
  { name: "github token", re: /ghp_[0-9A-Za-z]{20,}/ },
  { name: "slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "personal name", re: /\bAndy\b/ },
];
const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const hits = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.relative(root, path.join(dir, entry.name));
    if (skip.has(entry.name) || skip.has(rel) || rel.startsWith("feeds/cache") || rel.startsWith("feeds/snapshots")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (entry.name === "package-lock.json") continue;
    if (!/\.(ts|tsx|js|mjs|json|md|txt|yml|yaml|example|css|svg)$/.test(entry.name) && entry.name !== ".env.example") continue;
    const text = await readFile(full, "utf8");
    for (const pattern of patterns) {
      if (pattern.re.test(text)) hits.push(`${rel}: ${pattern.name}`);
      pattern.re.lastIndex = 0;
    }
    if (rel === "scripts/scan-secrets.mjs") continue;
    const emails = text.match(emailRe) ?? [];
    for (const email of emails) {
      const lowered = email.toLowerCase();
      if (allowEmails.has(lowered)) continue;
      if (lowered === "hello@haggleboard.com" && allowHelloFiles.has(rel)) continue;
      hits.push(`${rel}: email ${email}`);
    }
  }
}

await walk(root);
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("secret scan ok");
