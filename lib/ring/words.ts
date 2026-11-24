/** Prices the way a stallholder says them: "Ninety-six", "Seventy-seven fifty". Play money, euro. */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function under100(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t]!;
}

export function numberWords(n: number): string {
  const whole = Math.floor(Math.abs(n));
  if (whole >= 1000) return String(whole);
  if (whole < 100) return under100(whole);
  const h = Math.floor(whole / 100);
  const rest = whole % 100;
  return rest ? `${ONES[h]} hundred and ${under100(rest)}` : `${ONES[h]} hundred`;
}

/** "Ninety-six", "Seventy-seven fifty", "Eighty-one twenty". */
export function sayPrice(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  const head = numberWords(euros);
  const words = rest ? `${head} ${rest < 10 ? `oh ${numberWords(rest)}` : numberWords(rest)}` : head;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "96", "77.50". */
export function money(cents: number): string {
  return cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100);
}

/** "€96", "€77.50". */
export function euro(cents: number): string {
  return `€${money(cents)}`;
}

/** "1:41" from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
