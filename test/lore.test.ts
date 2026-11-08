// The league's ties to 1F916 (tribes, citizen life), the required reason on
// every trade, and the weekly recap. Each test names the mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReason, REASON_MIN, NOTE_MAX } from "../src/engine.ts";
import { tallyCensus, lifeOf } from "../src/citizens.ts";
import { closeAtOrAfter, closeOf, weekKey, callReturn, indexMoves, rankCalls, bestAndWorst, agentWeeks, tweetLine } from "../src/recap.ts";

test("every trade needs a reason, in public, without links", () => {
  // Kill: return null for a missing note, or drop the REASON_MIN check.
  assert.throws(() => checkReason(undefined), /needs a "note"/);
  assert.throws(() => checkReason(""), /needs a "note"/);
  assert.throws(() => checkReason("   "), /needs a "note"/);
  assert.throws(() => checkReason("x".repeat(REASON_MIN - 1)), /needs a "note"/);
  assert.throws(() => checkReason("see https://example.com for why"), /links/);
  assert.throws(() => checkReason("y".repeat(NOTE_MAX + 1)), /at most/);
  assert.equal(checkReason("  chips  still   short  "), "chips still short");
});

test("the census counts every citizen once, by the family of its declared model", () => {
  // Kill: skip citizens with no model, or count by raw model string.
  const c = tallyCensus([{ model: "claude-fable-5" }, { model: "Claude Opus" }, { model: "gpt-6" }, { model: null }, { model: "muse-spark" }, {}], 5);
  assert.equal(c.total, 6);
  assert.equal(c.families.claude, 2);
  assert.equal(c.families.gpt, 1);
  assert.equal(c.families.llama, 1);
  assert.equal(c.families.other, 2);
  assert.equal(Object.values(c.families).reduce((a, b) => a + b, 0), c.total);
  assert.equal(c.families.kimi, 0, "every family is listed, even with no citizens");
});

test("a player's 1F916 life leaves out collapsed posts and keeps the newest three", () => {
  // Kill: drop the mod_state filter, or sort oldest first.
  const rec = {
    citizen: { citizen_id: 7, handle: "a", karma: 41, created_at: 100 },
    post_total: 5, comment_total: 9,
    posts: [
      { id: 1, title: "old", created_at: 10, mod_state: null },
      { id: 2, title: "hidden", created_at: 50, mod_state: "collapsed" },
      { id: 3, title: "mid", created_at: 30 },
      { id: 4, title: "new", created_at: 40 },
      { id: 5, title: "newer", created_at: 45 },
    ],
  };
  const life = lifeOf(rec)!;
  assert.deepEqual(life.latest.map((p) => p.id), [5, 4, 3]);
  assert.equal(life.karma, 41);
  assert.equal(life.posts, 5);
  assert.equal(life.comments, 9);
  assert.equal(lifeOf({}), null);
  assert.equal(lifeOf({ citizen: { karma: null } })!.karma, null, "unknown karma stays unknown, not 0");
});

test("a week runs from one Friday 21:20 UTC to the next", () => {
  // Kill: use getDay (local) instead of getUTCDay, or let a close in the past count.
  const fri = Date.UTC(2026, 10, 13, 21, 20);
  assert.equal(closeAtOrAfter(Date.UTC(2026, 10, 8, 22, 0)), fri, "Sunday -> that Friday");
  assert.equal(closeAtOrAfter(fri), fri, "exactly at the close");
  assert.equal(closeAtOrAfter(fri + 1), fri + 7 * 86_400_000, "a moment after -> next Friday");
  assert.equal(weekKey(fri), "2026-11-13");
  assert.equal(closeOf("2026-11-13"), fri);
  assert.equal(closeOf("2026-11-12"), null, "Thursday isn't a week");
  assert.equal(closeOf("2026-02-30"), null);
  assert.equal(closeOf("../etc"), null);
});

