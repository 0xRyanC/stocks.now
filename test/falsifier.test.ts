// The falsifier kit: planted attacks the league must reject.
//
// Each test is one attack on the record, written as the attacker would try it.
// A green test means the rule held. A test marked `todo` is a known gap: it
// asserts the rule we want, it fails today, and node:test reports it without
// failing the suite, so the gap stays visible until someone closes it.
// Spec and pass/fail criteria: FALSIFIERS.md. Live check of the public record:
// scripts/witness.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstEligible, weekScore, accountValue, nonceProblem, START_CENTS, ENTRY_TTL_MS,
  type Tick, type PendingOrder,
} from "../src/engine.ts";
import { buildTick, instantQuote, MAX_GAP, type ExchangeQuote } from "../src/prices.ts";
import type { ChainRead } from "../src/onchain.ts";

const order = (placed_at: number, ticker = "NVDA"): PendingOrder => ({ id: 1, ticker, side: "buy", placed_at });
const tick = (id: number, recorded_at: number, price: number, priceTimeSec: number, ticker = "NVDA"): Tick =>
  ({ id, recorded_at, data: { [ticker]: [price, priceTimeSec, 100] } });

// ---------- F1 backdated call ----------

test("F1a backdate: a price recorded at the same millisecond as the order can't fill it", () => {
  // Attack: land the order exactly on a tick's recorded_at so `<` vs `<=` decides it.
  const t0 = 1_794_200_000_000;
  const hit = firstEligible(order(t0), [tick(1, t0, 90, t0 / 1000 + 1), tick(2, t0 + 300_000, 95, t0 / 1000 + 299)]);
  assert.equal(hit?.tick.id, 2);
});

test("F1b backdate: ticks recorded before the order never fill it, however many there are", () => {
  const t0 = 1_794_200_000_000;
  const early = Array.from({ length: 50 }, (_, i) => tick(i + 1, t0 - (50 - i) * 1000, 50 + i, t0 / 1000 + 10));
  assert.equal(firstEligible(order(t0), early), null);
});

// ---------- F2 as-of vs visible ----------

test("F2a as-of: a tick recorded after the order but carrying a price from before it can't fill it", () => {
  // Attack (muse-relit c137318): the print became visible after the order, but it was already true while the order was written.
  const t0 = 1_794_200_000_000;
  const hit = firstEligible(order(t0), [tick(1, t0 + 60_000, 90, t0 / 1000 - 1), tick(2, t0 + 360_000, 96, t0 / 1000 + 300)]);
  assert.equal(hit?.tick.id, 2);
});

test("F2b as-of: a price time in the same second as the order, but earlier in it, can't fill it", () => {
  // Price times are whole seconds; orders are milliseconds. 12:00:00.000 is before 12:00:00.536.
  const t0 = 1_794_200_000_536;
  const sec = Math.floor(t0 / 1000);
  assert.equal(firstEligible(order(t0), [tick(1, t0 + 60_000, 90, sec)]), null);
  assert.equal(firstEligible(order(t0), [tick(1, t0 + 60_000, 90, sec + 1)])?.tick.id, 1);
});

// ---------- F3 stale price ----------

const POOL = "0xpool";
const chain = (ticker: string, price: number, poolUsd: number, timeSec: number): ChainRead =>
  ({ block: 1, time: timeSec, rpc: "test", pools: { [ticker]: { price, poolUsd, pool: POOL } } });

test("F3a stale: a price record that held a stock's last quote can't fill an order placed after that quote", () => {
  // Attack: the pool goes thin, buildTick carries the old quote forward; does a new order fill at the old price?
  const t0 = 1_794_200_000_000;
  const old = { AAPL: [340, t0 / 1000 - 600, 339, "b", 339, 1] as any };
  const { data, held } = buildTick({}, chain("AAPL", 360, 10, t0 / 1000 + 290), old, t0 + 300_000);
  assert.deepEqual(held, ["AAPL"]);
  assert.equal(firstEligible(order(t0, "AAPL"), [{ id: 9, recorded_at: t0 + 300_000, data }]), null);
});

const SESSION_NOW = Date.UTC(2026, 10, 10, 16, 0, 0); // Tuesday 11 am New York, in session
const S = SESSION_NOW / 1000;
const xq = (price: number, ageSec: number): ExchangeQuote =>
  ({ price, t: S - ageSec, prev: price, sessionStart: S - 5400, sessionEnd: S + 18000 });

test("F3b stale: an in-session exchange quote 20 minutes old must not fill an order now", { todo: "instantQuote has no freshness bound on x.t; propose MAX_QUOTE_AGE (e.g. 120 s) in session" }, () => {
  // Attack: the exchange source answers with an old regularMarketPrice while the market is moving.
  const q = instantQuote(false, "PFE", null, xq(25, 1200), null, SESSION_NOW, true);
  assert.equal(q, null);
});

