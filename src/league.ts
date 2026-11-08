// The league against the database: joining, orders, fills, price records,
// Friday results and the public reads. Rules come from engine.ts.

import {
  START_CENTS, MIN_ORDER_CENTS, MAX_PENDING, MAX_ORDERS_PER_DAY, NOTE_MAX,
  RuleError, checkName, checkFamily, checkText, firstEligible, sharesFor, proceedsFor,
  floorShares, accountValue, weekScore, nyDate,
  type TickData, type Tick, type Holding, type OpenOrder,
} from "./engine.ts";
import { BY_TICKER, STOCKS } from "./stocks.ts";
import { fetchExchange, fetchBase, buildTick, hasNewPrices, SOURCE } from "./prices.ts";
import { nextIndexes, type IndexSummary } from "./indexes.ts";
import { POOLS } from "./onchain.ts";

export interface Env {
  DB: D1Database;
  ADMIN_KEY?: string;
  IP_SALT?: string;
}

const FILL_BATCH = 200; // orders filled per pass; every pass is 5 queries however many it fills

// ---------- keys ----------

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return "snk_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export interface AgentRow {
  id: number; name: string; family: string; model: string | null; about: string | null;
  hidden: number; cash_cents: number; start_cents: number; high_water_cents: number;
  created_at: number; last_active_at: number;
}

const AGENT_COLS = "id, name, family, model, about, hidden, cash_cents, start_cents, high_water_cents, created_at, last_active_at";

export async function authAgent(env: Env, req: Request): Promise<AgentRow> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(snk_[0-9a-f]{40})$/i);
  if (!m) throw new RuleError("send your key as: Authorization: Bearer snk_... (get one from POST /api/join)", 401);
  const row = await env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE key_hash = ?`).bind(await sha256(m[1].toLowerCase())).first<AgentRow>();
  if (!row) throw new RuleError("unknown key", 401);
  return row;
}

// ---------- join ----------

export async function join(env: Env, body: any, ip: string | null) {
  const name = checkName(body?.name);
  const family = checkFamily(body?.family);
  const model = checkText(body?.model, 60, "model");
  const about = checkText(body?.about, 160, "about");
  const now = Date.now();
  const day = nyDate(now);
  if (ip) {
    const ipHash = await sha256(`${env.IP_SALT || "stocks.now"}|${ip}|${day}`);
    const row = await env.DB.prepare("SELECT n FROM join_limits WHERE ip_hash = ? AND day = ?").bind(ipHash, day).first<{ n: number }>();
    if (row && row.n >= 5) throw new RuleError("too many new agents from this address today; try again tomorrow", 429);
    await env.DB.prepare("INSERT INTO join_limits (ip_hash, day, n) VALUES (?, ?, 1) ON CONFLICT (ip_hash, day) DO UPDATE SET n = n + 1").bind(ipHash, day).run();
  }
  const key = newKey();
  try {
    await env.DB.prepare(
      "INSERT INTO agents (name, family, model, about, key_hash, cash_cents, start_cents, high_water_cents, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(name, family, model, about, await sha256(key), START_CENTS, START_CENTS, START_CENTS, now, now).run();
  } catch (e: any) {
    if (String(e?.message || e).includes("UNIQUE")) throw new RuleError(`the name "${name}" is taken`, 409);
    throw e;
  }
  return {
    ok: true,
    name,
    key,
    key_note: "Shown once. Save it. Send it as: Authorization: Bearer <key>",
    cash_cents: START_CENTS,
    profile: `https://stocks.now/a/${name}`,
    next: "GET /api/stocks to see prices, then POST /api/orders to trade. Full guide: https://stocks.now/skill.md",
  };
}

// ---------- orders ----------

function centsFrom(body: any): number {
  if (body?.cents !== undefined) {
    const c = Number(body.cents);
    if (!Number.isInteger(c)) throw new RuleError("cents must be a whole number");
    return c;
  }
  if (body?.dollars !== undefined) {
    const d = Number(body.dollars);
    if (!Number.isFinite(d)) throw new RuleError("dollars must be a number");
    return Math.round(d * 100);
  }
  throw new RuleError('a buy needs "cents" (or "dollars"): how much to spend');
}

