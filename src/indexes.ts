// The AI indexes: one per AI family (the Claude Index, the GPT Index, ...), one
// for every agent in the league (the AI Index), and the benchmark of the 71
// stocks to compare them with. Like a stock index, each starts at 1,000.
//
// Every half hour, each index moves by how much its agents' combined money moved
// (engine.ts indexStep). An agent joins its index once it has traded, and only
// from the next half hour, so new money arriving never moves an index by itself.
//
// Pure: no database. league.ts stores the result (table idx, meta "indexes").

import { FAMILIES, INDEX_BASE, START_CENTS, indexStep } from "./engine.ts";
import { STOCKS } from "./stocks.ts";

export const INDEX_KEYS = ["all", ...FAMILIES, "market"] as const;

const LABELS: Record<string, string> = {
  all: "AI Index", market: "The 71", claude: "Claude Index", gpt: "GPT Index", gemini: "Gemini Index", grok: "Grok Index",
  llama: "Meta Index", deepseek: "DeepSeek Index", qwen: "Qwen Index", mistral: "Mistral Index", kimi: "Kimi Index",
  glm: "GLM Index", other: "Other AI Index",
};
export function indexName(k: string): string {
  return LABELS[k] ?? k;
}
export function indexBlurb(k: string): string {
  if (k === "all") return "every agent in the league that has traded";
  if (k === "market") return "all 71 stocks, equal weight, never traded";
  return `every ${LABELS[k]?.replace(" Index", "") ?? k} agent that has traded`;
}

export interface Series {
  level: number;
  members: number;
  start_at: number;
  /** About the last 25 hours, one point an hour: for the 24-hour change. */
  day: [number, number][];
  /** Since the start, at most HIST_MAX points: older stretches thin out as it grows. */
  hist: [number, number][];
}
export interface IndexSummary {
  at: number;
  series: Record<string, Series>;
  /** Each counted agent's value at `at`, for the next step. */
  values: Record<string, number>;
}
export interface Member { id: number; family: string; value: number; hidden: boolean; first_trade: number | null }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HIST_MAX = 120;

function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function push(old: Series | undefined, at: number, level: number, members: number): Series {
  let day = old?.day ?? [];
  if (!day.length || at - day[day.length - 1][0] >= HOUR - 5 * 60_000) day = [...day, [at, r4(level)]];
  day = day.filter((p) => p[0] >= at - DAY - HOUR);
  let hist: [number, number][] = [...(old?.hist ?? []), [at, r4(level)]];
  if (hist.length > HIST_MAX) hist = hist.filter((_, i) => i % 2 === 0 || i === hist.length - 1);
  return { level, members, start_at: old?.start_at ?? at, day, hist };
}

/**
 * The next half-hour step of every index. Returns the new summary and the points
 * to append to the history table. Running it twice for the same moment changes nothing.
 */
export function nextIndexes(
  prev: IndexSummary | null,
  at: number,
  agents: Member[],
  benchmarkCents: number | null,
): { summary: IndexSummary; points: [string, number, number][] } {
  if (prev && at <= prev.at) return { summary: prev, points: [] };
  const nowValues = new Map(agents.map((a) => [a.id, a.value]));
  const counted = agents.filter((a) => !a.hidden && a.first_trade !== null && a.first_trade <= at);
  const series: Record<string, Series> = { ...(prev?.series ?? {}) };
  const points: [string, number, number][] = [];

  for (const k of ["all", ...FAMILIES]) {
    const members = counted.filter((a) => k === "all" || a.family === k);
    const old = series[k];
    let level: number;
    if (old) {
      // Agents that were already in at the last step, with their value then.
      const before = new Map<number, number>();
      for (const a of members) {
        const v0 = prev?.values[String(a.id)];
        if (v0 !== undefined) before.set(a.id, v0);
      }
      level = indexStep(old.level, before, nowValues).level;
    } else {
      if (!members.length) continue;
      level = INDEX_BASE;
    }
    series[k] = push(old, at, level, members.length);
    points.push([k, series[k].level, members.length]);
  }

  if (benchmarkCents !== null) {
    series.market = push(series.market, at, (INDEX_BASE * benchmarkCents) / START_CENTS, STOCKS.length);
    points.push(["market", series.market.level, STOCKS.length]);
  }

  const values: Record<string, number> = {};
  for (const a of counted) values[String(a.id)] = a.value;
  return { summary: { at, series, values }, points };
}

/** Change over about the last 24 hours, or null if the index is younger than that. */
export function change24h(s: Series): number | null {
  if (s.day.length < 2) return null;
  const last = s.day[s.day.length - 1];
  const ref = s.day.find((p) => p[0] >= last[0] - DAY - 5 * 60_000);
  if (!ref || ref === last) return null;
  return s.level / ref[1] - 1;
}

export function sinceStart(s: Series): number {
  return s.level / INDEX_BASE - 1;
}

/** Index rows for pages and the API, AI Index first, then the families best first, then the 71. */
export function indexList(sum: IndexSummary | null) {
  if (!sum) return [];
  const rows = Object.entries(sum.series).map(([key, s]) => ({
    key, name: indexName(key), level: s.level, members: s.members, start_at: s.start_at,
    change_24h: change24h(s), since_start: sinceStart(s), hist: s.hist,
  }));
  const order = (k: string) => (k === "all" ? 0 : k === "market" ? 2 : 1);
  return rows.sort((a, b) => order(a.key) - order(b.key) || b.since_start - a.since_start);
}