test("F3c stale: a Base read whose block is minutes old must not fill an order now", { todo: "instantQuote doesn't compare base.time to now; a lagging RPC serves an old slot0" }, () => {
  const q = instantQuote(true, "AAPL", chain("AAPL", 340, 500_000, S - 600), xq(340, 10), null, SESSION_NOW, true);
  assert.equal(q, null);
});

// ---------- F4 dropped loss / reset ----------

test("F4a reset: a loss, then winning it back, scores nothing; only new highs score", () => {
  let hw = START_CENTS;
  const weeks = [80_000, 100_000, 110_000, 90_000, 110_000];
  const scores = weeks.map((v) => { const r = weekScore(v, hw); hw = r.highWaterAfter; return r.score; });
  assert.deepEqual(scores, [0, 0, 10_000, 0, 0]);
});

test("F4b hide: moving money into pending orders doesn't change an account's value", () => {
  // Attack: park the losing position in a pending sell over the bell so it isn't marked.
  const prices = { NVDA: 50 };
  const held = accountValue(10_000, [{ ticker: "NVDA", shares: 100, cost_cents: 1_000_000 }], [], prices);
  const parked = accountValue(10_000, [], [{ ticker: "NVDA", side: "sell", cents: null, shares: 100 }], prices);
  assert.equal(parked, held);
});

test("F4c hide: a holding with no price must not count as zero silently", { todo: "accountValue prices a missing ticker at 0; a dropped quote turns into a phantom loss (or a hidden one on a short-like flow). Propose: last known price, or throw" }, () => {
  assert.throws(() => accountValue(0, [{ ticker: "GONE", shares: 10, cost_cents: 1000 }], [], {}));
});

// ---------- F5 boundary race ----------

test("F5a race: two orders in the same millisecond share the same first print", () => {
  // MarxSignal c137428: same second, one print. Answer: both take it; neither waits.
  const t0 = 1_794_200_000_000;
  const ticks = [tick(1, t0 + 1, 100, t0 / 1000 + 1), tick(2, t0 + 300_000, 105, t0 / 1000 + 300)];
  assert.equal(firstEligible({ ...order(t0), id: 1 }, ticks)?.tick.id, 1);
  assert.equal(firstEligible({ ...order(t0), id: 2 }, ticks)?.tick.id, 1);
});

test("F5b race: ticks out of recording order can't let a later, better print win", { todo: "defense in depth only: the live path is safe (settle's SQL orders by recorded_at, id), but firstEligible trusts its caller's order" }, () => {
  // firstEligible trusts its input order. A caller that hands it ticks newest-first would fill at the last print.
  const t0 = 1_794_200_000_000;
  const asc = [tick(1, t0 + 1000, 100, t0 / 1000 + 1), tick(2, t0 + 300_000, 80, t0 / 1000 + 300)];
  assert.equal(firstEligible(order(t0), asc)?.tick.id, 1);
  assert.equal(firstEligible(order(t0), [...asc].reverse())?.tick.id, 1, "firstEligible must sort or reject unsorted ticks");
});

// ---------- F6 reference revision ----------

test("F6 revision: a later corrected print for the same moment doesn't move a fill already chosen", () => {
  // atlas-ocelot c136656 / skitter c136977: corrections stand beside the call; they don't reprice it.
  const t0 = 1_794_200_000_000;
  const first = tick(1, t0 + 1000, 100, t0 / 1000 + 1);
  const revised = tick(2, t0 + 2000, 93, t0 / 1000 + 1); // same price time, new number
  assert.equal(firstEligible(order(t0), [first, revised])?.quote[0], 100);
});

// ---------- F7 manipulated pool ----------

test("F7 push: one block's pool price pushed 14% from the stock must not set a fill", { todo: "README help-wanted #1: a time-weighted pool price. Today a single slot0 within MAX_GAP (15%) fills" }, () => {
  const ref = 340;
  const pushed = ref * (1 + MAX_GAP - 0.01);
  const q = instantQuote(true, "AAPL", chain("AAPL", pushed, 500_000, S - 1), xq(ref, 10), null, SESSION_NOW, true);
  assert.equal(q, null);
});

// ---------- F8 replayed entry ----------

test("F8 replay: a used or expired join nonce can't mint a second league key", () => {
  const now = 1_794_200_000_000;
  assert.match(String(nonceProblem({ nonce: "n", created_at: now - 1000, used_at: now - 500 }, now)), /already used/);
  assert.match(String(nonceProblem({ nonce: "n", created_at: now - ENTRY_TTL_MS - 1, used_at: null }, now)), /expired/);
  assert.equal(nonceProblem({ nonce: "n", created_at: now - 1000, used_at: null }, now), null);
});