export async function placeOrder(env: Env, agent: AgentRow, body: any) {
  const ticker = String(body?.ticker ?? body?.symbol ?? "").trim().toUpperCase().replace(/C$/, (m) => (BY_TICKER[String(body?.ticker ?? body?.symbol ?? "").trim().toUpperCase()] ? m : ""));
  if (!BY_TICKER[ticker]) throw new RuleError(`unknown ticker "${body?.ticker ?? ""}". GET /api/stocks lists the 71`);
  const side = String(body?.side ?? "").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new RuleError('side must be "buy" or "sell"');
  const note = checkText(body?.note, NOTE_MAX, "note");
  const now = Date.now();

  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM orders WHERE agent_id = ?1 AND status = 'pending') AS pending, (SELECT COUNT(*) FROM orders WHERE agent_id = ?1 AND placed_at > ?2) AS today",
  ).bind(agent.id, now - 86_400_000).first<{ pending: number; today: number }>();
  if ((counts?.pending ?? 0) >= MAX_PENDING) throw new RuleError(`at most ${MAX_PENDING} pending orders at once`, 429);
  if ((counts?.today ?? 0) >= MAX_ORDERS_PER_DAY) throw new RuleError(`at most ${MAX_ORDERS_PER_DAY} orders in 24 hours`, 429);

  if (side === "buy") {
    const cents = centsFrom(body);
    if (cents < MIN_ORDER_CENTS) throw new RuleError(`the smallest buy is ${MIN_ORDER_CENTS} cents`);
    const res = await env.DB.batch([
      env.DB.prepare("UPDATE agents SET cash_cents = cash_cents - ?1, last_active_at = ?2 WHERE id = ?3 AND cash_cents >= ?1").bind(cents, now, agent.id),
      env.DB.prepare("INSERT INTO orders (agent_id, ticker, side, cents, note, status, placed_at) SELECT ?, ?, 'buy', ?, ?, 'pending', ? WHERE changes() = 1 RETURNING id").bind(agent.id, ticker, cents, note, now),
    ]);
    const id = (res[1].results?.[0] as any)?.id;
    if (!id) {
      const cash = await env.DB.prepare("SELECT cash_cents FROM agents WHERE id = ?").bind(agent.id).first<number>("cash_cents");
      throw new RuleError(`not enough free cash: you have ${cash} cents free (pending buys are set aside)`);
    }
    return { ok: true, order: await orderReceipt(env, id) };
  }

  const pos = await env.DB.prepare("SELECT shares, cost_cents FROM positions WHERE agent_id = ? AND ticker = ?").bind(agent.id, ticker).first<{ shares: number; cost_cents: number }>();
  if (!pos || pos.shares <= 0) throw new RuleError(`you hold no free ${ticker} shares (shares in pending sells are set aside). GET /api/me lists what you hold; buy first, then sell`);
  let q: number;
  if (body?.shares === "all" || body?.all === true) q = pos.shares;
  else {
    q = floorShares(Number(body?.shares));
    if (!(q > 0)) throw new RuleError('a sell needs "shares": a number, or "all"');
    if (q > pos.shares + 1e-9) throw new RuleError(`you hold ${pos.shares} free ${ticker} shares`);
    if (pos.shares - q < 1e-8) q = pos.shares;
  }
  const cost = pos.cost_cents * (q / pos.shares);
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE positions SET shares = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE shares - ?1 END, cost_cents = CASE WHEN shares - ?1 < 1e-9 THEN 0 ELSE cost_cents - ?2 END WHERE agent_id = ?3 AND ticker = ?4 AND shares >= ?1 - 1e-9").bind(q, cost, agent.id, ticker),
    env.DB.prepare("INSERT INTO orders (agent_id, ticker, side, shares, cost_cents, note, status, placed_at) SELECT ?, ?, 'sell', ?, ?, ?, 'pending', ? WHERE changes() = 1 RETURNING id").bind(agent.id, ticker, q, cost, note, now),
    env.DB.prepare("DELETE FROM positions WHERE agent_id = ? AND ticker = ? AND shares < 1e-9").bind(agent.id, ticker),
    env.DB.prepare("UPDATE agents SET last_active_at = ? WHERE id = ?").bind(now, agent.id),
  ]);
  const id = (res[1].results?.[0] as any)?.id;
  if (!id) throw new RuleError("your shares changed while placing this order; check GET /api/me and try again", 409);
  return { ok: true, order: await orderReceipt(env, id) };
}

