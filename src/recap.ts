// The week on stocks.now: one recap a week, from one Monday opening bell
// (9:30 am New York time) to the next. Wall Street sleeps all weekend; the
// league doesn't, and the week is scored when the bell rings. Pure functions;
// league.ts loads the rows and pages.ts draws the page.

import { INDEX_BASE } from "./engine.ts";

const DAY = 86_400_000;

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/**
 * 9:30 am New York time on the date `key` (YYYY-MM-DD), in UTC ms: 14:30 UTC
 * under standard time, 13:30 UTC under daylight time. Null for a malformed date.
 */
export function bellOn(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  for (const h of ["14", "13"]) {
    const t = Date.parse(`${key}T${h}:30:00Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== key) return null; // e.g. Feb 30
    const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === key && p.hour === "09" && p.minute === "30") return t;
  }
  return null;
}

/** The weekly close at or after `ms`: the next Monday opening bell, 9:30 am New York time. */
export function closeAtOrAfter(ms: number): number {
  const d = new Date(ms);
  for (let i = -1; i <= 8; i++) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i));
    if (day.getUTCDay() !== 1) continue;
    const t = bellOn(day.toISOString().slice(0, 10));
    if (t !== null && t >= ms) return t;
  }
  throw new Error("no Monday bell within 8 days");
}

/** A week is named by the date of its closing Monday, e.g. "2026-11-16". */
export function weekKey(closeMs: number): string {
  return new Date(closeMs).toISOString().slice(0, 10);
}

/** The close of the week named `key`, or null if `key` isn't a Monday. */
export function closeOf(key: string): number | null {
  const t = bellOn(key);
  if (t === null || new Date(t).getUTCDay() !== 1) return null;
  return t;
}

/** A season's first close: the first Monday bell at least six days after it starts, so week one is a full week. */
export function firstClose(seasonStart: number): number {
  return closeAtOrAfter(seasonStart + 6 * DAY);
}

/** The week in progress at `now`: never earlier than the season's first close. */
export function currentClose(now: number, seasonStart: number | null): number {
  return closeAtOrAfter(seasonStart === null ? now : Math.max(now, firstClose(seasonStart)));
}

/** The close of the week before the one closing at `end` (a week isn't always 7 x 24 hours: daylight time). */
export function prevClose(end: number): number {
  return closeOf(weekKey(end - 7 * DAY))!;
}

/** How good a call turned out: a buy gains when the price rises after it, a sell when the price falls after it. */
export function callReturn(side: string, fillPrice: number, endPrice: number): number | null {
  if (!(fillPrice > 0) || !(endPrice > 0)) return null;
  return side === "buy" ? endPrice / fillPrice - 1 : fillPrice / endPrice - 1;
}

export interface Move { from: number; to: number; change: number }

/**
 * Each index's move over [start, end]. It starts from its last level at or before
 * `start`, or from 1,000 if it began during the week.
 */
export function indexMoves(rows: { fam: string; at: number; level: number }[], start: number, end: number): Record<string, Move> {
  const out: Record<string, Move> = {};
  const byFam = new Map<string, { at: number; level: number }[]>();
  for (const r of rows) (byFam.get(r.fam) ?? byFam.set(r.fam, []).get(r.fam)!).push(r);
  for (const [fam, list] of byFam) {
    list.sort((a, b) => a.at - b.at);
    const before = list.filter((r) => r.at <= start);
    const upTo = list.filter((r) => r.at <= end);
    if (!upTo.length) continue;
    const to = upTo[upTo.length - 1].level;
    if (!before.length && upTo[0].at <= start) continue;
    const from = before.length ? before[before.length - 1].level : INDEX_BASE;
    out[fam] = { from, to, change: to / from - 1 };
  }
  return out;
}

export interface Call {
  id: number; name: string; family: string; ticker: string; side: string;
  fill_price: number; filled_at: number; note: string | null; end_price: number; ret: number;
}

/** The week's calls, best first: every fill, judged by where its stock ended the week. */
export function rankCalls(fills: any[], endPrices: Record<string, number>): Call[] {
  const calls: Call[] = [];
  for (const f of fills) {
    const end = endPrices[f.ticker];
    const ret = callReturn(f.side, f.fill_price, end);
    if (ret === null) continue;
    calls.push({ id: f.id, name: f.name, family: f.family, ticker: f.ticker, side: f.side, fill_price: f.fill_price, filled_at: f.filled_at, note: f.note ?? null, end_price: end, ret });
  }
  return calls.sort((a, b) => b.ret - a.ret || a.filled_at - b.filled_at);
}

/** Best and worst calls without showing one call twice. */
export function bestAndWorst(calls: Call[], n = 3): { best: Call[]; worst: Call[] } {
  const best = calls.filter((c) => c.ret > 0).slice(0, n);
  const taken = new Set(best.map((c) => c.id));
  const worst = calls.filter((c) => c.ret < 0 && !taken.has(c.id)).reverse().slice(0, n);
  return { best, worst };
}

export interface AgentWeek { id: number; name: string; family: string; model: string | null; from: number; to: number; change: number; pct: number; score: number | null }

/**
 * Each agent's week: from its value at the start (its last half-hour mark at or
 * before it, or its starting money if it joined during the week) to its value at the end.
 */
export function agentWeeks(
  agents: { id: number; name: string; family: string; model: string | null; start_cents: number; created_at: number }[],
  marks: { agent_id: number; at: number; value_cents: number }[],
  start: number,
  endValue: (id: number) => number | null,
  scores: Map<number, number> = new Map(),
): AgentWeek[] {
  const lastBefore = new Map<number, { at: number; v: number }>();
  for (const m of marks) {
    if (m.at > start) continue;
    const cur = lastBefore.get(m.agent_id);
    if (!cur || m.at > cur.at) lastBefore.set(m.agent_id, { at: m.at, v: m.value_cents });
  }
  const out: AgentWeek[] = [];
  for (const a of agents) {
    const to = endValue(a.id);
    if (to === null) continue;
    const from = lastBefore.get(a.id)?.v ?? a.start_cents;
    out.push({ id: a.id, name: a.name, family: a.family, model: a.model, from, to, change: to - from, pct: from ? to / from - 1 : 0, score: scores.get(a.id) ?? null });
  }
  return out.sort((x, y) => y.change - x.change || x.name.localeCompare(y.name));
}

const LABEL: Record<string, string> = {
  all: "AI Index", market: "The 71", claude: "Claude Index", gpt: "GPT Index", gemini: "Gemini Index", grok: "Grok Index",
  llama: "Meta Index", deepseek: "DeepSeek Index", qwen: "Qwen Index", mistral: "Mistral Index", kimi: "Kimi Index", glm: "GLM Index", other: "Other AIs Index",
};

function signedPct(x: number): string {
  const v = Number((x * 100).toFixed(1));
  return (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(1) + "%";
}

/** One line to post about the week: the leading and trailing AI family, the do-nothing benchmark, and the best call. */
export function tweetLine(key: string, closed: boolean, moves: Record<string, Move>, best: Call | null): string {
  const day = new Date(Date.parse(key + "T12:00:00Z")).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fams = Object.entries(moves).filter(([k]) => k !== "all" && k !== "market").sort((a, b) => b[1].change - a[1].change);
  const parts: string[] = [];
  if (fams.length) parts.push(`the ${LABEL[fams[0][0]] ?? fams[0][0]} ${signedPct(fams[0][1].change)}`);
  if (fams.length > 1) parts.push(`the ${LABEL[fams[fams.length - 1][0]] ?? fams[fams.length - 1][0]} ${signedPct(fams[fams.length - 1][1].change)}`);
  if (moves.market) parts.push(`The 71 ${signedPct(moves.market.change)}`);
  const head = `${closed ? "Week ending" : "Week to"} ${day} on stocks.now, where AI agents trade tokenized stocks on Base:`;
  let line = parts.length ? `${head} ${parts.join(", ")}.` : `${head} no AI has traded yet.`;
  if (best) {
    const note = best.note ? ` ("${best.note.length > 90 ? best.note.slice(0, 87).trimEnd() + "..." : best.note}")` : "";
    line += ` Best call: ${best.name} ${best.side === "buy" ? "bought" : "sold"} ${best.ticker}${note}, ${signedPct(best.ret)} since.`;
  }
  return `${line} https://stocks.now/week/${key}`;
}
