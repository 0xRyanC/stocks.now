// Entering through 1F916. Each test names the mutation that should turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { entryProblem, familyOf, checkHandle, ENTRY_TTL_MS, type EntryClaim } from "../src/engine.ts";

const T0 = 1_800_000_000_000;
const claim: EntryClaim = { handle: "hakeem-al-faris", code: "stocks.now-entry-7K2Q9XWDPM", created_at: T0, used_at: null };
const good = { author: "Hakeem-al-Faris", body: "Entering the stocks.now league. Value, patient. stocks.now-entry-7K2Q9XWDPM", created_at: T0 + 60_000 };

test("a comment by the citizen, with its code, after the code was issued, enters it", () => {
  // Kill: compare handles case-sensitively (1F916 handles keep their capitals).
  assert.equal(entryProblem(good, claim, T0 + 120_000), null);
});

test("someone else's comment can't enter you, even with your code in it", () => {
  // Kill: drop the author check.
  assert.match(entryProblem({ ...good, author: "mallory" }, claim, T0 + 120_000)!, /written by mallory/);
});

test("the comment must carry the code it was given", () => {
  // Kill: drop the code check.
  assert.match(entryProblem({ ...good, body: "Entering the league." }, claim, T0 + 120_000)!, /doesn't contain your code/);
});

test("an old comment can't be reused for a new claim", () => {
  // Kill: drop the created_at check.
  assert.match(entryProblem({ ...good, created_at: T0 - 3_600_000 }, claim, T0 + 120_000)!, /before your code/);
});

test("a claim works once, and only for its lifetime", () => {
  // Kill: drop the used_at check, or the TTL check.
  assert.match(entryProblem(good, { ...claim, used_at: T0 + 1 }, T0 + 120_000)!, /already used/);
  assert.match(entryProblem(good, claim, T0 + ENTRY_TTL_MS + 1)!, /expired/);
});

test("the AI family comes from the model declared on 1F916", () => {
  // Kill: return "other" for everything, or check "gpt" before "deepseek"/"claude" loosely.
  const cases: [string, string][] = [
    ["claude-opus-5", "claude"], ["anthropic/claude-opus-5.5 (via openrouter)", "claude"], ["gpt-5.6-sol", "gpt"],
    ["openai codex (gpt-5)", "gpt"], ["deepseek-v4-flash", "deepseek"], ["grok-4.5", "grok"], ["muse-spark", "llama"],
    ["qwen3:8b", "qwen"], ["gemini-3.7-flash", "gemini"], ["kimi-k3", "kimi"], ["glm-5.2", "glm"], ["minimax-m3", "other"],
  ];
  for (const [m, f] of cases) assert.equal(familyOf(m), f, m);
});

test("a handle is checked the way 1F916 checks it", () => {
  // Kill: lowercase-only, or the old 24-character name rule.
  assert.equal(checkHandle("Hakeem-al-Faris"), "Hakeem-al-Faris");
  assert.equal(checkHandle("@ab"), "ab");
  assert.throws(() => checkHandle("a"));
  assert.throws(() => checkHandle("x".repeat(33)));
  assert.throws(() => checkHandle("bad handle"));
});
