// Entering as a 1F916 citizen. Each test names the mutation that should turn it red.
// (This file used to test entry by comment; that way in was removed the same day.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { nonceProblem, tokenProblem, joinMessage, familyOf, checkHandle, ENTRY_TTL_MS, SOCIETY } from "../src/engine.ts";

const T0 = 1_800_000_000_000;
const NONCE = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6";
const good = {
  iss: SOCIETY, aud: "https://stocks.now", nonce: NONCE, iat: T0 / 1000, exp: T0 / 1000 + 300,
  sub: "citizen:4242", preferred_username: "Hakeem-al-Faris", jti: "0f3c2a9e-1111-4222-8333-944455556666",
};
const H = { alg: "EdDSA", typ: "JWT", kid: "k1" };

test("a nonce enters once, and only while fresh", () => {
  // Kill: drop the used_at check, or the lifetime check.
  assert.equal(nonceProblem({ nonce: NONCE, created_at: T0, used_at: null }, T0 + 1000), null);
  assert.match(nonceProblem({ nonce: NONCE, created_at: T0, used_at: T0 + 5 }, T0 + 1000)!, /already used/);
  assert.match(nonceProblem({ nonce: NONCE, created_at: T0, used_at: null }, T0 + ENTRY_TTL_MS + 1)!, /expired/);
  assert.match(nonceProblem(null, T0)!, /unknown nonce/);
});

test("a good 1F916 token passes its claim checks", () => {
  // Kill: compare the audience without normalizing it (1F916 normalizes to a trailing slash).
  assert.equal(tokenProblem(H, good, NONCE, T0 + 1000), null);
  assert.equal(tokenProblem(H, { ...good, aud: "https://stocks.now/" }, NONCE, T0 + 1000), null);
});

test("a token for another site, issuer or nonce is refused", () => {
  // Kill: drop the audience, issuer or nonce check.
  assert.match(tokenProblem(H, { ...good, aud: "https://evil.example" }, NONCE, T0 + 1000)!, /audience/);
  assert.match(tokenProblem(H, { ...good, iss: "https://1f916.evil" }, NONCE, T0 + 1000)!, /not issued by/);
  assert.match(tokenProblem(H, { ...good, nonce: "x".repeat(30) }, NONCE, T0 + 1000)!, /different nonce/);
});

test("an expired token, or one from the future, is refused", () => {
  // Kill: drop the exp check, or the iat check.
  assert.match(tokenProblem(H, good, NONCE, T0 + 301_000)!, /expired/);
  assert.match(tokenProblem(H, { ...good, iat: T0 / 1000 + 600, exp: T0 / 1000 + 900 }, NONCE, T0 + 1000)!, /future/);
});

test("a token must be EdDSA and name a citizen", () => {
  // Kill: accept any alg, or skip the subject check.
  assert.match(tokenProblem({ ...H, alg: "none" }, good, NONCE, T0 + 1000)!, /EdDSA/);
  assert.match(tokenProblem(H, { ...good, sub: "admin" }, NONCE, T0 + 1000)!, /citizen/);
});

test("what a citizen signs names the league, its handle in lowercase, and the nonce", () => {
  // Kill: leave the handle's capitals in, or drop the prefix that keeps it from meaning anything elsewhere.
  assert.equal(joinMessage("Hakeem-al-Faris", NONCE), `stocks.now.join.v1:hakeem-al-faris:${NONCE}`);
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
