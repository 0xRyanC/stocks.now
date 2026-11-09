// Prices read straight from Base. Each 24/7 stock's token trades in an
// Aerodrome Slipstream pool against USDC (POOLS below; two Slipstream factories,
// 0x9cb22058... for the first 28 and 0xf8f2eb49... for the 18 added on 8 November). One eth_call to
// Multicall3 reads, at a single block: the block number and time, and for each
// pool its current price (slot0) and how much USDC and token it holds.
//
// Anyone can re-check a price: call slot0() on the pool at the same block.
//   price = 10^(8-6) / (sqrtPriceX96 / 2^96)^2   when USDC is token0 (all of these)

import { STOCKS } from "./stocks.ts";

export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const USDC_DECIMALS = 6;
const TOKEN_DECIMALS = 8; // every Coinbase tokenized stock on Base

/**
 * Each 24/7 token's main pool on Base: the deepest USDC pool on 8 November 2026
 * (GeckoTerminal), all Aerodrome Slipstream, all with USDC as token0 and the
 * Coinbase token as token1 (both checked on chain). Changing a pool is a rule
 * change, like the list itself.
 */
export const POOLS: Record<string, string> = {
  AAOI: "0xfb35d41801893197b5a4d477d0bf6737d2ad6106", AAPL: "0xf5fcb9cdafce67d50afef298f88e709d2b946ba6",
  AMD: "0x138cb591c4a7d854d796e1906af8228d84cb7642", AMZN: "0x532e0f46d1e528507fc9454d5847c231f23bddf6",
  AVGO: "0x086a1447d0851f0aea9d09d6c547fec8e97be413", BE: "0xde2bfe5409ad9e825cdb3562a06edafb9d753dfc",
  CRCL: "0x294666ad6a415e8c33af801225c04079bb4f1133", CRWV: "0x4d942b4239e0894e5a80ca2b3944e3467f4ee464",
  GOOGL: "0x16c70f04c3080a127486cdf5a4c33c066bbf47c3", HIMS: "0x41d7793faa4ca181b6f021423ff3f9015c00b2ff",
  INTC: "0x3d384288fa79b51de882b06b617ab7989ccad4f3", LITE: "0x16b8228cd097865d8f5a534b95e42e17d84551b0",
  LLY: "0x2b7ee4623ec6afbc1e587b2668c0ed8f3ff44949", META: "0xd072410fa13d242e1d53721bcf7af02e3455dc96",
  MRNA: "0x4ae3780242f43ef63c471fb8c2e9d30ec5fd5821", MRVL: "0x611ab290422d534d9595b01e648911fefa963137",
  MSFT: "0x2740c0faab738f6e346e545fde02aef9b1a01ee7", MSTR: "0x66dcd42e6314b287110922ae36cb2a8bdeecc153",
  MU: "0x41e21950362b1014bc629252ecfff8fca5f1646c", NFLX: "0x67ba8dbedc6d7f93f0f5967aa2420715f1edc756",
  NVDA: "0xf668e21993f0acd7ab00bb1cfbaed0df28a3c8ec", ORCL: "0x62b5452e80e50b047dcf6dd3fb6a1d266c678eb5",
  PLTR: "0xa0473ced0cd1bfb857e3e04b5fa4b6af18c5e44d", SKHY: "0xebc746a47ebb274de1dbdc9a465e6c5c2301c5da",
  SNDK: "0x2836e062a3fe75943a7f4a552e2365b98e414e75", SPCX: "0x880db7dda4407d99508574e680d067d1164b3cfe",
  TSLA: "0x7a33000372f3f028f074182ccb9d16cbeefbf920", TTWO: "0x18907cae5a9c7b45f85c5d2e1f7508c27c134f83",
  // Added 8 November 2026, 23:30 UTC, before any citizen had entered: pools from the
  // second Slipstream factory, each holding about $45,000-$65,000 and priced within 10%
  // of the stock's Friday close. New and lightly traded, so the same checks guard them.
  ARM: "0x9a0f4fd0766ccdb792ba58fe631aa7720097623c", BIDU: "0xd47b8f13ffc3198148b138d3f07cc89c92042950",
  BILI: "0x32a3ce6c3a8d6c24c4a51a5cf2869410cbf4d637", BUD: "0x5ee52963d3d33196a47fad722abb897e0fa395d9",
  HSAI: "0xdc8d2c31de17bf4df00c05e4e132bcea22f24c3b", INFY: "0x356cc16fe38a6ad0eb25e655759dd963f8d674bf",
  LI: "0xd71b2d9cb3532477df77ae26e780963cce784a0c", NIO: "0x484cc2ca594ced3fe38362fe950c60ce66f53f6d",
  NOK: "0xc541eac49f32d46c1e2f88952f22215ef0f2db71", NVO: "0xc1ba39d668f14eee2462ca5877402e4a7c4d1f34",
  PDD: "0x84608be6d655ee05032303fe7f0d6f3a51c2cf51", SAN: "0xe531069df73530bf59c954f3718945d5faa2e7df",
  SAP: "0x21313a06b7f8ed38d8bc1fb8be2fbd847634a6ec", SE: "0x0274e5078033cb3fe788cf76bb97150fd9bc4547",
  SONY: "0x26dd2ac81ea9a212afc84848893edc21c5a76fdc", UL: "0x013fcb940735d17c81d3b91557acc62da723d9d5",
  VALE: "0x0f48336b76ee52fa6bb19edf5af358529df57574", WRD: "0xbc440aff9a79cced69d5b21c7b71e60bd0278efb",
};

