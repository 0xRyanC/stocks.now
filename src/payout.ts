// Real 1F916 payouts for funded accounts (Season 1). Pure: no database, no network,
// so every rule here is tested in test/payout.test.ts.
//
// A funded AI plays with the same 100,000 play 1F916 as everyone (1 token = 1 game
// cent), and the Reserve sets aside 100,000 real 1F916 in its name. Each Monday bell it
// is paid its week's gain to a new high, one token per game cent, capped per week. At the
// season's end it is paid what is left of its stake. Losses go back to the Reserve.
//
// The payout value is not the account's displayed value. It is a REPLAY of the AI's
// filled orders at prices nobody can game:
// - an order on a market-hours stock that filled at a stale close (the market was shut)
//   re-fills at the first exchange price recorded after it, i.e. the next open. So
//   buying on after-hours news at yesterday's close earns nothing extra.
// - an order on a thin pool (THIN_POOLS) fills, and a holding is valued, at the
//   average of that stock's recorded prices over the 30 minutes before. So pushing one
//   pool for one block earns nothing.
// Everything else replays at its real fill price and is valued at the bell's price.

import { floorShares } from "./engine.ts";

export const STAKE = 100_000; // real 1F916 set aside per funded AI, = its play start in game cents
export const WEEKLY_CAP = 50_000; // most real 1F916 one AI can be paid in one week
export const THIN_WINDOW_MS = 30 * 60_000;

export interface FilledOrder {
  id: number;
  ticker: string;
  side: "buy" | "sell";
  cents: number | null; // buy: amount spent
  shares: number | null; // sell: shares sold
  fill_price: number; // dollars per share, as filled
  filled_at: number; // ms
  fill_how: string | null; // "close" = a market-hours stock filled at a stale close
}

/** Recorded prices, so the replay can look things up. Each returns null if nothing is recorded. */
export interface Prices {
  /** The first price whose own time is after `ms` (the next open, for a market-hours stock). */
  firstAfter(ticker: string, ms: number): number | null;
  /** The average of the prices recorded in (ms - window, ms]. */
  averageBefore(ticker: string, ms: number, windowMs: number): number | null;
  /** The latest price recorded at or before `ms`. */
  at(ticker: string, ms: number): number | null;
}

/**
 * The price an order replays at, or null if it can't be replayed yet (a stale-close
 * order whose market hasn't opened by `until`): then it is left out, as if not placed.
 */
export function replayPrice(o: FilledOrder, prices: Prices, thin: ReadonlySet<string>, until: number): number | null {
  if (o.fill_how === "close") {
    const open = prices.firstAfter(o.ticker, o.filled_at);
    return open !== null && open > 0 && o.filled_at < until ? open : null;
  }
  if (thin.has(o.ticker)) return prices.averageBefore(o.ticker, o.filled_at, THIN_WINDOW_MS) ?? o.fill_price;
  return o.fill_price;
}

/** The value of a holding at `when`, for payouts: thin pools at their 30-minute average. */
export function holdingPrice(ticker: string, prices: Prices, thin: ReadonlySet<string>, when: number): number {
  const p = thin.has(ticker) ? prices.averageBefore(ticker, when, THIN_WINDOW_MS) ?? prices.at(ticker, when) : prices.at(ticker, when);
  return p ?? 0;
}

/**
 * The payout value of an account at `when`, in game cents (= real 1F916): start with
 * `start` cents, replay every order filled up to `when` in order, value what's held.
 */
export function replayValue(start: number, orders: FilledOrder[], prices: Prices, thin: ReadonlySet<string>, when: number): number {
  let cash = start;
  const held = new Map<string, number>();
  for (const o of [...orders].filter((x) => x.filled_at <= when).sort((a, b) => a.filled_at - b.filled_at || a.id - b.id)) {
    const p = replayPrice(o, prices, thin, when);
    if (p === null) continue;
    if (o.side === "buy") {
      const c = o.cents ?? 0;
      cash -= c;
      held.set(o.ticker, (held.get(o.ticker) ?? 0) + floorShares(c / 100 / p));
    } else {
      const s = Math.min(o.shares ?? 0, held.get(o.ticker) ?? 0);
      held.set(o.ticker, (held.get(o.ticker) ?? 0) - s);
      cash += Math.floor(s * p * 100 + 1e-6);
    }
  }
  let v = cash;
  for (const [t, s] of held) if (s > 0) v += s * holdingPrice(t, prices, thin, when) * 100;
  return Math.floor(v + 1e-6);
}

/** One Monday's payout: the gain to a new high, capped. The high-water mark rises with the value. */
export function weeklyPay(value: number, highWater: number): { pay: number; highWaterAfter: number } {
  const gain = Math.max(0, value - highWater);
  return { pay: Math.min(WEEKLY_CAP, gain), highWaterAfter: Math.max(highWater, value) };
}

/** The season's last payout: what's left of the stake, never more than the stake and never below 0. */
export function seasonEndPay(value: number): number {
  return Math.max(0, Math.min(STAKE, value));
}
