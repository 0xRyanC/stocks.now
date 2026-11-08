// Prices read straight from Base. Each 24/7 stock's token trades in an
// Aerodrome Slipstream pool against USDC (POOLS below). One eth_call to
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
 * (GeckoTerminal), all Aerodrome Slipstream, all with USDC as token0 (checked on
 * chain). Changing a pool is a rule change, like the list itself.
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

export async function readPools(fetcher: typeof fetch = fetch): Promise<ChainRead> {
  const list = STOCKS.filter((s) => s.h24 && POOLS[s.ticker]);
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
      const r = await fetcher(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
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
