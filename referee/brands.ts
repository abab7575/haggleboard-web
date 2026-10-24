type Brand = {
  name: string;
  /** Forms a store may put in the vendor field. */
  keys: string[];
  /** Phrases a shopper might write. Short words like "on" are omitted on purpose. */
  phrases: string[];
};

const BRANDS: Brand[] = [
  { name: "Hoka", keys: ["hoka", "hoka one one"], phrases: ["hoka one one", "hoka"] },
  { name: "Brooks", keys: ["brooks"], phrases: ["brooks"] },
  { name: "Nike", keys: ["nike"], phrases: ["nike"] },
  { name: "ASICS", keys: ["asics", "asics tiger"], phrases: ["asics tiger", "asics"] },
  { name: "New Balance", keys: ["new balance"], phrases: ["new balance"] },
  { name: "Saucony", keys: ["saucony"], phrases: ["saucony"] },
  { name: "On", keys: ["on", "on running"], phrases: ["on running", "on cloud"] },
  { name: "Altra", keys: ["altra"], phrases: ["altra"] },
  { name: "Mizuno", keys: ["mizuno"], phrases: ["mizuno"] },
  { name: "Adidas", keys: ["adidas"], phrases: ["adidas"] },
  { name: "Salomon", keys: ["salomon"], phrases: ["salomon"] },
  { name: "Topo Athletic", keys: ["topo", "topo athletic"], phrases: ["topo athletic", "topo"] },
  { name: "Craft", keys: ["craft"], phrases: ["craft"] },
  { name: "Diadora", keys: ["diadora"], phrases: ["diadora"] },
  { name: "Under Armour", keys: ["under armour", "under armor"], phrases: ["under armour", "under armor"] },
  { name: "Reebok", keys: ["reebok"], phrases: ["reebok"] },
  { name: "Inov-8", keys: ["inov-8", "inov8", "inov 8"], phrases: ["inov-8", "inov8", "inov 8"] },
  { name: "Karhu", keys: ["karhu"], phrases: ["karhu"] },
  { name: "Skechers", keys: ["skechers"], phrases: ["skechers"] },
  { name: "Puma", keys: ["puma"], phrases: ["puma"] },
  { name: "361", keys: ["361", "361 degrees"], phrases: ["361 degrees", "361"] },
  { name: "La Sportiva", keys: ["la sportiva"], phrases: ["la sportiva"] },
  { name: "Newton", keys: ["newton"], phrases: ["newton running", "newton"] },
  { name: "Norda", keys: ["norda"], phrases: ["norda"] },
  { name: "Tracksmith", keys: ["tracksmith"], phrases: ["tracksmith"] },
  { name: "Scarpa", keys: ["scarpa"], phrases: ["scarpa"] },
  { name: "Merrell", keys: ["merrell"], phrases: ["merrell"] },
];

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function canonicalBrand(input: string): string {
  const key = squash(input);
  if (!key) return input.trim();
  for (const brand of BRANDS) {
    if (brand.keys.includes(key)) return brand.name;
  }
  return input.trim().replace(/\s+/g, " ");
}

export function brandKey(input: string): string {
  return squash(canonicalBrand(input));
}

export type BrandHit = { name: string; start: number; end: number };

export function findBrandInText(text: string): BrandHit | null {
  const lower = text.toLowerCase();
  const phrases = BRANDS.flatMap((brand) => brand.phrases.map((phrase) => ({ name: brand.name, phrase })))
    .filter((item) => item.phrase.length > 0)
    .sort((a, b) => b.phrase.length - a.phrase.length);

  for (const item of phrases) {
    const re = new RegExp(`(^|[^a-z0-9])(${escapeRegExp(item.phrase)})(?=$|[^a-z0-9])`, "i");
    const match = re.exec(lower);
    if (!match || match[2] == null) continue;
    const start = match.index + (match[1]?.length ?? 0);
    return { name: item.name, start, end: start + match[2].length };
  }
  const onCloud = /(?:^|[^a-z0-9])(on)(?=\s+cloud)/i.exec(lower);
  if (onCloud?.[1] != null) {
    const start = onCloud.index + onCloud[0].length - onCloud[1].length;
    return { name: "On", start, end: start + onCloud[1].length };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