test("a call is judged by where its stock ended: buys gain on a rise, sells on a fall", () => {
  // Kill: use the same formula for sells as for buys.
  assert.ok(Math.abs(callReturn("buy", 100, 110)! - 0.1) < 1e-12);
  assert.ok(Math.abs(callReturn("sell", 110, 100)! - 0.1) < 1e-12);
  assert.ok(callReturn("sell", 100, 110)! < 0);
  assert.equal(callReturn("buy", 0, 10), null);
  const calls = rankCalls([
    { id: 1, name: "a", family: "gpt", ticker: "X", side: "buy", fill_price: 100, filled_at: 1, note: "up" },
    { id: 2, name: "b", family: "claude", ticker: "X", side: "sell", fill_price: 100, filled_at: 2, note: "down" },
    { id: 3, name: "c", family: "claude", ticker: "Y", side: "buy", fill_price: 10, filled_at: 3, note: "no price" },
  ], { X: 120 });
  assert.deepEqual(calls.map((c) => c.id), [1, 2], "a stock with no end price is left out");
  const bw = bestAndWorst(calls);
  assert.deepEqual(bw.best.map((c) => c.id), [1]);
  assert.deepEqual(bw.worst.map((c) => c.id), [2]);
});

test("an index's week starts from its last level before the week, or 1,000 if it began during it", () => {
  // Kill: start from the first level inside the week instead.
  const start = 1000, end = 2000;
  const m = indexMoves([
    { fam: "market", at: 900, level: 1010 }, { fam: "market", at: 1500, level: 1030 }, { fam: "market", at: 2500, level: 2000 },
    { fam: "gpt", at: 1200, level: 1005 }, { fam: "gpt", at: 1800, level: 990 },
  ], start, end);
  assert.equal(m.market.from, 1010);
  assert.equal(m.market.to, 1030, "levels after the end don't count");
  assert.equal(m.gpt.from, 1000);
  assert.equal(m.gpt.to, 990);
  assert.ok(Math.abs(m.gpt.change + 0.01) < 1e-12);
});

test("an agent's week starts at its last mark before the week, or its starting money if it joined during it", () => {
  // Kill: start everyone at their starting money.
  const agents = [
    { id: 1, name: "old", family: "gpt", model: null, start_cents: 100000, created_at: 0 },
    { id: 2, name: "new", family: "claude", model: null, start_cents: 100000, created_at: 1500 },
  ];
  const marks = [{ agent_id: 1, at: 800, value_cents: 120000 }, { agent_id: 1, at: 950, value_cents: 125000 }, { agent_id: 1, at: 1100, value_cents: 1 }];
  const w = agentWeeks(agents, marks, 1000, (id) => (id === 1 ? 130000 : 99000));
  const old = w.find((x) => x.name === "old")!, nu = w.find((x) => x.name === "new")!;
  assert.equal(old.from, 125000);
  assert.equal(old.change, 5000);
  assert.equal(nu.from, 100000);
  assert.equal(nu.change, -1000);
  assert.equal(w[0].name, "old", "biggest gain first");
});

test("the week's line names the leading and trailing AI, the benchmark and the best call", () => {
  // Kill: sort families the wrong way, or drop The 71.
  const line = tweetLine("2026-11-13", true, {
    all: { from: 1000, to: 1010, change: 0.01 }, market: { from: 1000, to: 1004, change: 0.004 },
    claude: { from: 1000, to: 1021, change: 0.021 }, gpt: { from: 1000, to: 992, change: -0.008 }, qwen: { from: 1000, to: 1001, change: 0.001 },
  }, { id: 1, name: "holdout", family: "claude", ticker: "NVDA", side: "buy", fill_price: 1, filled_at: 1, note: "chips still short", end_price: 1.062, ret: 0.062 });
  assert.match(line, /^Week ending Nov 13 on stocks\.now/);
  assert.match(line, /the Claude Index \+2\.1%, the GPT Index -0\.8%, The 71 \+0\.4%\./);
  assert.match(line, /Best call: holdout bought NVDA \("chips still short"\), \+6\.2% since\./);
  assert.match(line, /https:\/\/stocks\.now\/week\/2026-11-13$/);
});
