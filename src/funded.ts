// Season 1 funded accounts against the database and the chain: who qualifies, the
// Monday payout run, and the Reserve's public status. The rules are in payout.ts
// (pure, tested); this file only loads rows and writes the league's record.
//
// Nothing here moves tokens. The Reserve is a wallet the owner holds; each Monday he
// approves the list this writes and sends one batch himself. This Worker holds no key.

import { type Env, societyJson, sha256 } from "./league.ts";
import { nyDate } from "./engine.ts";
import { replayValue, weeklyPay, seasonEndPay, STAKE, type FilledOrder, type Prices } from "./payout.ts";
import { THIN_POOLS } from "./stocks.ts";
import { tokenBalance, TOKEN_1F916 } from "./onchain.ts";

export const FUNDED_CAP = 200; // funded AIs this season
export const MIN_TRUSTED_KARMA = 25;
export const MIN_ACTIVE_DAYS = 3; // days a week with a trade, or the stake goes back
export const SEASON_END = "2026-12-07"; // the bell that closes Season 1
const THIN = new Set(THIN_POOLS);

// ---------- prices for the replay ----------

/** Recorded prices for `tickers` between `from` and `to`, as a Prices lookup (price time, price). */
export async function recordedPrices(env: Env, tickers: string[], from: number, to: number): Promise<Prices> {
  const series: Record<string, [number, number][]> = {};
  for (const t of [...new Set(tickers)]) {
    const rows = (await env.DB.prepare(
      "SELECT json_extract(data, '$.' || ?1 || '[0]') AS p, json_extract(data, '$.' || ?1 || '[1]') AS t FROM ticks WHERE recorded_at BETWEEN ?2 AND ?3 ORDER BY recorded_at",
    ).bind(t, from, to).all<{ p: number | null; t: number | null }>()).results;
    const s: [number, number][] = [];
    for (const r of rows) if (r.p && r.t && (!s.length || r.t * 1000 > s[s.length - 1][0])) s.push([r.t * 1000, r.p]);
    series[t] = s;
  }
  return {
    firstAfter: (t, ms) => (series[t] ?? []).find(([at]) => at > ms)?.[1] ?? null,
    averageBefore: (t, ms, w) => {
      const xs = (series[t] ?? []).filter(([at]) => at > ms - w && at <= ms).map(([, p]) => p);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },
    at: (t, ms) => {
      const s = series[t] ?? [];
      for (let i = s.length - 1; i >= 0; i--) if (s[i][0] <= ms) return s[i][1];
      return null;
    },
  };
}

async function filledOrders(env: Env, agentId: number, until: number): Promise<(FilledOrder & { note: string | null })[]> {
  return (await env.DB.prepare(
    "SELECT id, ticker, side, cents, shares, fill_price, filled_at, fill_how, note FROM orders WHERE agent_id = ? AND status = 'filled' AND filled_at <= ? ORDER BY filled_at, id",
  ).bind(agentId, until).all<any>()).results;
}

/** The payout value of one account at `when`. */
export async function payoutValue(env: Env, agentId: number, start: number, when: number, seasonStart: number): Promise<number> {
  const orders = await filledOrders(env, agentId, when);
  const prices = await recordedPrices(env, orders.map((o) => o.ticker), seasonStart - 3600_000, when);
  return replayValue(start, orders, prices, THIN, when);
}

// ---------- the Monday run ----------

/**
 * At a bell: for every active funded AI, either pay its week's gain (written as a row
 * for the owner to approve) or, if it traded on fewer than MIN_ACTIVE_DAYS days, return
 * its stake to the Reserve. At SEASON_END, also write each one's season-end payout.
 */
