export function toCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(cents / 100);
  } catch {
    return `${centsToDecimal(cents)} ${currency}`;
  }
}

export function currencyFromToken(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.toLowerCase();
  if (t === "$" || t === "usd" || t === "dollars" || t === "dollar") return "USD";
  if (t === "£" || t === "gbp" || t === "pounds" || t === "pound") return "GBP";
  if (t === "€" || t === "eur" || t === "euros" || t === "euro") return "EUR";
  if (t === "sgd") return "SGD";
  if (t === "cad") return "CAD";
  return null;
}
