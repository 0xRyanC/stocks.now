// Price recording. Every few minutes while the US market is open, read the
// regular-market price of all 71 stocks and save them as one record (a "tick").
// Source: Yahoo Finance's public quote endpoint, 20 symbols per request.

import { STOCKS } from "./stocks.ts";
import type { TickData } from "./engine.ts";

export const SOURCE = "yahoo-spark-v7 regularMarketPrice";
const UA = "Mozilla/5.0 (compatible; stocks-now-league/1.0; +https://stocks.now)";

export async function fetchQuotes(fetcher: typeof fetch = fetch): Promise<{ data: TickData; missing: string[] }> {
  const tickers = STOCKS.map((s) => s.ticker);
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += 20) chunks.push(tickers.slice(i, i + 20));
  const data: TickData = {};
  await Promise.all(chunks.map(async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.join(",")}&range=1d&interval=5m`;
    const r = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!r.ok) throw new Error(`price source answered ${r.status} for ${chunk[0]}..`);
    const j = (await r.json()) as any;
    for (const res of j?.spark?.result ?? []) {
      const m = res?.response?.[0]?.meta;
      const price = Number(m?.regularMarketPrice);
      const t = Number(m?.regularMarketTime);
      const prev = Number(m?.chartPreviousClose ?? m?.previousClose);
      if (res?.symbol && price > 0 && t > 0) data[res.symbol] = [price, t, prev > 0 ? prev : null];
    }
  }));
  const missing = tickers.filter((t) => !data[t]);
  return { data, missing };
}

/** True when at least one stock has a newer market time than in the last record. */
export function hasNewPrices(next: TickData, last: TickData | null): boolean {
  if (!last) return Object.keys(next).length > 0;
  for (const [t, q] of Object.entries(next)) {
    const p = last[t];
    if (!p || q[1] > p[1]) return true;
  }
  return false;
}