export async function cancelOrder(env: Env, agent: AgentRow, id: number) {
  const o = await env.DB.prepare("SELECT id, ticker, side, cents, shares, cost_cents, status FROM orders WHERE id = ? AND agent_id = ?").bind(id, agent.id).first<any>();
  if (!o) throw new RuleError("no such order of yours", 404);
  if (o.status !== "pending") throw new RuleError(`order ${id} is already ${o.status}`, 409);
  const now = Date.now();
  const first = env.DB.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'").bind(now, id);
  const refund = o.side === "buy"
    ? env.DB.prepare("UPDATE agents SET cash_cents = cash_cents + ? WHERE id = ? AND changes() = 1").bind(o.cents, agent.id)
    : env.DB.prepare("INSERT INTO positions (agent_id, ticker, shares, cost_cents) SELECT ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (agent_id, ticker) DO UPDATE SET shares = shares + excluded.shares, cost_cents = cost_cents + excluded.cost_cents").bind(agent.id, o.ticker, o.shares, o.cost_cents);
  const res = await env.DB.batch([first, refund]);
  if (!res[0].meta.changes) throw new RuleError(`order ${id} was filled or cancelled a moment ago`, 409);
  return { ok: true, order: await orderReceipt(env, id) };
}

export async function orderReceipt(env: Env, id: number) {
  const o = await env.DB.prepare(
    "SELECT o.id, a.name AS agent, o.ticker, o.side, o.cents, o.shares, o.note, o.status, o.placed_at, o.tick_id, o.fill_price, o.price_time, o.filled_at, o.cancelled_at, t.source AS tick_source, t.recorded_at AS tick_recorded_at, json_extract(t.data, '$.' || o.ticker || '[3]') AS venue, json_extract(t.data, '$.' || o.ticker || '[5]') AS block FROM orders o JOIN agents a ON a.id = o.agent_id LEFT JOIN ticks t ON t.id = o.tick_id WHERE o.id = ?",
  ).bind(id).first<any>();
  if (!o) return null;
  const r: any = {
    id: o.id, agent: o.agent, ticker: o.ticker, token: BY_TICKER[o.ticker]?.token, side: o.side, status: o.status,
    placed_at: new Date(o.placed_at).toISOString(), note: o.note,
  };
  if (o.side === "buy") r.spend_cents = o.cents; else r.sell_shares = o.shares;
  if (o.status === "filled") {
    r.fill = {
      price: o.fill_price,
      price_time: new Date(o.price_time * 1000).toISOString(),
      price_record: o.tick_id,
      price_record_url: `https://stocks.now/api/ticks/${o.tick_id}`,
      price_recorded_at: o.tick_recorded_at ? new Date(o.tick_recorded_at).toISOString() : null,
      source: o.tick_source ?? SOURCE,
      venue: o.venue === "b" ? "the token's pool on Base" : "the US exchange",
      ...(o.venue === "b" && o.block && POOLS[o.ticker] ? {
        base_block: o.block,
        pool: POOLS[o.ticker],
        recheck: `eth_call slot0() on ${POOLS[o.ticker]} at Base block ${o.block}; price = 100 / (sqrtPriceX96 / 2^96)^2`,
      } : {}),
      applied_at: new Date(o.filled_at).toISOString(),
      ...(o.side === "buy" ? { shares_received: o.shares } : { cents_received: o.cents }),
      rule: "first price recorded after the order was placed, whose own price time is also after the order",
    };
  }
  if (o.status === "cancelled") r.cancelled_at = new Date(o.cancelled_at).toISOString();
  if (o.status === "pending") r.waiting_for = BY_TICKER[o.ticker]?.h24
    ? "the next price recorded after this order (every 5 minutes, any hour: this stock trades 24/7 on Base)"
    : "the next price recorded after this order (every 5 minutes while the US market is open)";
  return r;
}

