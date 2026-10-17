/**
 * Password generation runs entirely in the browser using the Web Crypto CSPRNG
 * (crypto.getRandomValues). Generated values are never sent to the server or logged
 * unless the user saves them into a credential.
 */

export interface GenOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  exclude: string;
  excludeAmbiguous: boolean;
  keywords: string[];
  useKeywords: boolean;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/~";
const AMBIGUOUS = "Il1O0o";
const MIN_RANDOM = 12;
const LEET: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7" };

/** Unbiased random integer in [0, max) via rejection sampling. */
export function randInt(max: number): number {
  if (max <= 0) throw new Error("max must be > 0");
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

const pick = <T,>(arr: ArrayLike<T>): T => arr[randInt(arr.length)];
const chance = (p: number) => randInt(1_000_000) < p * 1_000_000;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function generatePassword(o: GenOptions): string {
  const excluded = new Set([...o.exclude, ...(o.excludeAmbiguous ? AMBIGUOUS : "")]);
  const filter = (s: string) => [...s].filter((c) => !excluded.has(c));
  const pools: string[][] = [];
  if (o.upper) pools.push(filter(UPPER));
  if (o.lower) pools.push(filter(LOWER));
  if (o.digits) pools.push(filter(DIGITS));
  if (o.symbols) pools.push(filter(SYMBOLS));
  const active = pools.filter((p) => p.length);
  if (!active.length) throw new Error("Select at least one character set");
  const alphabet = active.flat();

  const words: string[] = [];
  // Keywords are decoration only: at least MIN_RANDOM random characters are always added on top
  const kwChars = o.useKeywords ? o.keywords.reduce((n, k) => n + k.trim().length, 0) : 0;
  const length = o.useKeywords && kwChars ? Math.max(o.length, kwChars + MIN_RANDOM) : o.length;
  if (o.useKeywords && o.keywords.length) {
    const budget = Math.max(0, length - Math.max(MIN_RANDOM, active.length + 3));
    let used = 0;
    for (const raw of shuffle([...o.keywords])) {
      // Keyword letters stay readable: "avoid look-alikes" does not apply to them, only the explicit exclude list
      const explicit = new Set(o.exclude);
      const w = [...raw.trim()]
        .map((ch, i) => {
          let c = o.upper && (i === 0 || chance(0.2)) ? ch.toUpperCase() : ch.toLowerCase();
          const leet = LEET[c.toLowerCase()];
          if (o.digits && leet && !excluded.has(leet) && chance(0.4)) c = leet;
          if (!explicit.has(c)) return c;
          const other = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
          return explicit.has(other) ? pick(alphabet) : other;
        })
        .join("");
      if (!w || used + w.length > budget) continue;
      words.push(w);
      used += w.length;
    }
  }

  const required = active.map((p) => pick(p));
  const fillLen = Math.max(0, length - words.join("").length - required.length);
  const filler = shuffle([...Array.from({ length: fillLen }, () => pick(alphabet)), ...required]);
  if (!words.length) return filler.join("");

  // Interleave keywords into the random characters at random positions
  const cuts = shuffle(Array.from({ length: filler.length + 1 }, (_, i) => i)).slice(0, words.length).sort((a, b) => a - b);
  let out = "";
  let prev = 0;
  words.forEach((w, i) => {
    out += filler.slice(prev, cuts[i]).join("") + w;
    prev = cuts[i];
  });
  return out + filler.slice(prev).join("");
}

export interface Strength { score: 0 | 1 | 2 | 3 | 4; label: string; bits: number; color: string }

/** Rough entropy estimate (character-class based) with penalties for repeats/sequences. */
export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: "Empty", bits: 0, color: "var(--border)" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  let bits = Math.log2(pool || 1) * pw.length * Math.min(1, unique / Math.max(6, pw.length * 0.6));
  if (/(.)\1{2,}/.test(pw)) bits -= 10;
  if (/(012|123|234|345|456|567|678|789|abc|bcd|cde|qwe|asd|password|admin)/i.test(pw)) bits -= 15;
  bits = Math.max(0, Math.round(bits));
  const levels: [number, Strength["score"], string, string][] = [
    [100, 4, "Excellent", "var(--ok)"],
    [70, 3, "Strong", "#16a34a"],
    [50, 2, "Fair", "var(--warn)"],
    [28, 1, "Weak", "var(--danger)"],
    [0, 0, "Very weak", "var(--danger)"],
  ];
  const [, score, label, color] = levels.find(([min]) => bits >= min)!;
  return { score, label, bits, color };
}

export const DEFAULT_GEN: GenOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  exclude: "",
  excludeAmbiguous: true,
  keywords: [],
  useKeywords: false,
};

/** Several keyword-based suggestions (each still ≥ 12 random characters) for the user to pick from. */
export function suggestPasswords(o: GenOptions, count = 4): string[] {
  const out = new Set<string>();
  for (let i = 0; out.size < count && i < count * 4; i++) out.add(generatePassword({ ...o, useKeywords: true }));
  return [...out];
}
