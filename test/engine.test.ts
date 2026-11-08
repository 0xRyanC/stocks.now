// The rules that decide money in the game. Each test names the mutation that
// should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstEligible, sharesFor, proceedsFor, accountValue, weekScore, median, checkName, checkFamily, checkText, nyDate,
  type Tick,
} from "../src/engine.ts";

const T = (id: number, recorded_at: number, price: number, mtSec: number): Tick => ({ id, recorded_at, data: { NVDA: [price, mtSec, 100] } });

test("a fill uses the first price recorded after the order", () => {
  // Kill: change `<=` to `<` on recorded_at, or return the last tick instead of the first.
  const placed = 1_000_000;
  const ticks = [T(1, 900_000, 90, 899), T(2, 1_000_000, 95, 999), T(3, 1_200_000, 100, 1_199), T(4, 1_500_000, 110, 1_499)];
  const hit = firstEligible({ id: 9, ticker: "NVDA", side: "buy", placed_at: placed }, ticks);
  assert.equal(hit?.tick.id, 3);
  assert.equal(hit?.quote[0], 100);
});

test("a price whose own market time is before the order never fills it (no weekend fill at Friday's close)", () => {
  // Kill: delete the market-time check in firstEligible.
  const placed = 2_000_000;
  const ticks = [T(5, 2_100_000, 100, 1_500), T(6, 2_400_000, 104, 2_399)];
  const hit = firstEligible({ id: 1, ticker: "NVDA", side: "buy", placed_at: placed }, ticks);
  assert.equal(hit?.tick.id, 6);
});

test("no eligible price means no fill", () => {
  assert.equal(firstEligible({ id: 1, ticker: "NVDA", side: "buy", placed_at: 5_000 }, [T(1, 4_000, 1, 3)]), null);
  assert.equal(firstEligible({ id: 1, ticker: "TSLA", side: "buy", placed_at: 1 }, [T(1, 4_000, 1, 3)]), null);
});

test("buys round shares down and sells round cash down", () => {
  // Kill: Math.floor -> Math.round in either function.
  assert.equal(sharesFor(10_000, 3), 33.33333333);
  assert.equal(proceedsFor(0.333, 1.0), 33);
  assert.equal(proceedsFor(2, 186.255), 37251);
});

test("value counts cash, holdings at the latest price, and what pending orders set aside", () => {
  // Kill: drop the pending-order loop in accountValue.
  const v = accountValue(50_000, [{ ticker: "NVDA", shares: 2, cost_cents: 30_000 }], [
    { ticker: "AAPL", side: "buy", cents: 10_000, shares: null },
    { ticker: "TSLA", side: "sell", cents: null, shares: 1 },
  ], { NVDA: 200, TSLA: 300, AAPL: 100 });
  assert.equal(v, 50_000 + 40_000 + 10_000 + 30_000);
});

test("Friday scores count new highs only", () => {
  // Kill: score = value - start instead of value - high water.
  let hw = 100_000;
  const weeks = [110_000, 100_000, 110_000, 120_000];
  const scores: number[] = [];
  for (const v of weeks) {
    const r = weekScore(v, hw);
    scores.push(r.score);
    hw = r.highWaterAfter;
  }
  assert.deepEqual(scores, [10_000, 0, 0, 10_000]);
  assert.equal(hw, 120_000);
});

test("family standing is the median, not the mean", () => {
  assert.equal(median([0.01, 0.02, 5]), 0.02);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([]), null);
});

test("names, families and public text are checked", () => {
  assert.equal(checkName("  Claude-Trader "), "claude-trader");
  assert.throws(() => checkName("ab"));
  assert.throws(() => checkName("admin"));
  assert.throws(() => checkName("1f916-agent"));
  assert.throws(() => checkName("<script>"));
  assert.equal(checkFamily("Claude"), "claude");
  assert.throws(() => checkFamily("skynet"));
  assert.throws(() => checkText("buy at https://x.com", 280, "note"));
  assert.throws(() => checkText("see marx.finance", 280, "note"));
  assert.equal(checkText("  momentum\n play ", 280, "note"), "momentum play");
  assert.equal(checkText("", 280, "note"), null);
});

test("New York date", () => {
  assert.equal(nyDate(Date.parse("2026-11-07T03:00:00Z")), "2026-11-06");
  assert.equal(nyDate(Date.parse("2026-11-09T15:00:00Z")), "2026-11-09");
});
