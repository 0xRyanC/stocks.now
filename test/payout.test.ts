// Real 1F916 payouts: the replay that decides what a funded AI is paid. Each test names
// the mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { replayPrice, replayValue, weeklyPay, seasonEndPay, holdingPrice, STAKE, WEEKLY_CAP, type FilledOrder, type Prices } from "../src/payout.ts";

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 9, 15, 0); // Mon Nov 9, 10 am New York
const THIN = new Set(["NIO"]);

// A tiny price record: ticker -> [[price time ms, price], ...] in time order.
function book(rec: Record<string, [number, number][]>): Prices {
  return {
    firstAfter: (t, ms) => (rec[t] ?? []).find(([at]) => at > ms)?.[1] ?? null,
    averageBefore: (t, ms, w) => {
      const xs = (rec[t] ?? []).filter(([at]) => at > ms - w && at <= ms).map(([, p]) => p);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },
    at: (t, ms) => [...(rec[t] ?? [])].reverse().find(([at]) => at <= ms)?.[1] ?? null,
  };
}
const buy = (id: number, ticker: string, cents: number, price: number, at: number, how: string | null = null): FilledOrder =>
  ({ id, ticker, side: "buy", cents, shares: null, fill_price: price, filled_at: at, fill_how: how });
const sell = (id: number, ticker: string, shares: number, price: number, at: number, how: string | null = null): FilledOrder =>
  ({ id, ticker, side: "sell", cents: null, shares, fill_price: price, filled_at: at, fill_how: how });

test("an ordinary fill replays at its own price and is valued at the bell", () => {
  // Kill: value holdings at the fill price instead of the price at `when`.
  const prices = book({ AAPL: [[T0, 270], [T0 + 2 * H, 297]] });
  const v = replayValue(STAKE, [buy(1, "AAPL", 27_000, 270, T0)], prices, THIN, T0 + 3 * H);
  assert.equal(v, 73_000 + 29_700); // $270 buys 1 share, worth $297 at the bell
});

test("a stale-close buy re-fills at the next open, so after-hours news earns nothing extra", () => {
  // Kill: replay fill_how='close' orders at their own (stale) fill price.
  const fri = Date.UTC(2026, 10, 13, 21, 0), sat = fri + 20 * H, monOpen = Date.UTC(2026, 10, 16, 14, 31);
  const prices = book({ RDDT: [[fri, 200], [monOpen, 230]] });
  const o = buy(1, "RDDT", 23_000, 200, sat, "close"); // bought at Friday's close after the news
  assert.equal(replayPrice(o, prices, THIN, monOpen + H), 230);
  // Replayed at the open: $230 buys exactly 1 share, worth $230. No free 15% (at $200 it would be $264.50).
  assert.equal(replayValue(STAKE, [o], prices, THIN, monOpen + H), STAKE);
});

test("a stale-close order whose market hasn't opened yet is left out of the replay", () => {
  // Kill: fall back to the stale fill price when there's no open yet.
  const fri = Date.UTC(2026, 10, 13, 21, 0), sat = fri + 20 * H;
  const prices = book({ RDDT: [[fri, 200]] });
  const o = buy(1, "RDDT", 20_000, 200, sat, "close");
  assert.equal(replayPrice(o, prices, THIN, sat + H), null);
  assert.equal(replayValue(STAKE, [o], prices, THIN, sat + H), STAKE);
});

test("a thin pool fills and is valued at its 30-minute average, so a one-block push pays nothing", () => {
  // Kill: drop the THIN_POOLS branch in replayPrice, or in holdingPrice.
  const prices = book({ NIO: [[T0 - 20 * 60_000, 6], [T0 - 10 * 60_000, 6], [T0, 3], [T0 + H - 20 * 60_000, 6], [T0 + H - 10 * 60_000, 6], [T0 + H, 12]] });
  // Someone dumps the pool to $3, buys $600 of NIO, then pumps it to $12 at the bell.
  const o = buy(1, "NIO", 60_000, 3, T0);
  assert.equal(replayPrice(o, prices, THIN, T0 + H), 5); // (6 + 6 + 3) / 3
  assert.equal(holdingPrice("NIO", prices, THIN, T0 + H), 8); // (6 + 6 + 12) / 3
  // Replay: 120 shares at $5, worth $8 each = $960, not the $2,400 the push aimed for.
  assert.equal(replayValue(STAKE, [o], prices, THIN, T0 + H), 40_000 + 96_000);
});

test("a sell can't sell more than the replay holds", () => {
  // Kill: sell o.shares without the min(...) against replay holdings.
  const prices = book({ NIO: [[T0 - 10 * 60_000, 5], [T0, 5], [T0 + H, 5]] });
  const orders = [buy(1, "NIO", 50_000, 5, T0), sell(2, "NIO", 1_000_000, 5, T0 + H)];
  assert.equal(replayValue(STAKE, orders, prices, THIN, T0 + H), STAKE);
});

test("weekly pay is the gain to a new high, capped, and the high-water rises", () => {
  // Kill: pay value - start instead of value - highWater, or drop the cap.
  assert.deepEqual(weeklyPay(108_000, 100_000), { pay: 8_000, highWaterAfter: 108_000 });
  assert.deepEqual(weeklyPay(104_000, 108_000), { pay: 0, highWaterAfter: 108_000 }, "below the high: nothing");
  assert.deepEqual(weeklyPay(300_000, 100_000), { pay: WEEKLY_CAP, highWaterAfter: 300_000 });
});

test("season end pays what's left of the stake, never more and never below zero", () => {
  // Kill: pay the full value, or let a negative value through.
  assert.equal(seasonEndPay(90_000), 90_000);
  assert.equal(seasonEndPay(130_000), STAKE);
  assert.equal(seasonEndPay(-5), 0);
});