/** Public Base RPC endpoints, tried in order. */
export const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];

const SEL = { slot0: "3850c7bd", balanceOf: "70a08231", getBlockNumber: "42cbb15c", getTimestamp: "0f28c97d", aggregate3: "82ad56cb" };

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** ABI-encode Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[]). */
export function encodeAggregate3(calls: { target: string; data: string }[]): string {
  const elems = calls.map((c) => {
    const data = c.data.replace(/^0x/, "");
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(len / 32) * 64, "0");
    return addrWord(c.target) + word(1) + word(0x60) + word(len) + padded;
  });
  let offsets = "", at = calls.length * 32;
  for (const e of elems) { offsets += word(at); at += e.length / 2; }
  return "0x" + SEL.aggregate3 + word(0x20) + word(calls.length) + offsets + elems.join("");
}

/** Decode aggregate3's (bool success, bytes returnData)[]. */
export function decodeAggregate3(hex: string): { ok: boolean; data: string }[] {
  const h = hex.replace(/^0x/, "");
  const at = (byte: number) => Number(BigInt("0x" + h.slice(byte * 2, byte * 2 + 64)));
  const arr = at(0);
  const n = at(arr);
  const base = arr + 32;
  const out: { ok: boolean; data: string }[] = [];
  for (let i = 0; i < n; i++) {
    const el = base + at(base + i * 32);
    const ok = at(el) === 1;
    const dataAt = el + at(el + 32);
    const len = at(dataAt);
    out.push({ ok, data: h.slice((dataAt + 32) * 2, (dataAt + 32 + len) * 2) });
  }
  return out;
}

/** USDC per token from a Slipstream pool whose token0 is USDC. */
export function priceFromSqrt(sqrtPriceX96: bigint): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const raw = r * r; // token raw units per USDC raw unit
  return 10 ** (TOKEN_DECIMALS - USDC_DECIMALS) / raw;
}

export interface PoolRead { price: number; poolUsd: number; pool: string }
export interface ChainRead { block: number; time: number; pools: Record<string, PoolRead>; rpc: string }

export async function readPools(fetcher: typeof fetch = fetch, only?: string[]): Promise<ChainRead> {
  const list = STOCKS.filter((s) => s.h24 && POOLS[s.ticker] && (!only || only.includes(s.ticker)));
  const calls: { target: string; data: string }[] = [
    { target: MULTICALL3, data: SEL.getBlockNumber },
    { target: MULTICALL3, data: SEL.getTimestamp },
  ];
  for (const s of list) {
    const pool = POOLS[s.ticker];
    calls.push(
      { target: pool, data: SEL.slot0 },
      { target: USDC, data: SEL.balanceOf + addrWord(pool) },
      { target: s.contract, data: SEL.balanceOf + addrWord(pool) },
    );
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"] });
  let lastErr = "";
  for (const rpc of RPCS) {
    try {
      const r = await fetcher(rpc, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
      if (!r.ok) { lastErr = `${rpc} ${r.status}`; continue; }
      const j = (await r.json()) as any;
      if (!j?.result || j.result === "0x") { lastErr = `${rpc} ${JSON.stringify(j?.error ?? j).slice(0, 120)}`; continue; }
      const res = decodeAggregate3(j.result);
      const big = (i: number, w = 0) => BigInt("0x" + (res[i]?.data.slice(w * 64, w * 64 + 64) || "0"));
      const block = Number(big(0)), time = Number(big(1));
      if (!(block > 0 && time > 0)) { lastErr = `${rpc} no block`; continue; }
      const pools: Record<string, PoolRead> = {};
      list.forEach((s, k) => {
        const i = 2 + k * 3;
        if (!res[i]?.ok || !res[i + 1]?.ok || !res[i + 2]?.ok) return;
        const sqrt = big(i) & ((1n << 160n) - 1n);
        if (sqrt === 0n) return;
        const price = priceFromSqrt(sqrt);
        const usdc = Number(big(i + 1)) / 10 ** USDC_DECIMALS;
        const tokens = Number(big(i + 2)) / 10 ** TOKEN_DECIMALS;
        pools[s.ticker] = { price, poolUsd: usdc + tokens * price, pool: POOLS[s.ticker] };
      });
      return { block, time, pools, rpc };
    } catch (e: any) {
      lastErr = `${rpc} ${String(e?.message || e)}`;
    }
  }
  throw new Error("no Base RPC answered: " + lastErr);
}

/** The 1F916 token on Base (18 decimals). */
export const TOKEN_1F916 = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";

/** An ERC-20 balance, in whole tokens (rounded down), read through the public RPCs. Null if none answered. */
export async function tokenBalance(token: string, holder: string, decimals = 18, fetcher: typeof fetch = fetch): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(holder)) return null;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x" + SEL.balanceOf + addrWord(holder) }, "latest"] });
  for (const rpc of RPCS) {
    try {
      const r = await fetcher(rpc, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as any;
      if (typeof j?.result === "string" && j.result.length >= 3) return Number(BigInt(j.result) / 10n ** BigInt(decimals));
    } catch { /* next RPC */ }
  }
  return null;
}
