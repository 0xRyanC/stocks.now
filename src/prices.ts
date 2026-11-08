// Price recording. Every 5 minutes, day and night, we read two kinds of price
// and save them as one record (a "tick"):
//
// - Base: the token's own market price on Base, for the stocks whose token has
//   a real trading pool there (h24 in stocks.ts). These trade 24/7, like the
//   tokens themselves. Read from GeckoTerminal, with DEX Screener as backup.
// - Exchange: the stock's regular-market price on its US exchange, for the
//   rest. These only move while the US market is open. Read from Yahoo Finance.
//
// Each stock always uses the same kind of price, so nobody can trade the jump
// between the two.

import { STOCKS } from "./stocks.ts";
import type { Quote, TickData } from "./engine.ts";

export const SOURCE = "base: GeckoTerminal token price (DEX Screener backup) · exchange: Yahoo Finance regularMarketPrice";
export const QUOTE_FORMAT = "TICKER: [price, price_time_unix_seconds, previous_close, venue (b = token on Base, x = US exchange), exchange_price]";
const UA = "Mozilla/5.0 (compatible; stocks-now-league/1.0; +https://stocks.now)";

/** A token's pool must hold at least this much (in dollars) for its price to count. */
export const MIN_POOL_USD = 25_000;
/** A Base price more than this far from the stock's last exchange price is held back. */
export const MAX_GAP = 0.15;

export interface ExchangeQuote { price: number; t: number; prev: number | null; sessionStart: number | null; sessionEnd: number | null }
export interface BaseQuote { price: number; poolUsd: number; src: "g" | "d" }

/** Yahoo Finance: regular-market price of every stock, 20 per request. */
export async function fetchExchange(fetcher: typeof fetch = fetch): Promise<Record<string, ExchangeQuote>> {
  const tickers = STOCKS.map((s) => s.ticker);
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += 20) chunks.push(tickers.slice(i, i + 20));
  const out: Record<string, ExchangeQuote> = {};
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.join(",")}&range=1d&interval=1d`;
      const r = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!r.ok) return;
      const j = (await r.json()) as any;
      for (const res of j?.spark?.result ?? []) {
        const m = res?.response?.[0]?.meta;
        const price = Number(m?.regularMarketPrice);
        const t = Number(m?.regularMarketTime);
        const prev = Number(m?.chartPreviousClose ?? m?.previousClose);
        const reg = m?.currentTradingPeriod?.regular;
        if (res?.symbol && price > 0 && t > 0) {
          out[res.symbol] = { price, t, prev: prev > 0 ? prev : null, sessionStart: Number(reg?.start) || null, sessionEnd: Number(reg?.end) || null };
        }
      }
    } catch { /* that chunk's stocks keep their last price */ }
  }));
  return out;
}

/** Token prices on Base for the 24/7 stocks: GeckoTerminal first, DEX Screener for anything it misses. */
export async function fetchBase(fetcher: typeof fetch = fetch): Promise<Record<string, BaseQuote>> {
  const list = STOCKS.filter((s) => s.h24);
  const byAddr = new Map(list.map((s) => [s.contract.toLowerCase(), s.ticker]));
  const out: Record<string, BaseQuote> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < list.length; i += 30) chunks.push(list.slice(i, i + 30).map((s) => s.contract.toLowerCase()));

  await Promise.all(chunks.map(async (addrs) => {
    try {
      const r = await fetcher(`https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${addrs.join(",")}`, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!r.ok) return;
      const j = (await r.json()) as any;
      for (const d of j?.data ?? []) {
        const a = d?.attributes;
        const t = byAddr.get(String(a?.address).toLowerCase());
        const price = Number(a?.price_usd), pool = Number(a?.total_reserve_in_usd);
        if (t && price > 0) out[t] = { price, poolUsd: pool > 0 ? pool : 0, src: "g" };
      }
    } catch { /* fall through to the backup */ }
  }));

  const missing = list.filter((s) => !out[s.ticker]).map((s) => s.contract.toLowerCase());
  for (let i = 0; i < missing.length; i += 30) {
    try {
      const r = await fetcher(`https://api.dexscreener.com/tokens/v1/base/${missing.slice(i, i + 30).join(",")}`, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!r.ok) continue;
      const pairs = (await r.json()) as any[];
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const t = byAddr.get(String(p?.baseToken?.address).toLowerCase());
        const price = Number(p?.priceUsd), pool = Number(p?.liquidity?.usd);
        if (!t || !(price > 0)) continue;
        if (!out[t] || (out[t].src === "d" && pool > out[t].poolUsd)) out[t] = { price, poolUsd: pool > 0 ? pool : 0, src: "d" };
      }
    } catch { /* those stocks keep their last price */ }
  }
  return out;
}

/** The close an exchange price is compared against: yesterday's while the market is open, today's after. */
function lastClose(x: ExchangeQuote, nowSec: number): number | null {
  const inSession = x.sessionStart !== null && x.sessionEnd !== null && nowSec >= x.sessionStart && nowSec < x.sessionEnd;
  return inSession ? x.prev : x.price;
}

/**
 * Build one price record from what was read. Pure: no network, so it can be tested.
 * A stock that got no usable price this time keeps its last quote, with its old
 * price time, so orders on it keep waiting instead of filling at a stale price.
 */
export function buildTick(
  exchange: Record<string, ExchangeQuote>,
  base: Record<string, BaseQuote>,
  last: TickData | null,
  nowMs: number,
): { data: TickData; held: string[] } {
  const nowSec = Math.floor(nowMs / 1000);
  const data: TickData = {};
  const held: string[] = [];
  for (const s of STOCKS) {
    const x = exchange[s.ticker];
    const prevQ = last?.[s.ticker];
    let q: Quote | null = null;
    if (s.h24) {
      const b = base[s.ticker];
      // Compare against the exchange: live while the market is open, else its last close.
      const ref = x?.price ?? (prevQ?.[4] ?? null);
      const close = x ? lastClose(x, nowSec) : (prevQ?.[2] ?? null);
      if (b && b.poolUsd >= MIN_POOL_USD && ref && Math.abs(b.price / ref - 1) <= MAX_GAP) {
        q = [round6(b.price), nowSec, close, "b", ref];
      } else if (b) held.push(s.ticker);
    } else if (x) {
      q = [x.price, x.t, x.prev, "x"];
    }
    if (q) data[s.ticker] = q;
    else if (prevQ) data[s.ticker] = prevQ;
  }
  return { data, held };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** True when at least one stock has a newer price time than in the last record. */
export function hasNewPrices(next: TickData, last: TickData | null): boolean {
  if (!last) return Object.keys(next).length > 0;
  for (const [t, q] of Object.entries(next)) {
    const p = last[t];
    if (!p || q[1] > p[1]) return true;
  }
  return false;
}
