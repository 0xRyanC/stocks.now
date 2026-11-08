// The AI indexes. Each test names the mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { indexStep } from "../src/engine.ts";
import { nextIndexes, change24h, type Member } from "../src/indexes.ts";

const H = 3_600_000;
const m = (id: number, family: string, value: number, first_trade: number | null = 0, hidden = false): Member => ({ id, family, value, hidden, first_trade });

test("an index moves by its agents' combined money", () => {
  // Kill: average the agents' returns instead of adding up their money.
  const r = indexStep(1000, new Map([[1, 100_000], [2, 300_000]]), new Map([[1, 150_000], [2, 300_000]]));
  assert.equal(r.level, 1000 * 450_000 / 400_000); // 1125, not the 1250 an average of returns gives
});

test("a new agent's fresh $1,000 doesn't move the index", () => {
  // Kill: count agents that weren't in the index at the last step.
  const s0 = nextIndexes(null, 1 * H, [m(1, "claude", 100_000)], null).summary;
  const s1 = nextIndexes(s0, 2 * H, [m(1, "claude", 90_000), m(2, "claude", 100_000, 1.5 * H)], null).summary;
  assert.equal(s1.series.claude.level, 900); // agent 1 lost 10%; agent 2 doesn't dilute it
  assert.equal(s1.series.claude.members, 2);
  const s2 = nextIndexes(s1, 3 * H, [m(1, "claude", 90_000), m(2, "claude", 110_000, 1.5 * H)], null).summary;
  assert.ok(Math.abs(s2.series.claude.level - 900 * 200_000 / 190_000) < 1e-9); // from now on agent 2 counts
});

test("an agent that hasn't traded is not in any index", () => {
  // Kill: drop the first_trade check.
  const s = nextIndexes(null, H, [m(1, "gpt", 100_000, null)], null).summary;
  assert.equal(s.series.gpt, undefined);
  assert.equal(s.series.all, undefined);
});

test("a hidden agent drops out without moving the index", () => {
  // Kill: keep hidden agents in.
  const s0 = nextIndexes(null, H, [m(1, "grok", 100_000), m(2, "grok", 100_000)], null).summary;
  const s1 = nextIndexes(s0, 2 * H, [m(1, "grok", 100_000), m(2, "grok", 5_000, 0, true)], null).summary;
  assert.equal(s1.series.grok.level, 1000);
});

test("the AI Index counts every family; each family index only its own", () => {
  // Kill: let a family index include other families' agents.
  const s0 = nextIndexes(null, H, [m(1, "claude", 100_000), m(2, "gpt", 100_000)], null).summary;
  const s1 = nextIndexes(s0, 2 * H, [m(1, "claude", 120_000), m(2, "gpt", 100_000)], null).summary;
  assert.equal(s1.series.claude.level, 1200);
  assert.equal(s1.series.gpt.level, 1000);
  assert.equal(s1.series.all.level, 1100);
});

test("running the same half hour twice changes nothing", () => {
  // Kill: drop the at <= prev.at guard.
  const s0 = nextIndexes(null, H, [m(1, "claude", 100_000)], null).summary;
  const again = nextIndexes(s0, H, [m(1, "claude", 200_000)], null);
  assert.equal(again.points.length, 0);
  assert.equal(again.summary.series.claude.level, 1000);
});

test("the 24-hour change compares with about a day ago", () => {
  // Kill: compare with the first point ever, or the previous half hour.
  let s = nextIndexes(null, 0, [m(1, "claude", 100_000)], 100_000).summary;
  for (let t = 1; t <= 60; t++) s = nextIndexes(s, t * H, [m(1, "claude", 100_000 + t * 1000)], 100_000).summary;
  const ch = change24h(s.series.claude)!;
  assert.ok(Math.abs(ch - (160_000 / 136_000 - 1)) < 1e-3, String(ch));
  assert.equal(s.series.market.level, 1000);
});
