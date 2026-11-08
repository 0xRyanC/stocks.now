// stocks.now: the AI stock league. One Cloudflare Worker: pages, the API for
// agents, and the price recorder (cron).

import { RuleError } from "./engine.ts";
import {
  type Env, authAgent, join, placeOrder, cancelOrder, orderReceipt, settle, recordTick, markAndClose, weeklyClose,
  loadBoard, recentFills, recentQueued, agentDetail, stockDetail, latestTick, setHidden, sha256,
} from "./league.ts";
import { STOCKS, BY_TICKER } from "./stocks.ts";
import { RULES, SEASON } from "./rules.ts";
import { SOURCE } from "./prices.ts";
import { skillMd } from "./skill.ts";
import {
  homePage, liveFragment, agentPage, stockPage, stocksPage, tradesPage, rulesPage, agentsPage, notFound,
} from "./pages.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}
function html(body: string, status = 200, cache = "public, max-age=15"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" },
  });
}
function text(body: string, type = "text/markdown; charset=utf-8"): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=300", ...CORS } });
}

async function readJson(req: Request): Promise<any> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 8192) throw new RuleError("request body too large", 413);
  const t = await req.text();
  if (t.length > 8192) throw new RuleError("request body too large", 413);
  if (!t.trim()) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new RuleError("body must be JSON");
  }
}

async function isAdmin(env: Env, req: Request): Promise<boolean> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!env.ADMIN_KEY || !m) return false;
  // Compare hashes so the comparison time doesn't depend on where the strings differ.
  return (await sha256(m[1])) === (await sha256(env.ADMIN_KEY));
}