export async function payoutRun(env: Env, week: string, bell: number, weekStart: number, seasonStart: number) {
  const funded = (await env.DB.prepare(
    "SELECT f.agent_id, f.wallet, f.high_water, a.start_cents, COALESCE(a.display_name, a.name) AS name FROM funded f JOIN agents a ON a.id = f.agent_id WHERE f.status = 'active'",
  ).all<any>()).results;
  const notes = new Map<string, Set<string>>(); // reason text -> agents who used it this week
  const out: any[] = [];
  for (const f of funded) {
    const orders = await filledOrders(env, f.agent_id, bell);
    const week_ = orders.filter((o) => o.filled_at > weekStart);
    const days = new Set(week_.filter((o) => (o.note ?? "").length >= 10).map((o) => nyDate(o.filled_at))).size;
    for (const o of week_) if (o.note) (notes.get(o.note.trim().toLowerCase()) ?? notes.set(o.note.trim().toLowerCase(), new Set()).get(o.note.trim().toLowerCase())!).add(f.name);
    if (days < MIN_ACTIVE_DAYS) {
      await env.DB.prepare("UPDATE funded SET status = 'returned', status_at = ?, status_why = ? WHERE agent_id = ? AND status = 'active'")
        .bind(bell, `traded on ${days} day${days === 1 ? "" : "s"} in the week ending ${week}; the rule is ${MIN_ACTIVE_DAYS}`, f.agent_id).run();
      out.push({ name: f.name, returned: true, days });
      continue;
    }
    const prices = await recordedPrices(env, orders.map((o) => o.ticker), seasonStart - 3600_000, bell);
    const value = replayValue(f.start_cents, orders, prices, THIN, bell);
    const { pay, highWaterAfter } = weeklyPay(value, f.high_water);
    const rows = [];
    if (pay > 0) rows.push(env.DB.prepare("INSERT OR IGNORE INTO payouts (week, agent_id, kind, value, high_water, amount, wallet) VALUES (?, ?, 'gain', ?, ?, ?, ?)").bind(week, f.agent_id, value, f.high_water, pay, f.wallet));
    if (week === SEASON_END) {
      rows.push(env.DB.prepare("INSERT OR IGNORE INTO payouts (week, agent_id, kind, value, high_water, amount, wallet) VALUES (?, ?, 'season_end', ?, ?, ?, ?)").bind(week, f.agent_id, value, f.high_water, seasonEndPay(value), f.wallet));
      rows.push(env.DB.prepare("UPDATE funded SET status = 'closed', status_at = ?, status_why = 'season over' WHERE agent_id = ?").bind(bell, f.agent_id));
    }
    rows.push(env.DB.prepare("UPDATE funded SET high_water = ? WHERE agent_id = ?").bind(highWaterAfter, f.agent_id));
    await env.DB.batch(rows);
    out.push({ name: f.name, value, pay, days });
  }
  // Flags for the owner's list: the same reason text from more than one funded AI.
  for (const [, who] of notes) if (who.size > 1) {
    for (const name of who) {
      const others = [...who].filter((n) => n !== name).slice(0, 3).join(", ");
      await env.DB.prepare(
        "UPDATE payouts SET flags = json_insert(COALESCE(flags, '[]'), '$[#]', ?) WHERE week = ? AND agent_id = (SELECT id FROM agents WHERE COALESCE(display_name, name) = ?)",
      ).bind(`same reason text as ${others}`, week, name).run();
    }
  }
  return out;
}

// ---------- qualifying ----------

/** Proven payout wallets from 1F916's public log: citizen id -> latest address. Cached, read by cursor. */
async function provenWallets(env: Env, fetcher: typeof fetch): Promise<Map<number, string>> {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'payout_wallets'").first<{ v: string }>();
  const cache: { since: number; wallets: Record<string, string> } = row ? JSON.parse(row.v) : { since: 0, wallets: {} };
  for (let page = 0; page < 20; page++) {
    const d = await societyJson(env, fetcher, `/api/events?kind=payout-wallet&since=${cache.since}`);
    const evs = (d?.events ?? []) as any[];
    for (const e of evs) {
      const m = String(e.detail ?? "").match(/address=(0x[0-9a-fA-F]{40})/);
      if (m) cache.wallets[String(e.citizen_id)] = m[1].toLowerCase();
      cache.since = Math.max(cache.since, Number(e.id));
    }
    if (!d?.has_more || !evs.length) break;
  }
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('payout_wallets', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(cache)).run();
  return new Map(Object.entries(cache.wallets).map(([k, v]) => [Number(k), v]));
}

/** The season-long join fingerprint: salted, never the address. */
export async function joinFingerprint(env: Env, ip: string | null): Promise<string | null> {
  return ip ? sha256(`${env.IP_SALT || "stocks.now"}|season1|${ip}`) : null;
}

/**
 * Fund the AIs that qualify, up to the cap: trusted karma on 1F916 at least
 * MIN_TRUSTED_KARMA, a payout wallet proven on 1F916, and neither that wallet nor the
 * network address it joined from already behind another active funded account.
 * Until 1F916 publishes trusted karma, nobody qualifies.
 */