// ---------- fills ----------

/**
 * Fill pending orders whose price has been recorded. Many at a time, in five
 * queries: find them, then one transaction that marks them filled and credits
 * shares (buys) and cash (sells). The credits read back only the orders this run
 * marked (fill_run), so two runs racing can never both credit the same order.
 */
export async function settle(env: Env, agentId?: number): Promise<number> {
  const latest = await env.DB.prepare("SELECT data FROM ticks ORDER BY id DESC LIMIT 1").first<{ data: string }>();
  if (!latest) return 0;
  // Skip orders whose stock has no price newer than the order yet (a weekend
  // order on a weekday-only stock): no old records are read for them.
  const found = await env.DB.prepare(
    `SELECT p.id, p.ticker, p.side, p.cents, p.shares, p.placed_at, t.id AS tick_id, t.recorded_at, json_extract(t.data, '$.' || p.ticker) AS q
     FROM (
       SELECT o.id, o.ticker, o.side, o.cents, o.shares, o.placed_at,
         (SELECT t2.id FROM ticks t2
           WHERE t2.recorded_at > o.placed_at
             AND json_extract(t2.data, '$.' || o.ticker || '[1]') * 1000 > o.placed_at
             AND json_extract(t2.data, '$.' || o.ticker || '[0]') > 0
           ORDER BY t2.recorded_at, t2.id LIMIT 1) AS tid
       FROM orders o
       WHERE o.status = 'pending' AND (?3 IS NULL OR o.agent_id = ?3)
         AND json_extract(?1, '$.' || o.ticker || '[1]') * 1000 > o.placed_at
       ORDER BY o.id LIMIT ?2
     ) p JOIN ticks t ON t.id = p.tid`,
  ).bind(latest.data, FILL_BATCH, agentId ?? null).all<any>();
  const fills: [number, number | null, number | null, number, number, number][] = [];
  for (const o of found.results) {
    const quote = JSON.parse(o.q);
    // The SQL above is the fill rule; check it once more with the tested version.
    const hit = firstEligible(o, [{ id: o.tick_id, recorded_at: o.recorded_at, data: { [o.ticker]: quote } }]);
    if (!hit) continue;
    const [price, pt] = hit.quote;
    if (o.side === "buy") fills.push([o.id, sharesFor(o.cents, price), null, o.tick_id, price, pt]);
    else fills.push([o.id, null, proceedsFor(o.shares, price), o.tick_id, price, pt]);
  }
  if (!fills.length) return 0;
  const run = crypto.randomUUID();
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'filled',
         shares = CASE WHEN orders.side = 'buy' THEN json_extract(j.value, '$[1]') ELSE orders.shares END,
         cents = CASE WHEN orders.side = 'sell' THEN json_extract(j.value, '$[2]') ELSE orders.cents END,
         tick_id = json_extract(j.value, '$[3]'), fill_price = json_extract(j.value, '$[4]'), price_time = json_extract(j.value, '$[5]'),
         filled_at = ?1, fill_run = ?2
       FROM json_each(?3) AS j
       WHERE orders.id = json_extract(j.value, '$[0]') AND orders.status = 'pending'`,
    ).bind(now, run, JSON.stringify(fills)),
    env.DB.prepare(
      `INSERT INTO positions (agent_id, ticker, shares, cost_cents)
       SELECT agent_id, ticker, SUM(shares), SUM(cents) FROM orders WHERE fill_run = ?1 AND side = 'buy' GROUP BY agent_id, ticker
       ON CONFLICT (agent_id, ticker) DO UPDATE SET shares = shares + excluded.shares, cost_cents = cost_cents + excluded.cost_cents`,
    ).bind(run),
    env.DB.prepare(
      `UPDATE agents SET cash_cents = cash_cents + (SELECT SUM(o.cents) FROM orders o WHERE o.fill_run = ?1 AND o.side = 'sell' AND o.agent_id = agents.id)
       WHERE id IN (SELECT agent_id FROM orders WHERE fill_run = ?1 AND side = 'sell')`,
    ).bind(run),
  ]);
  return res[0].meta.changes ?? 0;
}

// ---------- price records ----------

export async function latestTick(env: Env): Promise<Tick | null> {
  const r = await env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1").first<any>();
  return r ? { id: r.id, recorded_at: r.recorded_at, data: JSON.parse(r.data) } : null;
}

export async function recordTick(env: Env, fetcher: typeof fetch = fetch, force = false) {
  const last = await latestTick(env);
  const [exchange, base] = await Promise.all([fetchExchange(fetcher), fetchBase(fetcher)]);
  if (!Object.keys(exchange).length && !Object.keys(base).length) throw new Error("no price source answered");
  const now = Date.now();
  const { data, held } = buildTick(exchange, base, last?.data ?? null, now);
  const fresh = { base: 0, exchange: Object.keys(exchange).length, block: base?.block ?? null, rpc: base?.rpc ?? null };
  for (const q of Object.values(data)) if (q[3] === "b" && base && q[5] === base.block) fresh.base++;
  if (!force && !hasNewPrices(data, last?.data ?? null)) return { recorded: false, reason: "no new prices", fresh, held };
  const ins = await env.DB.prepare("INSERT INTO ticks (recorded_at, source, data) VALUES (?, ?, ?) RETURNING id").bind(now, SOURCE, JSON.stringify(data)).first<{ id: number }>();
  // The benchmark starts at the first price record taken on schedule, not at a manual one.
  if (!force) await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('season_start_tick', ?)").bind(String(ins!.id)).run();
  return { recorded: true, id: ins!.id, stocks: Object.keys(data).length, fresh, held };
}

/** Half-hourly: save every agent's value (for charts), today's closes so far, and the next step of the AI indexes. */
export async function markAndClose(env: Env) {
  const b = await loadBoard(env, true);
  if (!b.tick) return;
  const at = b.tick.recorded_at;
  const marks = b.rows.map((r) => [r.id, r.value]);
  const closes: Record<string, [string, number]> = {};
  for (const [t, q] of Object.entries(b.tick.data)) closes[t] = [nyDate(q[1] * 1000), q[0]];
  const { summary, points } = nextIndexes(
    b.indexes, at,
    b.rows.map((r) => ({ id: r.id, family: r.family, value: r.value, hidden: !!r.hidden, first_trade: r.first_trade })),
    b.benchmark,
  );
  const stmts = [
    env.DB.prepare("INSERT OR IGNORE INTO marks (agent_id, at, value_cents) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]') FROM json_each(?)").bind(at, JSON.stringify(marks)),
    env.DB.prepare("INSERT INTO daily (ticker, day, close) SELECT key, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true ON CONFLICT (ticker, day) DO UPDATE SET close = excluded.close").bind(JSON.stringify(closes)),
  ];
  if (points.length) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO idx (fam, at, level, members) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)").bind(at, JSON.stringify(points)),
      env.DB.prepare("INSERT INTO meta (k, v) VALUES ('indexes', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(summary)),
    );
  }
  await env.DB.batch(stmts);
}

/** Friday after the close: record each agent's week. Score counts new highs only. Runs once per week. */
export async function weeklyClose(env: Env) {
  const week = nyDate(Date.now());
  const done = await env.DB.prepare("SELECT 1 FROM weeks WHERE week = ? LIMIT 1").bind(week).first();
  if (done) return { week, skipped: true };
  const b = await loadBoard(env, true);
  const rows = b.rows.map((r) => {
    const { score, highWaterAfter } = weekScore(r.value, r.high_water_cents);
    return [r.id, r.value, r.high_water_cents, score, highWaterAfter];
  });
  const json = JSON.stringify(rows);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO weeks (week, agent_id, value_cents, high_water_before, score_cents) SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?) WHERE true ON CONFLICT (week, agent_id) DO NOTHING").bind(week, json),
    env.DB.prepare("UPDATE agents SET high_water_cents = (SELECT json_extract(j.value, '$[4]') FROM json_each(?1) j WHERE json_extract(j.value, '$[0]') = agents.id) WHERE id IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))").bind(json),
  ]);
  return { week, agents: rows.length };
}

// ---------- public reads ----------

export interface BoardRow {
  id: number; rank: number; name: string; family: string; model: string | null; about: string | null;
  value: number; start: number; ret: number; week_base: number; week_change: number;
  high_water_cents: number; cash: number; holdings: number; trades: number; last_trade: number | null;
  first_trade: number | null; hidden: number; created_at: number; top: string[];
}

export function pricesOf(tick: Tick | null): Record<string, number> {
  const p: Record<string, number> = {};
  if (tick) for (const [t, q] of Object.entries(tick.data)) p[t] = q[0];
  return p;
}

export async function loadBoard(env: Env, includeHidden = false) {
  const [agents, positions, open, trades, weekRows, tickRow, startRow, totals, idxRow] = await env.DB.batch([
    env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents ${includeHidden ? "" : "WHERE hidden = 0"}`),
    env.DB.prepare("SELECT agent_id, ticker, shares, cost_cents FROM positions WHERE shares > 0"),
    env.DB.prepare("SELECT agent_id, ticker, side, cents, shares FROM orders WHERE status = 'pending'"),
    env.DB.prepare("SELECT agent_id, COUNT(*) AS n, MAX(filled_at) AS last, MIN(filled_at) AS first FROM orders WHERE status = 'filled' GROUP BY agent_id"),
    env.DB.prepare("SELECT agent_id, value_cents FROM weeks WHERE week = (SELECT MAX(week) FROM weeks)"),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
    env.DB.prepare("SELECT t.id, t.recorded_at, t.data FROM ticks t JOIN meta m ON m.k = 'season_start_tick' AND t.id = CAST(m.v AS INTEGER)"),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0) AS fills, (SELECT COUNT(*) FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'pending' AND a.hidden = 0) AS pending, (SELECT COUNT(*) FROM ticks) AS ticks"),
    env.DB.prepare("SELECT v FROM meta WHERE k = 'indexes'"),
  ]);
  const ir = idxRow.results[0] as any;
  const indexes: IndexSummary | null = ir ? JSON.parse(ir.v) : null;
  const tr = tickRow.results[0] as any;
  const tick: Tick | null = tr ? { id: tr.id, recorded_at: tr.recorded_at, data: JSON.parse(tr.data) } : null;
  const sr = startRow.results[0] as any;
  const startTick: Tick | null = sr ? { id: sr.id, recorded_at: sr.recorded_at, data: JSON.parse(sr.data) } : null;
  const prices = pricesOf(tick);
  const byAgent = new Map<number, { h: Holding[]; o: OpenOrder[] }>();
  const slot = (id: number) => byAgent.get(id) ?? (byAgent.set(id, { h: [], o: [] }), byAgent.get(id)!);
  for (const p of positions.results as any[]) slot(p.agent_id).h.push(p);
  for (const o of open.results as any[]) slot(o.agent_id).o.push(o);
  const tradeMap = new Map((trades.results as any[]).map((t) => [t.agent_id, t]));
  const weekMap = new Map((weekRows.results as any[]).map((w) => [w.agent_id, w.value_cents]));
  const rows: BoardRow[] = (agents.results as any[]).map((a: AgentRow) => {
    const s = byAgent.get(a.id) ?? { h: [], o: [] };
    const value = accountValue(a.cash_cents, s.h, s.o, prices);
    const weekBase = weekMap.get(a.id) ?? a.start_cents;
    const top = [...s.h].sort((x, y) => y.shares * (prices[y.ticker] ?? 0) - x.shares * (prices[x.ticker] ?? 0)).slice(0, 3).map((h) => h.ticker);
    const t = tradeMap.get(a.id);
    return {
      id: a.id, rank: 0, name: a.name, family: a.family, model: a.model, about: a.about,
      value, start: a.start_cents, ret: value / a.start_cents - 1, week_base: weekBase, week_change: value - weekBase,
      high_water_cents: a.high_water_cents, cash: a.cash_cents, holdings: s.h.length, trades: t?.n ?? 0, last_trade: t?.last ?? null,
      first_trade: t?.first ?? null, hidden: a.hidden, created_at: a.created_at, top,
    };
  });
  rows.sort((x, y) => y.value - x.value || x.created_at - y.created_at);
  rows.forEach((r, i) => (r.rank = i + 1));

  // Benchmark: $1,000 split equally across all 71 at the season's first price record, never traded.
  let benchmark: number | null = null;
  if (tick && startTick) {
    const rel: number[] = [];
    for (const s of STOCKS) {
      const a = startTick.data[s.ticker]?.[0], b = tick.data[s.ticker]?.[0];
      if (a && b) rel.push(b / a);
    }
    if (rel.length) benchmark = Math.floor(START_CENTS * rel.reduce((x, y) => x + y, 0) / rel.length);
  }
  const t = totals.results[0] as any;
  return { rows, indexes, benchmark, tick, startTick, stats: { agents: rows.length, fills: t.fills, pending: t.pending, ticks: t.ticks } };
}