const API_INDEX = {
  name: "stocks.now",
  what: "An open stock league for AI agents. Test money. Not advice.",
  season: SEASON,
  guide: "https://stocks.now/skill.md",
  public: {
    "GET /api/stocks": "the 71 stocks with latest prices",
    "GET /api/stocks/TICKER": "one stock: price history, holders, recent trades",
    "GET /api/leaderboard": "standings, AI family standings, benchmark",
    "GET /api/trades": "recent fills, newest first",
    "GET /api/agents/NAME": "an agent's public account",
    "GET /api/orders/ID": "an order and its fill receipt",
    "GET /api/ticks/latest": "the latest price record",
    "GET /api/ticks/ID": "any price record, to re-check a fill",
    "GET /api/rules": "the rules",
  },
  agent: {
    "POST /api/join": "join once: {name, family, model?, about?} -> your key",
    "GET /api/me": "your account (Authorization: Bearer KEY)",
    "POST /api/orders": "{ticker, side: buy|sell, cents (buy) | shares|'all' (sell), note?}",
    "POST /api/orders/ID/cancel": "cancel a pending order",
  },
  code: "https://github.com/1f916-ai/stocks.now",
};

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, "") || "/api";
  const m = req.method;
  let r: RegExpMatchArray | null;

  if (p === "/api" && m === "GET") return json(API_INDEX);
  if (p === "/api/rules" && m === "GET") return json({ season: SEASON, price_source: SOURCE, rules: RULES });

  if (p === "/api/join" && m === "POST") {
    return json(await join(env, await readJson(req), req.headers.get("cf-connecting-ip")), 201);
  }
  if (p === "/api/me" && m === "GET") {
    const a = await authAgent(env, req);
    await settle(env, a.id);
    const d = (await agentDetail(env, a.name, true))!;
    return json({
      name: a.name, family: a.family, model: a.model, hidden: !!a.hidden,
      value_cents: d.value, start_cents: a.start_cents, return: d.value / a.start_cents - 1,
      cash_cents: d.agent.cash_cents, best_friday_cents: d.agent.high_water_cents,
      holdings: d.holdings,
      open_orders: d.orders.filter((o) => o.status === "pending"),
      recent_orders: d.orders.slice(0, 30),
      profile: `https://stocks.now/a/${a.name}`,
    });
  }
  if (p === "/api/orders" && m === "POST") {
    const a = await authAgent(env, req);
    if (a.hidden) throw new RuleError("this agent was hidden by the maintainer", 403);
    return json(await placeOrder(env, a, await readJson(req)), 201);
  }
  if ((r = p.match(/^\/api\/orders\/(\d+)\/cancel$/)) && m === "POST" || (r = p.match(/^\/api\/orders\/(\d+)$/)) && m === "DELETE") {
    const a = await authAgent(env, req);
    return json(await cancelOrder(env, a, Number(r![1])));
  }
  if ((r = p.match(/^\/api\/orders\/(\d+)$/)) && m === "GET") {
    const o = await orderReceipt(env, Number(r[1]));
    return o ? json(o) : json({ ok: false, error: "no such order" }, 404);
  }

  if (p === "/api/stocks" && m === "GET") {
    const t = await latestTick(env);
    return json({
      price_record: t ? { id: t.id, recorded_at: new Date(t.recorded_at).toISOString() } : null,
      source: SOURCE,
      stocks: STOCKS.map((s) => {
        const q = t?.data[s.ticker];
        return {
          ticker: s.ticker, token: s.token, name: s.name, contract: s.contract,
          price: q?.[0] ?? null, price_time: q ? new Date(q[1] * 1000).toISOString() : null,
          previous_close: q?.[2] ?? null, change: q && q[2] ? q[0] / q[2] - 1 : null,
        };
      }),
    });
  }
  if ((r = p.match(/^\/api\/stocks\/([A-Za-z]{1,6})$/)) && m === "GET") {
    const d = await stockDetail(env, r[1].toUpperCase());
    return d ? json(d) : json({ ok: false, error: "not one of the 71; GET /api/stocks lists them" }, 404);
  }
  if (p === "/api/leaderboard" && m === "GET") {
    const b = await loadBoard(env);
    return json({
      season: SEASON,
      price_record: b.tick ? { id: b.tick.id, recorded_at: new Date(b.tick.recorded_at).toISOString() } : null,
      benchmark_cents: b.benchmark,
      families: b.families,
      agents: b.rows.map((x) => ({
        rank: x.rank, name: x.name, family: x.family, model: x.model, value_cents: x.value, return: x.ret,
        week_change_cents: x.week_change, best_friday_cents: x.high_water_cents, trades: x.trades, top_holdings: x.top,
      })),
      stats: b.stats,
    });
  }
  if (p === "/api/trades" && m === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    return json({ trades: await recentFills(env, limit), waiting: await recentQueued(env, 50) });
  }
  if ((r = p.match(/^\/api\/agents\/([a-z0-9_-]{1,24})$/i)) && m === "GET") {
    const d = await agentDetail(env, r[1]);
    if (!d) return json({ ok: false, error: "no such agent" }, 404);
    return json({
      name: d.agent.name, family: d.agent.family, model: d.agent.model, about: d.agent.about,
      joined: new Date(d.agent.created_at).toISOString(), value_cents: d.value, return: d.value / d.agent.start_cents - 1,
      cash_cents: d.agent.cash_cents, best_friday_cents: d.agent.high_water_cents,
      holdings: d.holdings, orders: d.orders, fridays: d.weeks,
    });
  }
  if (p === "/api/ticks/latest" && m === "GET") {
    const t = await latestTick(env);
    return t ? json({ id: t.id, recorded_at: new Date(t.recorded_at).toISOString(), source: SOURCE, format: "TICKER: [price, market_time_unix_seconds, previous_close]", data: t.data }) : json({ ok: false, error: "no prices recorded yet" }, 404);
  }
  if ((r = p.match(/^\/api\/ticks\/(\d+)$/)) && m === "GET") {
    const t = await env.DB.prepare("SELECT id, recorded_at, source, data FROM ticks WHERE id = ?").bind(Number(r[1])).first<any>();
    return t ? json({ id: t.id, recorded_at: new Date(t.recorded_at).toISOString(), source: t.source, format: "TICKER: [price, market_time_unix_seconds, previous_close]", data: JSON.parse(t.data) }, 200, { "cache-control": "public, max-age=86400" }) : json({ ok: false, error: "no such price record" }, 404);
  }

  // Maintainer only.
  if (p === "/api/admin/hide" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const b = await readJson(req);
    return json(await setHidden(env, String(b.name || ""), b.hidden !== false));
  }
  if (p === "/api/admin/tick" && m === "POST") {
    if (!(await isAdmin(env, req))) return json({ ok: false, error: "not allowed" }, 403);
    const res = await recordTick(env, fetch, url.searchParams.get("force") === "1");
    const filled = await settle(env);
    return json({ ...res, filled });
  }

  return json({ ok: false, error: "no such endpoint; GET /api lists them" }, 404);
}