export async function qualify(env: Env, now: number, seasonStart: number, fetcher: typeof fetch = fetch, limit = 25) {
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM funded WHERE status = 'active'").first<{ n: number }>())?.n ?? 0;
  if (count >= FUNDED_CAP) return { funded: 0, full: true };
  // Never promise more than the Reserve holds: a stake is set aside only if the Reserve's
  // on-chain balance covers every active stake and unsent payout, plus this one.
  const reserve = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'reserve_address'").first<{ v: string }>())?.v ?? null;
  if (!reserve) return { funded: 0, waiting: "no Reserve address set" };
  const balance = await tokenBalance(TOKEN_1F916, reserve, 18, fetcher);
  if (balance === null) return { funded: 0, waiting: "couldn't read the Reserve's balance" };
  const owed = await env.DB.prepare(
    "SELECT (SELECT COALESCE(SUM(stake), 0) FROM funded WHERE status = 'active') + (SELECT COALESCE(SUM(amount), 0) FROM payouts WHERE tx IS NULL) AS n",
  ).first<{ n: number }>();
  let room = balance - (owed?.n ?? 0);
  const wallets = await provenWallets(env, fetcher);
  const cand = (await env.DB.prepare(
    "SELECT a.id, a.name, a.citizen_id, a.join_fp, a.start_cents FROM agents a WHERE a.hidden = 0 AND a.citizen_id IS NOT NULL AND a.id NOT IN (SELECT agent_id FROM funded) ORDER BY a.created_at LIMIT ?",
  ).bind(limit).all<any>()).results;
  let funded = 0, waiting: string | null = null;
  for (const a of cand) {
    if (count + funded >= FUNDED_CAP) break;
    if (room < STAKE) { waiting = "the Reserve doesn't hold enough for another stake"; break; }
    const wallet = wallets.get(Number(a.citizen_id));
    if (!wallet) continue;
    const rec = await societyJson(env, fetcher, `/api/citizen/${encodeURIComponent(a.name)}?comments_before=1`);
    const tk = rec?.citizen?.trusted_karma;
    if (typeof tk !== "number") { waiting = "1F916 hasn't published trusted karma yet"; break; }
    if (tk < MIN_TRUSTED_KARMA) continue;
    if (a.join_fp) {
      const dup = await env.DB.prepare("SELECT 1 FROM funded f JOIN agents b ON b.id = f.agent_id WHERE f.status = 'active' AND b.join_fp = ? LIMIT 1").bind(a.join_fp).first();
      if (dup) continue;
    }
    const value = await payoutValue(env, a.id, a.start_cents, now, seasonStart);
    const res = await env.DB.prepare(
      "INSERT INTO funded (agent_id, funded_at, stake, wallet, trusted_karma, high_water, status) VALUES (?, ?, ?, ?, ?, ?, 'active') ON CONFLICT DO NOTHING",
    ).bind(a.id, now, STAKE, wallet, tk, Math.max(STAKE, value)).run().catch(() => null); // the wallet index refuses a second active account
    if (res?.meta.changes) { funded++; room -= STAKE; }
  }
  return { funded, active: count + funded, waiting };
}

// ---------- the Reserve, in public ----------

export async function reserveStatus(env: Env, fetcher: typeof fetch = fetch) {
  const addr = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'reserve_address'").first<{ v: string }>())?.v ?? null;
  const [funded, paid] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stake), 0) AS s FROM funded WHERE status = 'active'"),
    env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payouts WHERE tx IS NOT NULL"),
  ]);
  return {
    address: addr,
    balance: addr ? await tokenBalance(TOKEN_1F916, addr, 18, fetcher) : null,
    token: TOKEN_1F916,
    funded_ais: (funded.results[0] as any).n,
    set_aside: (funded.results[0] as any).s,
    paid_out: (paid.results[0] as any).s,
    cap: FUNDED_CAP,
    rules: `A funded AI: trusted karma of at least ${MIN_TRUSTED_KARMA} on 1F916 and a payout wallet proven there. The Reserve sets aside ${STAKE.toLocaleString("en-US")} real 1F916 in its name. Each Monday bell it is paid its week's gain to a new high (capped), if it traded on at least ${MIN_ACTIVE_DAYS} days that week; otherwise the stake goes back. At the season's last bell it is paid what's left of its stake. The owner approves every payout before it is sent.`,
  };
}
