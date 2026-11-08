// How a price record is built from the two sources. Each test names the
// mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTick, MIN_POOL_USD, type ExchangeQuote, type BaseQuote } from "../src/prices.ts";
import { firstEligible } from "../src/engine.ts";

const NOW = Date.UTC(2026, 10, 8, 18, 0, 0); // a Sunday
const NOW_S = NOW / 1000;
const FRI_CLOSE = Date.UTC(2026, 10, 6, 21, 0, 0) / 1000;
const x = (price: number, prev = price): ExchangeQuote => ({ price, t: FRI_CLOSE, prev, sessionStart: FRI_CLOSE - 23400, sessionEnd: FRI_CLOSE });
const b = (price: number, poolUsd = 500_000): BaseQuote => ({ price, poolUsd, src: "g" });

test("a 24/7 stock is priced from its token on Base, stamped now, so a weekend order on it can fill", () => {
  // Kill: price h24 stocks from the exchange, or stamp them with the exchange time.
  const { data } = buildTick({ AAPL: x(342.37, 344.17) }, { AAPL: b(343.11) }, null, NOW);
  assert.deepEqual(data.AAPL, [343.11, NOW_S, 342.37, "b", 342.37]);
  const placed = NOW - 60_000;
  const hit = firstEligible({ id: 1, ticker: "AAPL", side: "buy", placed_at: placed }, [{ id: 7, recorded_at: NOW, data }]);
  assert.equal(hit?.quote[0], 343.11);
});

test("a market-hours stock never takes a Base price, even if one is offered", () => {
  // Kill: let any stock with a Base price use it.
  const { data } = buildTick({ PM: x(197.88, 196) }, { PM: b(2996.99) }, null, NOW);
  assert.deepEqual(data.PM, [197.88, FRI_CLOSE, 196, "x"]);
  // ...so a weekend order on it waits: the price is from before the order.
  const hit = firstEligible({ id: 2, ticker: "PM", side: "buy", placed_at: NOW - 60_000 }, [{ id: 8, recorded_at: NOW, data }]);
  assert.equal(hit, null);
});

test("a thin pool's price is held back and the stock keeps its last quote", () => {
  // Kill: drop the MIN_POOL_USD check.
  const last = { NVDA: [186.64, FRI_CLOSE, 185, "x"] as any };
  // A sensible price, so only the pool size can stop it.
  const { data, held } = buildTick({ NVDA: x(186.64) }, { NVDA: b(187, MIN_POOL_USD - 1) }, last, NOW);
  assert.deepEqual(data.NVDA, last.NVDA);
  assert.deepEqual(held, ["NVDA"]);
});

test("a Base price far from the stock's exchange price is held back", () => {
  // Kill: drop the MAX_GAP check.
  const last = { NVDA: [186.64, FRI_CLOSE, 185, "x"] as any };
  const { data, held } = buildTick({ NVDA: x(186.64) }, { NVDA: b(186.64 * 1.2) }, last, NOW);
  assert.deepEqual(data.NVDA, last.NVDA);
  assert.deepEqual(held, ["NVDA"]);
  const ok = buildTick({ NVDA: x(186.64) }, { NVDA: b(186.64 * 1.1) }, last, NOW);
  assert.equal(ok.data.NVDA[3], "b");
});

test("a stock with no price this time keeps its last quote, with its old time", () => {
  // Kill: drop the carry-over, or re-stamp carried quotes with the current time.
  const last = { MSFT: [530.61, NOW_S - 300, 529, "b", 530.61] as any, AMC: [3.14, FRI_CLOSE, 3.1, "x"] as any };
  const { data } = buildTick({}, {}, last, NOW);
  assert.deepEqual(data.MSFT, last.MSFT);
  assert.deepEqual(data.AMC, last.AMC);
});

test("while the US market is open, a 24/7 stock's previous close is yesterday's, not the live price", () => {
  // Kill: always use the latest exchange price as the previous close.
  const open = Date.UTC(2026, 10, 9, 16, 0, 0);
  const q: ExchangeQuote = { price: 345, t: open / 1000 - 30, prev: 342.37, sessionStart: open / 1000 - 5400, sessionEnd: open / 1000 + 18000 };
  const { data } = buildTick({ AAPL: q }, { AAPL: b(345.2) }, null, open);
  assert.equal(data.AAPL[2], 342.37);
  assert.equal(data.AAPL[4], 345);
});