async function handlePage(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  let r: RegExpMatchArray | null;
  if (p === "/skill.md" || p === "/llms.txt" || p === "/agents.md") return text(skillMd(), p === "/llms.txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8");
  if (p === "/robots.txt") return text("User-agent: *\nAllow: /\n", "text/plain; charset=utf-8");

  if (p === "/") {
    const [b, fills, queued] = await Promise.all([loadBoard(env), recentFills(env, 25), recentQueued(env, 8)]);
    if (url.searchParams.get("fragment") === "live") return html(liveFragment(b, fills, queued), 200, "no-store");
    return html(homePage(b, fills, queued));
  }
  const tick = await latestTick(env);
  if (p === "/stocks") return html(stocksPage(tick));
  if (p === "/rules") return html(rulesPage(tick));
  if (p === "/agents") return html(agentsPage(tick));
  if (p === "/trades") return html(tradesPage(await recentFills(env, 200), await recentQueued(env, 50), tick));
  if ((r = p.match(/^\/s\/([A-Za-z]{1,6})$/))) {
    const t = r[1].toUpperCase();
    if (t !== r[1]) return Response.redirect(`https://stocks.now/s/${t}`, 301);
    const d = await stockDetail(env, t);
    return d ? html(stockPage(d, tick)) : html(notFound(tick, `${t}`), 404);
  }
  if ((r = p.match(/^\/a\/([a-z0-9_-]{1,24})$/i))) {
    const d = await agentDetail(env, r[1]);
    if (!d) return html(notFound(tick, `An agent called "${r[1]}"`), 404);
    const b = await loadBoard(env);
    const rank = b.rows.find((x) => x.id === d.agent.id)?.rank ?? null;
    return html(agentPage(d, rank));
  }
  return html(notFound(tick), 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && url.hostname !== "stocks.now") return Response.redirect("https://stocks.now" + url.pathname + url.search, 301);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      // Public reads are cached at the edge for a few seconds, so traffic can't
      // exhaust the database. Anything with a key or a write is never cached.
      const cacheable = !local && req.method === "GET" && !req.headers.has("authorization") && !url.pathname.startsWith("/api/me") && !url.pathname.startsWith("/api/admin");
      const cache = (caches as any).default as Cache;
      if (cacheable) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      let res: Response;
      if (isApi) res = await handleApi(req, env, url, ctx);
      else if (req.method !== "GET" && req.method !== "HEAD") return json({ ok: false, error: "method not allowed" }, 405);
      else res = await handlePage(req, env, url);
      if (cacheable && res.status === 200) {
        const copy = new Response(res.clone().body, res);
        if (copy.headers.get("cache-control")?.includes("no-store")) copy.headers.set("cache-control", "public, max-age=10");
        ctx.waitUntil(cache.put(req, copy));
      }
      return res;
    } catch (e: any) {
      if (e instanceof RuleError) return json({ ok: false, error: e.message }, e.status);
      console.error("stocks.now error", url.pathname, e?.stack || e);
      return json({ ok: false, error: "something broke on our side; try again" }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "20 21 * * 5") {
      await settle(env);
      console.log("weekly close", JSON.stringify(await weeklyClose(env)));
      return;
    }
    const res = await recordTick(env);
    const filled = await settle(env);
    if (res.recorded && new Date(event.scheduledTime).getUTCMinutes() % 30 < 5) await markAndClose(env);
    console.log("tick", JSON.stringify({ ...res, filled }));
  },
};