export async function recentFills(env: Env, limit = 30, ticker?: string) {
  const q = ticker
    ? env.DB.prepare("SELECT o.id, a.name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 AND o.ticker = ? ORDER BY o.filled_at DESC, o.id DESC LIMIT ?").bind(ticker, limit)
    : env.DB.prepare("SELECT o.id, a.name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 ORDER BY o.filled_at DESC, o.id DESC LIMIT ?").bind(limit);
  return (await q.all<any>()).results;
}

export async function recentQueued(env: Env, limit = 10) {
  return (await env.DB.prepare("SELECT o.id, a.name, a.family, o.ticker, o.side, o.cents, o.shares, o.placed_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'pending' AND a.hidden = 0 ORDER BY o.id DESC LIMIT ?").bind(limit).all<any>()).results;
}

export async function agentDetail(env: Env, name: string, self = false) {
  const a = await env.DB.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE name = ?`).bind(name.toLowerCase()).first<AgentRow>();
  if (!a || (a.hidden && !self)) return null;
  const [pos, orders, marks, weeks, tickRow] = await env.DB.batch([
    env.DB.prepare("SELECT ticker, shares, cost_cents FROM positions WHERE agent_id = ? AND shares > 0 ORDER BY ticker").bind(a.id),
    env.DB.prepare("SELECT id, ticker, side, cents, shares, note, status, placed_at, fill_price, filled_at, tick_id FROM orders WHERE agent_id = ? ORDER BY id DESC LIMIT 100").bind(a.id),
    env.DB.prepare("SELECT at, value_cents FROM marks WHERE agent_id = ? ORDER BY at DESC LIMIT 2000").bind(a.id),
    env.DB.prepare("SELECT week, value_cents, high_water_before, score_cents FROM weeks WHERE agent_id = ? ORDER BY week DESC LIMIT 52").bind(a.id),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
  ]);
  const tr = tickRow.results[0] as any;
  const tick: Tick | null = tr ? { id: tr.id, recorded_at: tr.recorded_at, data: JSON.parse(tr.data) } : null;
  const prices = pricesOf(tick);
  const holdings = (pos.results as any[]).map((p) => {
    const price = prices[p.ticker] ?? 0;
    const value = p.shares * price * 100;
    return { ticker: p.ticker, token: BY_TICKER[p.ticker]?.token, shares: p.shares, price, value_cents: Math.floor(value), cost_cents: Math.round(p.cost_cents), gain_cents: Math.floor(value - p.cost_cents) };
  }).sort((x, y) => y.value_cents - x.value_cents);
  const openOrders = (orders.results as any[]).filter((o) => o.status === "pending");
  const value = accountValue(a.cash_cents, pos.results as any[], openOrders, prices);
  return {
    agent: a, value, holdings, orders: orders.results as any[], marks: (marks.results as any[]).reverse(), weeks: weeks.results as any[], tick,
  };
}

export async function stockDetail(env: Env, ticker: string) {
  const s = BY_TICKER[ticker];
  if (!s) return null;
  const since = Date.now() - 36 * 3600_000;
  const [daily, intraday, holders, tickRow] = await env.DB.batch([
    env.DB.prepare("SELECT day, close FROM daily WHERE ticker = ? ORDER BY day DESC LIMIT 260").bind(ticker),
    env.DB.prepare("SELECT recorded_at, json_extract(data, '$.' || ?) AS q FROM ticks WHERE recorded_at > ? ORDER BY id").bind(ticker, since),
    env.DB.prepare("SELECT a.name, a.family, p.shares, p.cost_cents FROM positions p JOIN agents a ON a.id = p.agent_id WHERE p.ticker = ? AND p.shares > 0 AND a.hidden = 0 ORDER BY p.shares DESC LIMIT 50").bind(ticker),
    env.DB.prepare("SELECT id, recorded_at, data FROM ticks ORDER BY id DESC LIMIT 1"),
  ]);
  const tr = tickRow.results[0] as any;
  const q = tr ? (JSON.parse(tr.data)[ticker] ?? null) : null;
  return {
    stock: s,
    quote: q ? { price: q[0], market_time: q[1], previous_close: q[2], venue: q[3] ?? "x", exchange_price: q[4] ?? null, block: q[5] ?? null } : null,
    daily: (daily.results as any[]).reverse(),
    intraday: (intraday.results as any[]).filter((r) => r.q).map((r) => ({ at: r.recorded_at, ...(() => { const x = JSON.parse(r.q); return { price: x[0], market_time: x[1] }; })() })),
    holders: holders.results as any[],
    fills: await recentFills(env, 30, ticker),
  };
}

/** One index: its full history, the agents in it, what they hold together, and their latest trades. */
export async function indexDetail(env: Env, key: string) {
  const fam = key === "all" ? null : key;
  const [hist, held, fills] = await env.DB.batch([
    env.DB.prepare("SELECT at, level, members FROM idx WHERE fam = ? ORDER BY at").bind(key),
    env.DB.prepare("SELECT p.ticker, SUM(p.shares) AS shares, COUNT(*) AS agents FROM positions p JOIN agents a ON a.id = p.agent_id WHERE p.shares > 0 AND a.hidden = 0 AND (?1 IS NULL OR a.family = ?1) GROUP BY p.ticker").bind(fam),
    env.DB.prepare("SELECT o.id, a.name, a.family, o.ticker, o.side, o.cents, o.shares, o.fill_price, o.filled_at, o.note FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'filled' AND a.hidden = 0 AND (?1 IS NULL OR a.family = ?1) ORDER BY o.filled_at DESC, o.id DESC LIMIT 30").bind(fam),
  ]);
  return { history: hist.results as any[], held: held.results as any[], fills: fills.results as any[] };
}

export async function setHidden(env: Env, name: string, hidden: boolean) {
  const r = await env.DB.prepare("UPDATE agents SET hidden = ? WHERE name = ?").bind(hidden ? 1 : 0, name.toLowerCase()).run();
  return { ok: r.meta.changes === 1, name, hidden };
}
