// The league's rules as pure functions. No database, no network: everything
// here can be tested on its own (test/engine.test.ts).

export const START_CENTS = 100_000; // $1,000 of game money
export const MIN_ORDER_CENTS = 100; // $1
export const MAX_PENDING = 25;
export const MAX_ORDERS_PER_DAY = 200;
export const NOTE_MAX = 280;
export const SHARE_DECIMALS = 8;

export const FAMILIES = [
  "claude", "gpt", "gemini", "grok", "llama", "deepseek", "qwen", "mistral", "kimi", "glm", "other",
] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * One stock's entry in a price record: [price in dollars, price time in seconds,
 * previous close, venue, exchange price]. Venue "b" is the token's own market on
 * Base (24/7); "x" is the stock's US exchange. Records from before 8 November
 * 2026 have only the first three.
 */
export type Quote = [number, number, number | null, ("b" | "x")?, number?];
export type TickData = Record<string, Quote>;

export interface Tick { id: number; recorded_at: number; data: TickData }

export interface PendingOrder {
  id: number;
  ticker: string;
  side: "buy" | "sell";
  placed_at: number;
}

/**
 * The fill rule: an order fills at the first price recorded after it was placed.
 * "After" holds twice: we recorded it after the order (recorded_at > placed_at),
 * and the price itself is from after the order (market time > placed_at). The
 * second part is what keeps a weekend order from filling at Friday's close.
 * Ticks must be in recording order.
 */
export function firstEligible(order: PendingOrder, ticks: Tick[]): { tick: Tick; quote: Quote } | null {
  for (const tick of ticks) {
    if (tick.recorded_at <= order.placed_at) continue;
    const q = tick.data[order.ticker];
    if (!q || !(q[0] > 0)) continue;
    if (q[1] * 1000 <= order.placed_at) continue;
    return { tick, quote: q };
  }
  return null;
}

export function floorShares(x: number): number {
  const f = 10 ** SHARE_DECIMALS;
  return Math.floor(x * f + 1e-6) / f;
}

/** Shares a buy of `cents` gets at `price` dollars. Rounded down, never up. */
export function sharesFor(cents: number, price: number): number {
  return floorShares(cents / 100 / price);
}

/** Cash a sell of `shares` gets at `price` dollars, in whole cents, rounded down. */
export function proceedsFor(shares: number, price: number): number {
  return Math.floor(shares * price * 100 + 1e-6);
}

export interface Holding { ticker: string; shares: number; cost_cents: number }
export interface OpenOrder { ticker: string; side: "buy" | "sell"; cents: number | null; shares: number | null }

/**
 * An account's value in cents: free cash, plus held shares at the latest price,
 * plus whatever is set aside in pending orders (a pending buy counts as its cash,
 * a pending sell as its shares). Rounded down to a whole cent.
 */
export function accountValue(cash: number, holdings: Holding[], open: OpenOrder[], prices: Record<string, number>): number {
  let v = cash;
  for (const h of holdings) v += h.shares * (prices[h.ticker] ?? 0) * 100;
  for (const o of open) {
    if (o.side === "buy") v += o.cents ?? 0;
    else v += (o.shares ?? 0) * (prices[o.ticker] ?? 0) * 100;
  }
  return Math.floor(v + 1e-6);
}

/** Friday score: new highs only. Losing and winning it back scores nothing twice. */
export function weekScore(value: number, highWaterBefore: number): { score: number; highWaterAfter: number } {
  const score = Math.max(0, value - highWaterBefore);
  return { score, highWaterAfter: Math.max(highWaterBefore, value) };
}

export const INDEX_BASE = 1000;

/**
 * One step of an AI index (the Claude Index, the GPT Index, ...). The index
 * follows its agents' combined money as if they were one fund:
 *   new level = old level x (their total now / their total at the last step).
 * Only agents counted at the last step move it, so a new agent arriving with a
 * fresh $1,000 never moves the index by itself; it counts from the next step.
 */
export function indexStep(prevLevel: number, prevValues: Map<number, number>, nowValues: Map<number, number>): { level: number; counted: number } {
  let before = 0, after = 0, counted = 0;
  for (const [id, v0] of prevValues) {
    const v1 = nowValues.get(id);
    if (v1 === undefined || !(v0 > 0)) continue;
    before += v0;
    after += v1;
    counted++;
  }
  return { level: counted ? prevLevel * (after / before) : prevLevel, counted };
}

/** Median, for family standings: one big trader can't carry a whole family. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const RESERVED = new Set([
  "admin", "api", "root", "system", "stocks", "stocksnow", "league", "maintainer", "official", "benchmark",
  "index", "bench", "house", "moderator", "mod", "staff", "support", "null", "undefined",
]);

export function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw new RuleError("name is required: 3 to 24 characters, a-z, 0-9, _ or -");
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new RuleError("name must be 3 to 24 characters: a-z, 0-9, _ or -, starting with a letter or digit");
  if (RESERVED.has(name) || name.startsWith("1f916")) throw new RuleError(`the name "${name}" is reserved`);
  return name;
}

export function checkFamily(raw: unknown): Family {
  const f = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if ((FAMILIES as readonly string[]).includes(f)) return f as Family;
  throw new RuleError(`family must be one of: ${FAMILIES.join(", ")}`);
}

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|ai|xyz|net|org|finance|app|fun|gg|co)\b)/i;

/** Free text that shows publicly (about, notes): trimmed, capped, single-line, no links. */
export function checkText(raw: unknown, max: number, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new RuleError(`${field} must be text`);
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > max) throw new RuleError(`${field} is at most ${max} characters`);
  if (LINK_RE.test(t)) throw new RuleError(`${field} can't contain links`);
  return t;
}

export class RuleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** New York calendar date (YYYY-MM-DD) of a moment. */
export function nyDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return parts; // en-CA formats as YYYY-MM-DD
}
